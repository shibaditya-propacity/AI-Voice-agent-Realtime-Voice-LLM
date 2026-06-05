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
import { loadGreetingWav } from '../audio/WavLoader';
import { SessionManager } from '../session/SessionManager';
import { NovaClient } from './NovaClient';
import { NovaAudioStreamer } from './NovaAudioStreamer';
import { ConversationState, NovaClientConfig, NovaSessionInfo, NovaSessionState } from './NovaTypes';

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
  /**
   * Called immediately when barge-in is detected (either proactively from
   * AudioRouter's VAD or reactively from a new completionStart while AI_SPEAKING).
   * Clears Twilio's outbound audio buffer and stops queued frames.
   */
  onInterruption: () => void;
  /**
   * Called at the start of every new response generation (completionStart).
   * Used by AudioRouter to reset the per-session barge-in cooldown so each
   * new response cycle gets fresh barge-in detection.
   */
  onNewResponse: () => void;
  /** Cleanup fn that removes all client event listeners — called in destroySession(). */
  unsubscribeClientEvents: () => void;

  // ── Conversation state machine ──────────────────────────────────────────────
  /** Explicit state for barge-in / interruption control. */
  conversationState: ConversationState;
  /**
   * contentId of the AUDIO output block that is currently playing to the caller.
   * Cleared on turn-complete or interruption.
   */
  activeContentId: string;
  /**
   * contentIds whose audio chunks must be discarded (stale from a barge-in
   * interrupted response). Cleared on the next turn-complete.
   */
  cancelledContentIds: Set<string>;
  /**
   * Epoch-ms of the last barge-in we triggered. Guards against the same
   * user utterance firing multiple interruptions within a short window.
   */
  lastBargeInAt: number;
  /**
   * Monotonically-increasing counter incremented on every 'completion-start'.
   * Used to identify which generation's turn-complete is arriving so we can
   * tell stale (old response's) turn-completes from the current one.
   */
  responseGeneration: number;
  /**
   * The value of responseGeneration that was current when the most recent
   * 'content-start(AUDIO)' fired. A turn-complete is for the active response
   * iff responseGeneration === activeResponseGeneration.
   */
  activeResponseGeneration: number;
  /**
   * Maps every output contentId (AUDIO or TEXT) to the responseGeneration it
   * was created in.  When a barge-in bumps the generation, any subsequent
   * text-output or content-end whose contentId belongs to an older generation
   * is silently discarded — this prevents partial interrupted transcripts from
   * leaking into the conversation context (the "hallucination / apology loop"
   * root cause).
   */
  contentIdToGeneration: Map<string, number>;
  /**
   * Silence re-engagement timer. Starts when the agent finishes speaking
   * (state → LISTENING). Cancelled when the caller starts speaking
   * (completionStart received). When it fires, a USER text cue is injected
   * into the open Nova prompt to trigger a "Are you still there?" response.
   */
  silenceTimer: ReturnType<typeof setTimeout> | null;
  /**
   * True when the opening greeting was played to the caller from the boot-time
   * cache and Nova was primed with it (so Nova does NOT speak a greeting). In this
   * mode the first Nova turn is the caller's real reply — NOT a greeting — so the
   * greeting-gate logic in onTurnComplete must not treat turn #1 as the greeting.
   */
  primedGreeting: boolean;
}

export class NovaSessionManager {
  private readonly sessions: Map<string, NovaContext> = new Map();
  private readonly sessionManager: SessionManager;
  private readonly log: Logger;

