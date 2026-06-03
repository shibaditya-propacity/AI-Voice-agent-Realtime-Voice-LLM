/**
 * NovaSessionManager: per-call Nova Sonic v2 session lifecycle.
 *
 * Each call gets one NovaClient + NovaAudioStreamer.
 * All multi-turn state is owned by NovaAudioStreamer (tracks first-turn flag,
 * current promptName, blockIndex). This manager wires events and handles
 * session creation / destruction.
 */

import { Env } from '../../config';
import { AppEvent } from '../../events/EventTypes';
import { eventBus } from '../../shared/EventBus';
import { Logger } from '../../shared/Logger';
import { withRetry } from '../../utils/helpers';
import { SessionManager } from '../session/SessionManager';
import { NovaClient } from './NovaClient';
import { NovaAudioStreamer } from './NovaAudioStreamer';
import { NovaClientConfig, NovaSessionInfo, NovaSessionState } from './NovaTypes';

interface NovaContext {
  sessionId: string;
  callId: string;
  client: NovaClient;
  streamer: NovaAudioStreamer;
  info: NovaSessionInfo;
  currentAssistantTranscript: string;
  outputAudioBytes: number;
  onAudioOutput: (chunk: Buffer) => void;
  /** Cleanup fn that removes all client event listeners — called in destroySession(). */
  unsubscribeClientEvents: () => void;
}

