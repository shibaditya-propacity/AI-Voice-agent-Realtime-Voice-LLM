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
import { latencyRegistry, clearVad } from '../../shared/LatencyRegistry';
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
  currentUserTranscript: string;
  outputAudioBytes: number;
  onAudioOutput: (chunk: Buffer) => void;
  /** Cleanup fn that removes all client event listeners — called in destroySession(). */
  unsubscribeClientEvents: () => void;
}

export class NovaSessionManager {
  private readonly sessions: Map<string, NovaContext> = new Map();
  private readonly sessionManager: SessionManager;
  private readonly log: Logger;

  /** Timer for periodic Bedrock connection re-warming (keep-alive). */
  private prewarmTimer: ReturnType<typeof setInterval> | null = null;

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
    this.log = Logger.root('NovaSessionManager');
  }

  /** Build the per-call Nova client config from environment settings. */
  private buildConfig(): NovaClientConfig {
    return {
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
      outputSampleRate: Env.nova.audioOutputSampleRate,
      endpointingSensitivity: Env.nova.endpointingSensitivity,
    };
  }

  /**
   * Warm the Bedrock connection at server boot so the first real call avoids the
   * cold-connection penalty. Best-effort and non-blocking; safe to fire-and-forget.
   */
  async prewarm(): Promise<void> {
    await NovaClient.prewarm(this.buildConfig());
  }

  /**
   * Warm the Bedrock connection now and keep it warm on an interval, so the first
   * call after a quiet period stays fast (AWS idle-closes HTTP/2 connections after
   * ~5 min). Re-warming is skipped while calls are active — live traffic already
   * keeps the connection alive. Pass intervalMs <= 0 to do a one-shot warm only.
   */
  startPeriodicPrewarm(intervalMs: number = Env.nova.prewarmIntervalMs): void {
    // Immediate warm at boot.
    void this.prewarm();

    if (intervalMs <= 0) return;

    this.prewarmTimer = setInterval(() => {
      // Active calls keep the connection warm on their own — no need to re-warm.
      if (this.sessions.size > 0) return;
      void this.prewarm();
    }, intervalMs);

    // Don't let the keep-alive timer hold the process open by itself.
    if (typeof this.prewarmTimer.unref === 'function') this.prewarmTimer.unref();

    this.log.info('Periodic Bedrock pre-warm started', { intervalMs });
  }

  /** Stop the periodic re-warm timer (called on shutdown). */
  stopPeriodicPrewarm(): void {
    if (this.prewarmTimer) {
      clearInterval(this.prewarmTimer);
      this.prewarmTimer = null;
      this.log.info('Periodic Bedrock pre-warm stopped');
    }
  }

  async createSession(
    sessionId: string,
    callId: string,
    onAudioOutput: (chunk: Buffer) => void,
  ): Promise<void> {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Nova session already exists for session ${sessionId}`);
    }

    const config = this.buildConfig();

    const log = Logger.forSession(sessionId, callId, 'NovaSessionManager');
    log.info('Creating Nova session', {
      modelId: config.modelId,
      region: config.region,
      voiceId: config.voiceId,
      sampleRate: config.sampleRate,
      endpointingSensitivity: config.endpointingSensitivity,
    });

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
          currentUserTranscript: '',
          outputAudioBytes: 0,
          onAudioOutput,
          unsubscribeClientEvents: () => { /* populated below */ },
        };

        ctx.unsubscribeClientEvents = this.wireClientEvents(ctx);

        // Correct event order for Nova Sonic v2 bidirectional stream:
        //
        //   1. initialize() — queues sessionStart (MUST be first, includes
        //      turnDetectionConfiguration for Nova 2)
        //
        //   2. startConversation() — queues the single long-lived prompt:
        //        promptStart + SYSTEM text + USER text greeting cue
        //        + contentStart(AUDIO, interactive:true)   [audio block left open]
        //      The greeting cue's contentEnd makes the agent speak first (Nova does
        //      not greet on its own). The interactive audio block then stays open for
        //      the whole call so Nova's VAD detects each caller turn and responds.
        //
        //   3. connect() — calls bedrockClient.send(); the input generator yields
        //      the queued events so Nova can start the greeting immediately, then
        //      streams caller audioInput as it arrives. The prompt is closed only
        //      at call teardown (finishConversation → contentEnd + promptEnd).
        log.info('Queueing sessionStart + conversation prompt before connect()', {
          sessionId,
          callId,
          modelId: config.modelId,
        });

        client.initialize();
        streamer.startConversation();
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

    // The conversation prompt (system + greeting cue + open audio block) was queued
    // before connect(). Nova is generating the opening greeting and is already
    // listening on the open audio block — caller audio pushed via pushAudio() flows
    // straight in, and Nova's VAD drives every subsequent turn.
    const ctx = this.sessions.get(sessionId);
    if (ctx) {
      ctx.info.state = 'prompt-active';
      ctx.info.currentPromptName = ctx.streamer.promptName;
      log.info('Nova session ready — greeting in flight, listening on open audio block', {
        promptName: ctx.streamer.promptName,
      });
    }
  }

  pushAudio(sessionId: string, pcm16: Buffer): void {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) return;
    ctx.info.lastEventAt = Date.now();
    ctx.streamer.pushAudio(pcm16);
  }

  /** Close the conversation prompt (called at call teardown). */
  endUserTurn(sessionId: string): void {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) return;
    ctx.streamer.finishConversation();
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
    latencyRegistry.clear(sessionId);
    clearVad(sessionId);

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

    // 'completion-start' fires when Nova begins generating a response turn.
    // This is the start of the response-latency clock (caller-stop happened earlier).
    const onCompletionStart = (): void => {
      latencyRegistry.startTurn(sessionId);
    };

    // 'content-start' fires when Nova begins an AUDIO or TEXT output block
    const onContentStart = (_contentId: string, type: 'AUDIO' | 'TEXT'): void => {
      if (type === 'AUDIO') {
        ctx.info.state = 'receiving-response';
        ctx.currentAssistantTranscript = '';
        ctx.outputAudioBytes = 0;
        log.info('✅ Nova audio response started — audio is flowing to caller', { contentId: _contentId });
        eventBus.emit(AppEvent.NOVA_RESPONSE_STARTED, {
          sessionId, callId, timestamp: Date.now(),
        });
      }
    };

    const onAudioOutput = (chunk: Buffer, _contentId: string): void => {
      ctx.info.lastEventAt = Date.now();
      ctx.outputAudioBytes += chunk.length;

      if (ctx.outputAudioBytes === chunk.length) {
        // First audio chunk for this response (Nova model time-to-first-audio)
        latencyRegistry.mark(sessionId, 'firstNovaAudio');
        log.info('✅ First audio chunk routed to caller', {
          chunkBytes: chunk.length,
          contentId: _contentId,
        });
      }

      ctx.onAudioOutput(chunk);

      eventBus.emit(AppEvent.AUDIO_SENT, {
        sessionId,
        callId,
        timestamp: Date.now(),
        bytesSent: chunk.length,
        destination: 'twilio',
      });
    };

    // 'text-output' carries either the caller's ASR transcript (role USER) or the
    // agent's spoken reply (role ASSISTANT). Route each to the correct speaker so the
    // transcript isn't all mislabeled as 'assistant'.
    const onTextOutput = (text: string, _contentId: string, role: string): void => {
      ctx.info.lastEventAt = Date.now();
      if (role === 'USER') {
        latencyRegistry.mark(sessionId, 'firstUserText');
        ctx.currentUserTranscript += text;
        this.sessionManager.addTranscriptEntry(sessionId, 'user', ctx.currentUserTranscript, false);
      } else {
        latencyRegistry.mark(sessionId, 'firstAssistantText');
        ctx.currentAssistantTranscript += text;
        this.sessionManager.addTranscriptEntry(sessionId, 'assistant', ctx.currentAssistantTranscript, false);
      }
    };

    // 'content-end' signals the end of a content block — finalize whichever transcript
    // was being accumulated.
    const onContentEnd = (_contentId: string, _stopReason: string): void => {
      if (ctx.currentUserTranscript) {
        this.sessionManager.addTranscriptEntry(sessionId, 'user', ctx.currentUserTranscript, true);
        ctx.currentUserTranscript = '';
      }
      if (ctx.currentAssistantTranscript) {
        this.sessionManager.addTranscriptEntry(sessionId, 'assistant', ctx.currentAssistantTranscript, true);
        ctx.currentAssistantTranscript = '';
      }
    };

    const onTurnComplete = (stopReason: string): void => {
      ctx.info.turnCount += 1;
      const isGreetingTurn = ctx.info.turnCount === 1;
      log.info(
        isGreetingTurn
          ? '✅ Nova greeting complete — opening ears to the caller now'
          : '✅ Nova response complete — still listening on open audio block',
        { stopReason, turnCount: ctx.info.turnCount },
      );

      // The greeting is done playing → start feeding caller audio to Nova. Before
      // this, inbound audio was dropped so an overlapping "hello" couldn't trigger a
      // repeat greeting.
      if (isGreetingTurn) {
        ctx.streamer.startListening('greeting-complete');
      }

      this.sessionManager.incrementTurn(sessionId);

      eventBus.emit(AppEvent.NOVA_RESPONSE_COMPLETED, {
        sessionId, callId, timestamp: Date.now(),
      });

      // Do NOT open a new prompt/turn here. The single interactive audio block stays
      // open for the whole call; Nova's VAD detects the next caller utterance and
      // emits a fresh completion on the same block. The prompt is closed only at
      // teardown via finishConversation().
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
    client.on('completion-start', onCompletionStart);
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
      client.off('completion-start', onCompletionStart);
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