  /** Timer for periodic Bedrock connection re-warming (keep-alive). */
  private prewarmTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * The static opening greeting loaded ONCE at boot from a WAV (PCM16 @ Nova output
   * rate so it flows through the existing outbound pipeline) plus its duration.
   * Played to every caller the instant the call connects — Nova 2 Sonic does not
   * speak first, so this is the only opening greeting. null if no/invalid WAV.
   */
  private cachedGreeting: { audioPcm16: Buffer; durationMs: number } | null = null;

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
  startPeriodicPrewarm(
    intervalMs: number = Env.nova.prewarmIntervalMs,
    opts: { warmImmediately?: boolean } = {},
  ): void {
    // Immediate warm at boot, unless the caller already warmed the connection
    // (e.g. prepareGreeting() ran a full synthesis first) — then skip the redundant warm.
    if (opts.warmImmediately !== false) void this.prewarm();

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

  /**
   * Synthesize the opening greeting ONCE at boot and cache its audio + text so every
   * call can play it INSTANTLY (within ~1s) instead of waiting 5–7s for a cold
   * Bedrock stream + system-prompt prefill + greeting generation. Also warms the
   * connection. Best-effort and idempotent — on failure, calls fall back to the live
   * Nova greeting with no regression.
   */
  async prepareGreeting(): Promise<void> {
    if (this.cachedGreeting) return;
    const wavPath = Env.nova.greetingWavPath;
    this.log.info('[GREETING] step1 — loading static greeting WAV', { wavPath });
    try {
      // Resample to Nova's output rate so the clip flows through the SAME outbound
      // pipeline (downsample → telephony codec) that live Nova audio uses.
      const { pcm16, durationMs } = loadGreetingWav(wavPath, Env.nova.audioOutputSampleRate);
      if (pcm16.length === 0) throw new Error('decoded greeting WAV is empty');
      this.cachedGreeting = { audioPcm16: pcm16, durationMs };
      this.log.info('[GREETING] step2 — greeting CACHED from WAV — plays instantly on connect', {
        wavPath, audioBytes: pcm16.length, durationMs,
      });
    } catch (err) {
      this.log.error(
        '[GREETING] step2 FAILED — could not load greeting WAV; calls will have NO opening greeting (agent responds once the caller speaks). Put a 16-bit PCM WAV at the configured path.',
        err as Error,
        { wavPath },
      );
    }
  }

  /** The cached static greeting (PCM16 @ Nova output rate + duration), or null. */
  getCachedGreeting(): { audioPcm16: Buffer; durationMs: number } | null {
    return this.cachedGreeting;
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
    onInterruption: () => void,
    onNewResponse: () => void,
    greetingOptions?: { greetingGateMs: number },
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
          onInterruption,
          onNewResponse,
          unsubscribeClientEvents: () => { /* populated below */ },
          // Conversation state machine — starts LISTENING (greeting gate in streamer
          // prevents caller audio from being sent until the greeting turn completes).
          conversationState: 'LISTENING',
          activeContentId: '',
          cancelledContentIds: new Set(),
          lastBargeInAt: 0,
          responseGeneration: 0,
          activeResponseGeneration: 0,
          contentIdToGeneration: new Map(),
          silenceTimer: null,
          // Nova never produces the opening greeting anymore (a static WAV does), so
          // there is no Nova "greeting phase" to protect — always true. This keeps
          // isGreetingPhase() false so the caller's FIRST real turn is fully
          // interruptible and barge-in/greeting-protection logic does not misfire.
          primedGreeting: true,
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
        streamer.startConversation(greetingOptions);
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

  /**
   * Proactive barge-in: called by AudioRouter when it detects caller speech energy
   * while the agent is speaking. Marks the active content block as cancelled so
   * subsequent audio chunks from Nova are discarded. The Twilio buffer clear is
   * handled by the caller (AudioRouter.handleInterruption → twilioService.clearAudio).
   */
  handleInterruption(sessionId: string): void {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) return;

    const log = Logger.forSession(sessionId, ctx.callId, 'NovaSessionManager');

    // Cancel any pending silence re-engagement timer — the caller spoke.
    if (ctx.silenceTimer) {
      clearTimeout(ctx.silenceTimer);
      ctx.silenceTimer = null;
    }

    // Cancel the in-flight audio output block so stale chunks are discarded.
    if (ctx.activeContentId) {
      ctx.cancelledContentIds.add(ctx.activeContentId);
      log.warn('⚡ BARGE-IN (client-side): cancelling active content block — playback stopped', {
        cancelledContentId: ctx.activeContentId,
        interruptedAssistantPreview: ctx.currentAssistantTranscript.slice(0, 120) || '(no text yet)',
        interruptedAudioBytes: ctx.outputAudioBytes,
        turnCount: ctx.info.turnCount,
      });
      ctx.activeContentId = '';
    }

    // ── Discard partial transcripts so they never pollute conversation context ──
    if (ctx.currentAssistantTranscript) {
      log.info('Discarding partial interrupted assistant transcript', {
        length: ctx.currentAssistantTranscript.length,
        preview: ctx.currentAssistantTranscript.slice(0, 80),
      });
      ctx.currentAssistantTranscript = '';
    }
    if (ctx.currentUserTranscript) {
      log.info('Discarding partial interrupted user transcript', {
        length: ctx.currentUserTranscript.length,
      });
      ctx.currentUserTranscript = '';
    }

    // Clear the inbound audio buffer in the streamer.
    ctx.streamer.handleInterruption();

    this.transitionState(ctx, 'INTERRUPTED', log);
    ctx.info.state = 'prompt-active';
    this.log.info('⚡ Interruption handled — state → INTERRUPTED, stale audio/text will be discarded', { sessionId });
  }

  /** True if the agent is currently streaming audio to the caller. Used by AudioRouter for barge-in detection. */
  isAgentSpeaking(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.conversationState === 'AI_SPEAKING';
  }

  /**
   * True while Nova is speaking the opening greeting (turnCount === 0). Proactive
   * barge-in must be suppressed during this phase — early telephony line noise /
   * echo can exceed the RMS threshold and kill the greeting mid-playback before the
   * caller has actually spoken.
   *
   * Only applies to the FALLBACK (Nova-spoken) greeting. In primed mode the greeting
   * was played locally and Nova never speaks it, so turnCount === 0 spans the agent's
   * first REAL response — barge-in there must work normally, hence the primedGreeting
   * exclusion.
   */
  isGreetingPhase(sessionId: string): boolean {
    const ctx = this.sessions.get(sessionId);
    return ctx !== undefined && ctx.info.turnCount === 0 && !ctx.primedGreeting;
  }

  /** Current conversation state for a session. Used for logging and debugging. */
  getConversationState(sessionId: string): ConversationState | undefined {
    return this.sessions.get(sessionId)?.conversationState;
  }

  async destroySession(sessionId: string): Promise<void> {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) return;

    if (ctx.silenceTimer) {
      clearTimeout(ctx.silenceTimer);
      ctx.silenceTimer = null;
    }
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

  // ─── State Machine Helpers ─────────────────────────────────────────────────

  /**
   * Transition to a new conversation state, logging every change.
   * All state writes go through here so the log is always consistent.
   */
  private transitionState(ctx: NovaContext, next: ConversationState, log: Logger): void {
    const prev = ctx.conversationState;
    if (prev === next) return;
    ctx.conversationState = next;
    log.info(`STATE TRANSITION: ${prev} → ${next}`, {
      sessionId: ctx.sessionId,
      callId: ctx.callId,
    });
  }

  // ─── Client Event Wiring ───────────────────────────────────────────────────

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

    /**
     * 'completion-start' fires when Nova begins generating a new response turn.
     *
     * If we are in AI_SPEAKING when this fires it means Nova detected the caller
     * speaking and interrupted its own output (native barge-in). We must:
     *   1. Add the current contentId to cancelledContentIds so subsequent audio
     *      chunks from the old response are discarded.
     *   2. Call onInterruption() to immediately clear Twilio's audio buffer and
     *      stop any queued outbound frames.
     *   3. Transition to AI_THINKING for the incoming new response.
     *
     * A 300ms cooldown prevents the same barge-in event from being logged
     * or processed multiple times if completionStart fires repeatedly.
     */
    const onCompletionStart = (completionId: string): void => {
      latencyRegistry.startTurn(sessionId);

      // Increment generation FIRST so we can use it for stale turn-complete detection.
      ctx.responseGeneration++;

      // ── Greeting protection ───────────────────────────────────────────────
      // During the greeting phase (turnCount === 0), Nova may fire a spurious
      // second completionStart — e.g. its VAD on the empty interactive audio
      // block times out and interprets silence as an end-of-utterance. If we
      // let the barge-in block fire, it would cancel the greeting content,
      // clear Twilio's buffer, and kill the greeting mid-playback.
      //
      // Fix: skip the barge-in block entirely during the greeting. Undo the
      // generation increment so the greeting's turn-complete is still the
      // "current" response and can open the greeting gate normally.
      // Only the FALLBACK greeting (Nova-spoken) needs this protection. In primed
      // mode Nova never speaks the greeting, so turnCount === 0 covers the agent's
      // first real response, which MUST remain interruptible.
      const isGreetingPhase = ctx.info.turnCount === 0 && !ctx.primedGreeting;
      if (isGreetingPhase && ctx.conversationState === 'AI_SPEAKING' && ctx.activeContentId) {
        ctx.responseGeneration--; // undo — greeting must stay the current generation
        log.warn('⚠️ Ignoring spurious completionStart during greeting — greeting must play to completion', {
          completionId,
          generation: ctx.responseGeneration,
          activeContentId: ctx.activeContentId,
          outputAudioBytes: ctx.outputAudioBytes,
        });
        return; // greeting continues uninterrupted
      }

      // Cancel any pending silence re-engagement timer — the caller spoke.
      if (ctx.silenceTimer) {
        clearTimeout(ctx.silenceTimer);
        ctx.silenceTimer = null;
      }

      // Reset the AudioRouter barge-in cooldown for this new response cycle.
      // Without this, the 2-second cooldown from the PREVIOUS barge-in blocks
      // detection on the new response if it starts within 2 seconds — causing
      // the "agent finishes speaking before processing the user" symptom.
      ctx.onNewResponse();

      if (ctx.conversationState === 'AI_SPEAKING' && ctx.activeContentId) {
        const now = Date.now();
        if (now - ctx.lastBargeInAt > 300) {
          ctx.lastBargeInAt = now;
          ctx.cancelledContentIds.add(ctx.activeContentId);
          this.log.warn('⚡ BARGE-IN (Nova-side): new completionStart while AI was speaking — cancelling active content', {
            sessionId,
            callId,
            cancelledContentId: ctx.activeContentId,
            newCompletionId: completionId,
            generation: ctx.responseGeneration,
            interruptedAssistantPreview: ctx.currentAssistantTranscript.slice(0, 120) || '(no text yet)',
            interruptedAudioBytes: ctx.outputAudioBytes,
            turnCount: ctx.info.turnCount,
          });
          ctx.activeContentId = '';
          this.transitionState(ctx, 'INTERRUPTED', log);
          // Clear Twilio audio buffer immediately so caller hears silence, not overlap
          ctx.onInterruption();
          eventBus.emit(AppEvent.INTERRUPTION_DETECTED, {
            sessionId,
            callId,
            timestamp: now,
            confidence: 1.0,
          });
        }
      }

      // ── Discard partial transcripts from the interrupted response ──────────
      // Without this, the half-finished assistant sentence leaks into the
      // session's conversationContext.lastAssistantText, causing Nova to see
      // stale context and produce apology loops / hallucinations.
      if (ctx.currentAssistantTranscript) {
        log.info('Discarding partial interrupted assistant transcript', {
          length: ctx.currentAssistantTranscript.length,
          preview: ctx.currentAssistantTranscript.slice(0, 80),
        });
        ctx.currentAssistantTranscript = '';
      }
      if (ctx.currentUserTranscript) {
        log.info('Discarding partial interrupted user transcript', {
          length: ctx.currentUserTranscript.length,
        });
        ctx.currentUserTranscript = '';
      }

      this.transitionState(ctx, 'AI_THINKING', log);
      ctx.outputAudioBytes = 0;
      log.info('Nova response generation started', { completionId, generation: ctx.responseGeneration });
    };

    /**
     * 'content-start' fires when Nova opens an output content block.
     * AUDIO type = agent is about to speak → transition to AI_SPEAKING and
     * track the contentId so barge-in can cancel it later.
     */
    const onContentStart = (contentId: string, type: 'AUDIO' | 'TEXT'): void => {
      // Record generation for EVERY content block (AUDIO or TEXT) so we can
      // identify stale text-output and content-end events after a barge-in.
      ctx.contentIdToGeneration.set(contentId, ctx.responseGeneration);

      if (type === 'AUDIO') {
        ctx.activeContentId = contentId;
        // Record which generation this audio block belongs to.
        // turn-complete is live iff responseGeneration === activeResponseGeneration.
        ctx.activeResponseGeneration = ctx.responseGeneration;
        ctx.info.state = 'receiving-response';
        ctx.currentAssistantTranscript = '';
        ctx.outputAudioBytes = 0;
        this.transitionState(ctx, 'AI_SPEAKING', log);
        log.info('✅ Nova audio response started — audio is flowing to caller', {
          contentId,
          generation: ctx.responseGeneration,
        });
        eventBus.emit(AppEvent.NOVA_RESPONSE_STARTED, {
          sessionId, callId, timestamp: Date.now(),
        });
      }
    };

    /**
     * 'audio-output' fires for every PCM16 audio chunk Nova sends.
     *
     * Guard 1 — cancelled content: if this chunk belongs to a content block that
     * was interrupted (cancelledContentIds), discard it silently. This prevents
     * the "agent keeps talking after barge-in" overlap symptom.
     *
     * Guard 2 — wrong state: if somehow we receive audio while not in AI_SPEAKING
     * (e.g. state is INTERRUPTED after a proactive barge-in) also discard.
     */
    const onAudioOutput = (chunk: Buffer, contentId: string): void => {
      ctx.info.lastEventAt = Date.now();

      // Discard stale audio from a cancelled (barge-in interrupted) completion.
      if (ctx.cancelledContentIds.has(contentId)) {
        log.debug('🚫 STALE AUDIO DISCARDED — chunk belongs to cancelled content block', {
          contentId,
          chunkBytes: chunk.length,
        });
        return;
      }

      // Discard if we're in INTERRUPTED state (proactive barge-in already fired,
      // Nova hasn't sent new completionStart yet — discard everything in the gap).
      if (ctx.conversationState === 'INTERRUPTED') {
        log.debug('🚫 STALE AUDIO DISCARDED — conversation is INTERRUPTED', {
          contentId,
          chunkBytes: chunk.length,
        });
        return;
      }

      ctx.outputAudioBytes += chunk.length;

      if (ctx.outputAudioBytes === chunk.length) {
        // First audio chunk for this response (Nova model time-to-first-audio)
        latencyRegistry.mark(sessionId, 'firstNovaAudio');
        log.info('✅ First audio chunk routed to caller — response generation completed', {
          chunkBytes: chunk.length,
          contentId,
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

    /**
     * 'text-output' carries either the caller's ASR transcript (role USER) or
     * the agent's spoken reply (role ASSISTANT).
     *
     * Guard: discard text from a stale (barge-in interrupted) generation.
     * Without this, partial assistant text from the cancelled response leaks
     * into conversationContext.lastAssistantText, causing apology loops.
     */
    const onTextOutput = (text: string, contentId: string, role: string): void => {
      ctx.info.lastEventAt = Date.now();

      // ── Stale generation filter ───────────────────────────────────────────
      const gen = ctx.contentIdToGeneration.get(contentId);
      if (gen !== undefined && gen < ctx.responseGeneration) {
        log.debug('🚫 STALE TEXT DISCARDED — text belongs to cancelled generation', {
          contentId, role, gen, currentGen: ctx.responseGeneration,
          preview: text.slice(0, 60),
        });
        return;
      }
      // Also skip while INTERRUPTED (proactive barge-in gap before new completionStart)
      if (ctx.conversationState === 'INTERRUPTED') {
        log.debug('🚫 STALE TEXT DISCARDED — conversation is INTERRUPTED', {
          contentId, role, preview: text.slice(0, 60),
        });
        return;
      }

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

    /**
     * 'content-end' signals the end of a content block — finalize whichever
     * transcript was being accumulated.
     *
     * Guard: if this content block belongs to a stale (interrupted) generation,
     * do NOT finalize the transcript. The partial text was already discarded in
     * onCompletionStart / handleInterruption; this just prevents a late
     * content-end from resurrecting it.
     */
    const onContentEnd = (contentId: string, _stopReason: string): void => {
      // ── Stale generation filter ───────────────────────────────────────────
      const gen = ctx.contentIdToGeneration.get(contentId);
      if (gen !== undefined && gen < ctx.responseGeneration) {
        log.debug('🚫 STALE CONTENT-END IGNORED — belongs to cancelled generation', {
          contentId, gen, currentGen: ctx.responseGeneration,
        });
        ctx.contentIdToGeneration.delete(contentId);
        return;
      }
      // Also skip while INTERRUPTED
      if (ctx.conversationState === 'INTERRUPTED') {
        log.debug('🚫 STALE CONTENT-END IGNORED — conversation is INTERRUPTED', { contentId });
        ctx.contentIdToGeneration.delete(contentId);
        return;
      }

      ctx.contentIdToGeneration.delete(contentId);

      if (ctx.currentUserTranscript) {
        this.sessionManager.addTranscriptEntry(sessionId, 'user', ctx.currentUserTranscript, true);
        ctx.currentUserTranscript = '';
      }
      if (ctx.currentAssistantTranscript) {
        this.sessionManager.addTranscriptEntry(sessionId, 'assistant', ctx.currentAssistantTranscript, true);
        ctx.currentAssistantTranscript = '';
      }
    };

    /**
     * 'turn-complete' fires when Nova finishes one full response cycle.
     *
     * Guard: if a new completionStart already arrived (state is AI_THINKING or
     * AI_SPEAKING for the next response), don't reset to LISTENING — that would
     * re-open the flood gate while the agent is already speaking again.
     */
    const onTurnComplete = (stopReason: string): void => {
      ctx.info.turnCount += 1;
      // In primed mode Nova never speaks a greeting (the cached one was played
      // locally), so turn #1 is the caller's first real reply — not a greeting.
      const isGreetingTurn = !ctx.primedGreeting && ctx.info.turnCount === 1;

      // Determine if this turn-complete is for the currently active response or
      // for a previous (barge-in interrupted) response.
      //
      // responseGeneration is incremented on every completionStart.
      // activeResponseGeneration is set when the most recent content-start(AUDIO) fires.
      // They match iff no new completionStart has arrived since our last audio block,
      // which means this is the CURRENT response finishing normally.
      const isCurrentResponse = ctx.responseGeneration === ctx.activeResponseGeneration;

      // Release cancelled content IDs and generation map — the turn is fully over.
      ctx.cancelledContentIds.clear();
      ctx.contentIdToGeneration.clear();
      ctx.activeContentId = '';

      if (isCurrentResponse) {
        // Normal completion — go back to listening.
        this.transitionState(ctx, 'LISTENING', log);
      } else {
        // Stale turn-complete from a barge-in interrupted response.
        // A newer response is already in progress — don't override its state.
        log.debug('Stale turn-complete ignored — newer response generation already started', {
          responseGeneration: ctx.responseGeneration,
          activeResponseGeneration: ctx.activeResponseGeneration,
          stopReason,
        });
      }

      log.info(
        isGreetingTurn
          ? '✅ Nova greeting complete — opening ears to the caller now'
          : '✅ Nova response complete — still listening on open audio block',
        { stopReason, turnCount: ctx.info.turnCount },
      );

      // The greeting is done playing → start feeding caller audio to Nova. Before
      // this, inbound audio was dropped so an overlapping "hello" couldn't trigger a
      // repeat greeting. Open the gate on ANY turn-complete that fires while the gate
      // is still closed. startListening() is idempotent so this is safe even if
      // called from a stale turn-complete — we still know the greeting audio finished
      // and the caller should now be heard.
      if (!ctx.streamer.isListening) {
        ctx.streamer.startListening(
          isCurrentResponse ? 'greeting-complete' : 'greeting-complete-stale-turn',
        );
      }

      // ── Silence re-engagement timer ───────────────────────────────────────
      // After the agent finishes speaking normally (not a stale barge-in
      // turn-complete), start a timer. If the caller says nothing within the
      // configured window, inject a USER text cue so Nova asks "Are you still
      // there?". Cancelled in onCompletionStart when the caller speaks.
      if (isCurrentResponse && Env.nova.silenceTimeoutMs > 0) {
        if (ctx.silenceTimer) {
          clearTimeout(ctx.silenceTimer);
        }
        ctx.silenceTimer = setTimeout(() => {
          ctx.silenceTimer = null;
          // Only fire if still waiting for the caller (no new completionStart
          // arrived and the agent is not already speaking again).
          if (ctx.conversationState === 'LISTENING' && ctx.streamer.isListening) {
            log.info('🔇 Silence timeout — injecting re-engagement prompt', {
              sessionId,
              silenceTimeoutMs: Env.nova.silenceTimeoutMs,
            });
            ctx.streamer.sendSilencePrompt(Env.nova.silencePrompt);
          }
        }, Env.nova.silenceTimeoutMs);
        if (typeof ctx.silenceTimer.unref === 'function') ctx.silenceTimer.unref();
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