export class NovaSessionManager {
  private readonly sessions: Map<string, NovaContext> = new Map();
  private readonly sessionManager: SessionManager;
  private readonly log: Logger;

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
    this.log = Logger.root('NovaSessionManager');
  }

  async createSession(
    sessionId: string,
    callId: string,
    onAudioOutput: (chunk: Buffer) => void,
  ): Promise<void> {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Nova session already exists for session ${sessionId}`);
    }

    const config: NovaClientConfig = {
      modelId: Env.nova.modelId,
      region: Env.aws.region,
      accessKeyId: Env.aws.accessKeyId,
      secretAccessKey: Env.aws.secretAccessKey,
      systemPrompt: Env.nova.systemPrompt,
      maxTokens: Env.nova.maxTokens,
      temperature: Env.nova.temperature,
      topP: Env.nova.topP,
      voiceId: Env.nova.voiceId,
      sampleRate: Env.audio.internalSampleRate,
    };

    const log = Logger.forSession(sessionId, callId, 'NovaSessionManager');

    await withRetry(
      async () => {
        const client = new NovaClient(config, sessionId, callId);

        // NovaAudioStreamer constructor: (sessionId, callId, client)
        const streamer = new NovaAudioStreamer(sessionId, callId, client);

        const info: NovaSessionInfo = {
          novaSessionId: '',
          currentPromptName: '',
          state: 'session-starting' as NovaSessionState,
          createdAt: Date.now(),
          lastEventAt: Date.now(),
          inputTokens: 0,
          outputTokens: 0,
          turnCount: 0,
        };

        const ctx: NovaContext = {
          sessionId,
          callId,
          client,
          streamer,
          info,
          currentAssistantTranscript: '',
          outputAudioBytes: 0,
          onAudioOutput,
          unsubscribeClientEvents: () => { /* populated below */ },
        };

        ctx.unsubscribeClientEvents = this.wireClientEvents(ctx);

        // Correct event order for Nova Sonic bidirectional stream:
        //   1. initialize() — queues sessionStart (MUST be first)
        //   2. beginUserTurn() — queues promptStart + system block + USER audio block
        //      (The Twilio TwiML <Say> plays the greeting before the stream starts,
        //      so Nova just needs to be ready to listen when the caller responds.)
        //   3. connect() — calls bedrockClient.send(); the generator immediately yields
        //      all queued events so Nova has enough input to send its first response,
        //      which allows send() to return without deadlocking.
        client.initialize();
        streamer.beginUserTurn();
        await client.connect();

        info.state = 'session-active';
        this.sessions.set(sessionId, ctx);

        eventBus.emit(AppEvent.NOVA_CONNECTED, {
          sessionId,
          callId,
          timestamp: Date.now(),
          modelId: config.modelId,
        });

        log.info('Nova Sonic v2 session opened', { modelId: config.modelId });
      },
      {
        maxAttempts: 3,
        initialDelayMs: 500,
        maxDelayMs: 3000,
        backoffFactor: 2,
        onAttempt: (attempt, err) => {
          log.warn(`Nova Sonic open attempt ${attempt} failed`, { error: err.message });
        },
      },
    );

    // First user turn was already opened inside the retry block (before connect())
    // so the streamer is ready to receive audio immediately.
    const ctx = this.sessions.get(sessionId);
    if (ctx) {
      ctx.info.state = 'prompt-active';
      ctx.info.currentPromptName = ctx.streamer.promptName;
    }
  }

  pushAudio(sessionId: string, pcm16: Buffer): void {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) return;
    ctx.info.lastEventAt = Date.now();
    ctx.streamer.pushAudio(pcm16);
  }

  beginUserTurn(sessionId: string): void {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) return;
    ctx.streamer.beginUserTurn();
    ctx.info.state = 'prompt-active';
    ctx.info.currentPromptName = ctx.streamer.promptName;
  }

  endUserTurn(sessionId: string): void {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) return;
    ctx.streamer.endUserTurn();
  }

  handleInterruption(sessionId: string): void {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) return;
    ctx.streamer.handleInterruption();
    ctx.info.state = 'prompt-active';
    this.log.info('Interruption handled', { sessionId });
  }

  async destroySession(sessionId: string): Promise<void> {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) return;

    ctx.unsubscribeClientEvents();
    ctx.client.close();
    this.sessions.delete(sessionId);

    eventBus.emit(AppEvent.NOVA_DISCONNECTED, {
      sessionId,
      callId: ctx.callId,
      timestamp: Date.now(),
      reason: 'call-ended',
      willReconnect: false,
    });

    this.log.info('Nova session destroyed', { sessionId });
  }

  // ─── Event Wiring ──────────────────────────────────────────────────────────

  /** Wire all NovaClient events and return a cleanup function that removes them all. */
  private wireClientEvents(ctx: NovaContext): () => void {
    const { sessionId, callId, client } = ctx;
    const log = Logger.forSession(sessionId, callId, 'NovaSessionManager');

    const onSessionStarted = (novaSessionId: string): void => {
      ctx.info.novaSessionId = novaSessionId;
      ctx.info.state = 'session-active';
      eventBus.emit(AppEvent.NOVA_SESSION_STARTED, {
        sessionId, callId, timestamp: Date.now(),
      });
    };

    // 'content-start' fires when Nova begins an AUDIO or TEXT output block
    const onContentStart = (_contentId: string, type: 'AUDIO' | 'TEXT'): void => {
      if (type === 'AUDIO') {
        ctx.info.state = 'receiving-response';
        ctx.currentAssistantTranscript = '';
        ctx.outputAudioBytes = 0;
        eventBus.emit(AppEvent.NOVA_RESPONSE_STARTED, {
          sessionId, callId, timestamp: Date.now(),
        });
      }
    };

    const onAudioOutput = (chunk: Buffer, _contentId: string): void => {
      ctx.info.lastEventAt = Date.now();
      ctx.outputAudioBytes += chunk.length;
      ctx.onAudioOutput(chunk);

      eventBus.emit(AppEvent.AUDIO_SENT, {
        sessionId,
        callId,
        timestamp: Date.now(),
        bytesSent: chunk.length,
        destination: 'twilio',
      });
    };

    // 'text-output' carries the assistant's transcript (replaces 'contentBlockDelta')
    const onTextOutput = (text: string, _contentId: string): void => {
      ctx.currentAssistantTranscript += text;
      ctx.info.lastEventAt = Date.now();
      this.sessionManager.addTranscriptEntry(sessionId, 'assistant', ctx.currentAssistantTranscript, false);
    };

    // 'content-end' signals the end of a content block (replaces 'contentBlockStop')
    const onContentEnd = (_contentId: string, _stopReason: string): void => {
      if (ctx.currentAssistantTranscript) {
        this.sessionManager.addTranscriptEntry(sessionId, 'assistant', ctx.currentAssistantTranscript, true);
        ctx.currentAssistantTranscript = '';
      }
    };

    const onTurnComplete = (stopReason: string): void => {
      ctx.info.state = 'session-active';
      ctx.info.turnCount += 1;
      log.info('Nova Sonic turn complete', { stopReason, turnCount: ctx.info.turnCount });

      this.sessionManager.incrementTurn(sessionId);

      eventBus.emit(AppEvent.NOVA_RESPONSE_COMPLETED, {
        sessionId, callId, timestamp: Date.now(),
      });

      ctx.streamer.beginUserTurn();
      ctx.info.state = 'prompt-active';
      ctx.info.currentPromptName = ctx.streamer.promptName;
    };

    const onUsage = (inputTokens: number, outputTokens: number): void => {
      ctx.info.inputTokens += inputTokens;
      ctx.info.outputTokens += outputTokens;
      log.debug('Token usage', { inputTokens, outputTokens, total: ctx.info.inputTokens + ctx.info.outputTokens });
    };

    const onError = (err: Error): void => {
      log.error('Nova Sonic client error', err);
      eventBus.emit(AppEvent.ERROR_OCCURRED, {
        sessionId,
        callId,
        timestamp: Date.now(),
        error: err,
        source: 'nova',
        recoverable: false,
      });
    };

    const onClosed = (): void => {
      log.info('Nova Sonic connection closed');
      ctx.info.state = 'closed';
    };

    client.on('session-started', onSessionStarted);
    client.on('content-start', onContentStart);
    client.on('audio-output', onAudioOutput);
    client.on('text-output', onTextOutput);
    client.on('content-end', onContentEnd);
    client.on('turn-complete', onTurnComplete);
    client.on('usage', onUsage);
    client.on('error', onError);
    client.on('closed', onClosed);

    return () => {
      client.off('session-started', onSessionStarted);
      client.off('content-start', onContentStart);
      client.off('audio-output', onAudioOutput);
      client.off('text-output', onTextOutput);
      client.off('content-end', onContentEnd);
      client.off('turn-complete', onTurnComplete);
      client.off('usage', onUsage);
      client.off('error', onError);
      client.off('closed', onClosed);
    };
  }

  getSessionInfo(sessionId: string): NovaSessionInfo | undefined {
    return this.sessions.get(sessionId)?.info;
  }

  activeSessions(): string[] {
    return Array.from(this.sessions.keys());
  }
}
