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
import { callTrace } from '../../shared/CallTraceLogger';
import { eventBus } from '../../shared/EventBus';
import { Logger } from '../../shared/Logger';
import { latencyRegistry, clearVad } from '../../shared/LatencyRegistry';
import { withRetry } from '../../utils/helpers';
import { loadGreetingWav } from '../audio/WavLoader';
import { SessionManager } from '../session/SessionManager';
import { NovaClient } from './NovaClient';
import { NovaAudioStreamer } from './NovaAudioStreamer';
import { ConversationState, NovaClientConfig, NovaSessionInfo, NovaSessionState } from './NovaTypes';

/**
 * Nova emits a JSON control token (e.g. `{"interrupted":true}`) as a `textOutput`
 * when its own generation was barged-in. It is NOT spoken text — it must never enter
 * the transcript history (the LLM context that feeds back) or be surfaced as output.
 * Detect it strictly: a JSON object carrying a known control key, not prose.
 */
function isNovaControlToken(text: string): boolean {
  const t = text.trim();
  if (t.length < 2 || t[0] !== '{' || t[t.length - 1] !== '}') return false;
  try {
    const obj = JSON.parse(t) as Record<string, unknown>;
    return (
      !!obj && typeof obj === 'object' && !Array.isArray(obj) &&
      ('interrupted' in obj || 'stopReason' in obj || 'error' in obj)
    );
  } catch {
    return false;
  }
}

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
  /**
   * Set when barge-in fires, cleared when the new response's final user transcript
   * arrives (or on turn-complete as safety). While true, interim (non-final) user
   * transcripts are suppressed — only the final, stabilized user utterance is stored.
   * This prevents partial/overlapping speech fragments captured during the interruption
   * overlap period from polluting the transcript history.
   */
  bargeInPending: boolean;
  /**
   * True after the silence re-engagement prompt has fired. Prevents the timer
   * from looping (turn-complete after the re-engagement response would start
   * another timer → another prompt → loop). Reset when the caller actually
   * speaks (USER text arrives or completionStart from real caller speech).
   */
  silencePromptFired: boolean;
  /**
   * Epoch-ms of the most recent user speech signal: updated when Nova emits
   * USER text-output (interim/final transcript) or when a final user content
   * block ends. The silence timer callback checks this timestamp as a last-resort
   * guard — if user speech was detected within the timeout window, the prompt is
   * suppressed even if the timer fires (race-condition safety net).
   */
  lastUserSpeechAt: number;
  /**
   * Watchdog timer started when the AUDIO content block ends. If Nova's
   * `completionEnd` doesn't arrive within 5s, forces a synthetic turn-complete
   * so the state machine recovers from AI_SPEAKING → LISTENING and the silence
   * re-engagement timer can start. Without this, a missing completionEnd leaves
   * the call permanently stuck at AI_SPEAKING with no recovery.
   */
  turnCompleteWatchdog: ReturnType<typeof setTimeout> | null;
  /**
   * Deferred promotion of a caller transcript captured during an interruption. Holds
   * the text + timer until we know whether Nova handled the barge-in natively (emits
   * a {"interrupted":true} control token or a fresh completionStart → cancel this) or
   * ignored it (timer fires → promote). Guarantees exactly one response per utterance.
   */
  pendingPromotion: { text: string; timer: ReturnType<typeof setTimeout> } | null;
  /**
   * The generation for which turn-complete logic was last executed. Prevents
   * double-processing when audio content-end emits an immediate turn-complete
   * and completionEnd later emits another one for the same generation.
   */
  lastTurnCompleteGeneration: number;
  /**
   * True after turn-complete transitions to LISTENING and no user speech has
   * occurred yet. While true, new AUDIO content-starts are rejected and
   * ASSISTANT text is discarded — this prevents Nova's continuation blocks
   * from creating AI_SPEAKING → LISTENING → AI_SPEAKING without user speech
   * (the "assistant self-followup" bug).
   *
   * Cleared when user speech is detected: USER text-output, completionStart,
   * or proactive barge-in (handleInterruption).
   */
  awaitingUserSpeech: boolean;
  /**
   * The last finalized USER transcript text. Retained for diagnostics/logging of
   * the most recent caller utterance. Cleared on completionStart.
   */
  lastFinalizedUserText: string;
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
          // The static WAV greeting plays instantly on connect; Nova's first response
          // (triggered by the USER text cue) overlaps with or follows it. Setting
          // primedGreeting true keeps isGreetingPhase() false so the first turn is
          // fully interruptible and barge-in detection works normally from the start.
          primedGreeting: true,
          bargeInPending: false,
          silencePromptFired: false,
          lastUserSpeechAt: 0,
          turnCompleteWatchdog: null,
          pendingPromotion: null,
          lastTurnCompleteGeneration: -1,
          awaitingUserSpeech: false,
          lastFinalizedUserText: '',
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
    this.logGenerationOwner(ctx, 'proactive-interruption');

    // Cancel any pending silence re-engagement timer — the caller spoke.
    if (ctx.silenceTimer) {
      clearTimeout(ctx.silenceTimer);
      ctx.silenceTimer = null;
      log.debug('🔇 Silence timer cancelled — barge-in interruption', { sessionId });
    }
    ctx.silencePromptFired = false;
    ctx.awaitingUserSpeech = false; // caller spoke — self-followup guard off

    // ── Bump generation so ALL stale-generation filters work ──────────────────
    // In Nova's continuous-block architecture there is only ONE completionStart per
    // call. Proactive barge-in (AudioRouter RMS) does NOT trigger a new
    // completionStart, so responseGeneration was never incremented — making every
    // stale-generation filter a no-op. Fix: bump it here so stale text/content-end
    // events from the interrupted response are correctly identified and discarded.
    //
    // CRITICAL: do NOT set activeResponseGeneration here. Leaving it at the old
    // value ensures the interrupted response's turn-complete is correctly detected
    // as stale (responseGeneration !== activeResponseGeneration). The next AUDIO
    // content-start for a NEW response will set activeResponseGeneration correctly.
    ctx.responseGeneration++;
    ctx.lastTurnCompleteGeneration = -1;
    log.info('Generation bumped on proactive barge-in', {
      responseGeneration: ctx.responseGeneration,
      sessionId,
    });

    // Cancel the in-flight audio output block so stale chunks are discarded.
    if (ctx.activeContentId) {
      ctx.cancelledContentIds.add(ctx.activeContentId);
      log.warn('⚡ BARGE-IN (client-side): cancelling active content block — playback stopped', {
        cancelledContentId: ctx.activeContentId,
        interruptedAssistantPreview: ctx.currentAssistantTranscript.slice(0, 120) || '(no text yet)',
        interruptedAudioBytes: ctx.outputAudioBytes,
        turnCount: ctx.info.turnCount,
        generation: ctx.responseGeneration,
      });
      ctx.activeContentId = '';
    }

    // ── Discard partial transcripts so they never pollute conversation context ──
    if (ctx.currentAssistantTranscript) {
      log.info('Discarding partial interrupted assistant transcript', {
        length: ctx.currentAssistantTranscript.length,
        preview: ctx.currentAssistantTranscript.slice(0, 80),
        generation: ctx.responseGeneration,
      });
      ctx.currentAssistantTranscript = '';
    }
    if (ctx.currentUserTranscript) {
      log.info('Discarding partial interrupted user transcript', {
        length: ctx.currentUserTranscript.length,
        generation: ctx.responseGeneration,
      });
      ctx.currentUserTranscript = '';
    }

    // DO NOT clear contentIdToGeneration here. Old content blocks MUST retain their
    // generation mapping so the stale-generation filter in onTextOutput/onContentEnd
    // can correctly discard their events. Clearing it caused gen === undefined for
    // old blocks, bypassing the filter entirely and leaking stale transcripts.

    // Purge any interim (non-final) transcript entries from session history and gate
    // future interim user transcripts until the user's final utterance arrives.
    this.sessionManager.purgeInterimTranscripts(sessionId);
    ctx.bargeInPending = true;

    // Clear the inbound audio buffer in the streamer.
    ctx.streamer.handleInterruption();

    this.transitionState(ctx, 'INTERRUPTED', log);
    ctx.info.state = 'prompt-active';

    // ALWAYS replace the recovery watchdog. The previous watchdog (if any) was
    // started for the old generation and may fire with stale context. Clear it
    // and start a fresh one for the new generation.
    if (ctx.turnCompleteWatchdog) {
      clearTimeout(ctx.turnCompleteWatchdog);
      ctx.turnCompleteWatchdog = null;
    }
    const recoveryGeneration = ctx.responseGeneration;
    ctx.turnCompleteWatchdog = setTimeout(() => {
      ctx.turnCompleteWatchdog = null;
      if (ctx.conversationState === 'INTERRUPTED') {
        log.warn('⏰ INTERRUPTED recovery: no completionStart received — forcing LISTENING', {
          sessionId,
          callId: ctx.callId,
          generation: recoveryGeneration,
        });
        callTrace.event(ctx.callId, sessionId, 'watchdog.recovery', {
          generation: recoveryGeneration,
          recoveredState: 'INTERRUPTED',
        });
        // Directly transition instead of emitting a synthetic turn-complete.
        // After the activeResponseGeneration fix, a synthetic turn-complete would
        // be detected as stale (responseGeneration !== activeResponseGeneration)
        // and ignored, leaving the state permanently stuck at INTERRUPTED.
        this.transitionState(ctx, 'LISTENING', log);
        ctx.bargeInPending = false;
        ctx.awaitingUserSpeech = true;
        // Keep cancelledContentIds/contentIdToGeneration — they still protect
        // against late-arriving stale events from the interrupted response.
      }
    }, 5_000);
    if (typeof ctx.turnCompleteWatchdog.unref === 'function') ctx.turnCompleteWatchdog.unref();

    this.log.info('⚡ Interruption handled — state → INTERRUPTED, stale audio/text will be discarded', {
      sessionId,
      generation: ctx.responseGeneration,
    });
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

    this.log.info('📊 CALL TOKEN USAGE SUMMARY', {
      sessionId,
      callId: ctx.callId,
      inputTokens: ctx.info.inputTokens,
      outputTokens: ctx.info.outputTokens,
      totalTokens: ctx.info.inputTokens + ctx.info.outputTokens,
      turnCount: ctx.info.turnCount,
      durationMs: Date.now() - ctx.info.createdAt,
    });

    if (ctx.silenceTimer) {
      clearTimeout(ctx.silenceTimer);
      ctx.silenceTimer = null;
    }
    if (ctx.turnCompleteWatchdog) {
      clearTimeout(ctx.turnCompleteWatchdog);
      ctx.turnCompleteWatchdog = null;
    }
    if (ctx.pendingPromotion) {
      clearTimeout(ctx.pendingPromotion.timer);
      ctx.pendingPromotion = null;
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
    callTrace.setState(ctx.callId, next);
    callTrace.event(ctx.callId, ctx.sessionId, 'state.transition', { from: prev, to: next });
    log.info(`STATE TRANSITION: ${prev} → ${next}`, {
      sessionId: ctx.sessionId,
      callId: ctx.callId,
    });
  }

  /**
   * Emit a snapshot of which generation/content currently "owns" the turn. Used to
   * make interruption-recovery ownership visible in the call trace (requirement:
   * "logs showing generationId ownership during interruption recovery").
   */
  private logGenerationOwner(ctx: NovaContext, phase: string): void {
    callTrace.event(ctx.callId, ctx.sessionId, 'generation.owner', {
      phase,
      state: ctx.conversationState,
      responseGeneration: ctx.responseGeneration,
      activeResponseGeneration: ctx.activeResponseGeneration,
      activeContentId: ctx.activeContentId || null,
      cancelledCount: ctx.cancelledContentIds.size,
      pendingPromotion: ctx.pendingPromotion !== null,
    });
  }

  /**
   * Execute transcript promotion: re-inject the caller's barge-in speech as a
   * new USER text block so Nova generates a fresh response. Runs synchronously at
   * the caller's VAD-end (content-end of the interrupted utterance) — it cancels the
   * interrupted generation, recovers to LISTENING, and injects the finalized turn so
   * Nova answers immediately instead of resuming the cancelled response.
   */
  private executePromotion(ctx: NovaContext, text: string, log: Logger, reason: string): void {
    if (!ctx.streamer.isConversationOpen) return;
    const promotedAt = Date.now();
    callTrace.event(ctx.callId, ctx.sessionId, 'transcript.promoted', {
      text: text.slice(0, 160),
      generation: ctx.responseGeneration,
      recoverySource: reason,
      promotedAt,
      capturedWhileInterrupted: true,
    });
    log.info('Promoting interrupted caller transcript to a new USER turn', {
      sessionId: ctx.sessionId, preview: text.slice(0, 80), reason,
    });
    // Cancel the interrupted response's leftover audio so it can't resume.
    if (ctx.activeContentId) {
      ctx.cancelledContentIds.add(ctx.activeContentId);
      callTrace.event(ctx.callId, ctx.sessionId, 'generation.cancelled', {
        generation: ctx.responseGeneration, contentId: ctx.activeContentId, reason: 'promote-interrupted',
      });
      ctx.activeContentId = '';
    }
    ctx.currentAssistantTranscript = '';
    if (ctx.silenceTimer) {
      clearTimeout(ctx.silenceTimer);
      ctx.silenceTimer = null;
    }
    if (ctx.turnCompleteWatchdog) {
      clearTimeout(ctx.turnCompleteWatchdog);
      ctx.turnCompleteWatchdog = null;
    }
    if (ctx.conversationState !== 'LISTENING') {
      this.transitionState(ctx, 'LISTENING', log);
    }
    // The promoted turn IS caller input, so the agent's reply must be allowed
    // through. awaitingUserSpeech=false (same as the normal USER-speech path):
    // Nova streams the promoted response WITHOUT a completionStart in this
    // deployment, so leaving the self-followup guard armed would discard the
    // entire reply and the call would go silent.
    ctx.awaitingUserSpeech = false;
    ctx.bargeInPending = false;
    ctx.silencePromptFired = false;
    this.logGenerationOwner(ctx, 'promote-fire');
    ctx.streamer.promoteUserTurn(text);

    // Promotion watchdog: if completionStart doesn't arrive within 3s after
    // promotion, recover so the call can't stall silently. Tracked in
    // turnCompleteWatchdog so the next completionStart / content-start / teardown
    // clears it — no orphaned timers accumulating across interruptions.
    const promotionGeneration = ctx.responseGeneration;
    ctx.turnCompleteWatchdog = setTimeout(() => {
      ctx.turnCompleteWatchdog = null;
      if (ctx.awaitingUserSpeech && ctx.responseGeneration === promotionGeneration) {
        log.error('PROMOTION WATCHDOG: no completionStart within 3s after promotion — Nova may have stalled', {
          sessionId: ctx.sessionId,
          callId: ctx.callId,
          promotedText: text.slice(0, 80),
          promotedAt,
          responseGeneration: ctx.responseGeneration,
          activeResponseGeneration: ctx.activeResponseGeneration,
          conversationState: ctx.conversationState,
          activeContentId: ctx.activeContentId || null,
          cancelledCount: ctx.cancelledContentIds.size,
          reason,
        });
        callTrace.event(ctx.callId, ctx.sessionId, 'promotion.watchdog.stall', {
          promotedAt,
          elapsedMs: Date.now() - promotedAt,
          generation: promotionGeneration,
          state: ctx.conversationState,
        });
      }
    }, 3_000);
    if (typeof ctx.turnCompleteWatchdog.unref === 'function') ctx.turnCompleteWatchdog.unref();
  }

  /** Cancel a pending (deferred) promotion — Nova handled the barge-in natively. */
  private cancelPendingPromotion(ctx: NovaContext, reason: string): void {
    if (!ctx.pendingPromotion) return;
    clearTimeout(ctx.pendingPromotion.timer);
    ctx.pendingPromotion = null;
    callTrace.event(ctx.callId, ctx.sessionId, 'transcript.promotion.cancelled', {
      reason, generation: ctx.responseGeneration,
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

      // Nova started a fresh generation natively → it is handling the turn itself.
      // Cancel any deferred promotion so we don't add a duplicate response.
      this.cancelPendingPromotion(ctx, 'native-completion-start');

      // Cancel any pending turn-complete watchdog — new completion supersedes it.
      if (ctx.turnCompleteWatchdog) {
        clearTimeout(ctx.turnCompleteWatchdog);
        ctx.turnCompleteWatchdog = null;
      }

      // Increment generation FIRST so we can use it for stale turn-complete detection.
      ctx.responseGeneration++;
      ctx.lastTurnCompleteGeneration = -1;

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
        log.debug('🔇 Silence timer cancelled — completionStart received (caller spoke)', { sessionId, completionId });
      }
      ctx.silencePromptFired = false;
      ctx.awaitingUserSpeech = false; // caller spoke (Nova VAD) — self-followup guard off
      ctx.lastFinalizedUserText = ''; // new turn cycle — clear dedup

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
          // Purge any interim (non-final) transcript entries from session history so
          // only complete utterances remain. Gate future interim user transcripts until
          // the user's final, stabilized utterance arrives after the interruption.
          this.sessionManager.purgeInterimTranscripts(sessionId);
          ctx.bargeInPending = true;
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
      callTrace.event(callId, sessionId, 'nova.completion.start', {
        completionId,
        generation: ctx.responseGeneration,
      });
      log.info('Nova response generation started', { completionId, generation: ctx.responseGeneration });
    };

    /**
     * 'content-start' fires when Nova opens an output content block.
     * AUDIO type = agent is about to speak → transition to AI_SPEAKING and
     * track the contentId so barge-in can cancel it later.
     */
    const onContentStart = (contentId: string, type: 'AUDIO' | 'TEXT'): void => {
      // A cancelled content block must NEVER regain ownership or emit transcripts. If
      // Nova re-opens (or late-opens) a block we already cancelled on interruption,
      // ignore it entirely — it stays cancelled so its audio/text are discarded.
      if (ctx.cancelledContentIds.has(contentId)) {
        callTrace.event(callId, sessionId, 'generation.cancelled', {
          generation: ctx.responseGeneration, contentId, reason: 'content-start-after-cancel',
        });
        log.debug('🚫 content-start ignored — block already cancelled', { contentId, type });
        return;
      }

      // Record generation for EVERY content block (AUDIO or TEXT) so we can
      // identify stale text-output and content-end events after a barge-in.
      ctx.contentIdToGeneration.set(contentId, ctx.responseGeneration);

      if (type === 'AUDIO') {
        // ── INTERRUPTED guard: reject audio blocks from a resumed interrupted response ──
        // After a proactive barge-in, Nova may continue the interrupted response by
        // opening new AUDIO content blocks (it doesn't know we barged in). These must
        // be rejected: add to cancelledContentIds so their audio chunks are discarded,
        // and do NOT transition to AI_SPEAKING (which would let them play).
        if (ctx.conversationState === 'INTERRUPTED') {
          ctx.cancelledContentIds.add(contentId);
          callTrace.event(callId, sessionId, 'generation.cancelled', {
            generation: ctx.responseGeneration, contentId,
            reason: 'audio-content-start-while-interrupted',
          });
          log.warn('🚫 AUDIO content-start REJECTED — conversation is INTERRUPTED (resumed response blocked)', {
            contentId, generation: ctx.responseGeneration,
          });
          return;
        }

        // ── Self-followup guard: reject AUDIO after turn-complete with no user speech ──
        // In Nova's continuous-block architecture, after a turn-complete fires and
        // transitions to LISTENING, Nova may send MORE content blocks from the same
        // completion (continuation or repetition). Without this guard, each one
        // creates a new AI_SPEAKING → LISTENING cycle — the "assistant self-followup".
        if (ctx.awaitingUserSpeech) {
          ctx.cancelledContentIds.add(contentId);
          callTrace.event(callId, sessionId, 'generation.cancelled', {
            generation: ctx.responseGeneration, contentId,
            reason: 'self-followup-no-user-speech',
          });
          log.warn('🚫 AUDIO content-start REJECTED — no user speech since last turn-complete (self-followup blocked)', {
            contentId, generation: ctx.responseGeneration,
          });
          return;
        }

        // ── Cancel settling timer — continuation block arriving ──────────────
        // The settling timer delays turn-complete after audio content-end so
        // multi-block responses can play fully. If a new AUDIO block arrives
        // within the settling window, cancel the timer and keep playing.
        if (ctx.turnCompleteWatchdog) {
          clearTimeout(ctx.turnCompleteWatchdog);
          ctx.turnCompleteWatchdog = null;
          callTrace.event(callId, sessionId, 'turn.settle.cancelled', {
            reason: 'audio-continuation', contentId, generation: ctx.responseGeneration,
          });
          log.info('🔄 Settling timer cancelled — continuation AUDIO block arriving', {
            contentId, generation: ctx.responseGeneration,
          });
        }

        ctx.activeContentId = contentId;
        // Record which generation this audio block belongs to.
        // turn-complete is live iff responseGeneration === activeResponseGeneration.
        ctx.activeResponseGeneration = ctx.responseGeneration;
        ctx.info.state = 'receiving-response';
        ctx.currentAssistantTranscript = '';
        ctx.outputAudioBytes = 0;

        // Cancel any pending silence timer — the agent is speaking now, so the
        // silence timer should not fire. It will be restarted on the next
        // turn-complete after the agent finishes.
        if (ctx.silenceTimer) {
          clearTimeout(ctx.silenceTimer);
          ctx.silenceTimer = null;
          log.debug('🔇 Silence timer cancelled — AI_SPEAKING started', { sessionId, contentId });
          callTrace.event(callId, sessionId, 'silence.timer', {
            action: 'cancelled', reason: 'ai-speaking-started',
          });
        }

        this.transitionState(ctx, 'AI_SPEAKING', log);
        callTrace.event(callId, sessionId, 'nova.content.start.audio', {
          contentId,
          generation: ctx.responseGeneration,
        });
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
        callTrace.event(callId, sessionId, 'nova.audio.first', {
          contentId,
          chunkBytes: chunk.length,
        });
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

      // ── Cancelled content filter ──────────────────────────────────────────
      // Text from a cancelled (interrupted) content block must never enter
      // transcripts. The generation that produced it has been superseded and
      // its audio is already being discarded — its text must be too.
      if (ctx.cancelledContentIds.has(contentId)) {
        log.debug('🚫 STALE TEXT DISCARDED — content block is cancelled', {
          contentId, role, preview: text.slice(0, 60),
        });
        callTrace.event(callId, sessionId, 'transcript.discarded', {
          kind: 'text', role, reason: 'cancelled-content',
          state: ctx.conversationState, contentId,
        });
        return;
      }

      // ── Stale generation filter ───────────────────────────────────────────
      // Unchanged: a transcript whose content block belongs to a SUPERSEDED
      // generation (a real new completionStart bumped responseGeneration) is a
      // leftover partial from the interrupted turn and is dropped (incl. USER, which
      // is the half-spoken utterance the caller abandoned by barging in).
      const gen = ctx.contentIdToGeneration.get(contentId);
      if (gen !== undefined && gen < ctx.responseGeneration) {
        log.debug('🚫 STALE TEXT DISCARDED — text belongs to cancelled generation', {
          contentId, role, gen, currentGen: ctx.responseGeneration,
          preview: text.slice(0, 60),
        });
        callTrace.event(callId, sessionId, 'transcript.discarded', {
          kind: 'text', role, reason: 'stale-generation',
          gen, currentGen: ctx.responseGeneration, state: ctx.conversationState, contentId,
        });
        return;
      }
      // Skip ASSISTANT text while INTERRUPTED (leftover from the cancelled response).
      // ROOT-CAUSE FIX: do NOT discard USER text here. During the INTERRUPTED window
      // right after a barge-in, USER text-output is the caller's LIVE speech (the very
      // utterance that triggered the barge-in). Nova frequently emits this ASR before
      // the state leaves INTERRUPTED, so discarding it was exactly how valid caller
      // speech was being lost (→ later "Are you still there?").
      if (ctx.conversationState === 'INTERRUPTED' && role !== 'USER') {
        log.debug('🚫 STALE TEXT DISCARDED — INTERRUPTED (assistant leftover)', {
          contentId, role, preview: text.slice(0, 60),
        });
        callTrace.event(callId, sessionId, 'transcript.discarded', {
          kind: 'text', role, reason: 'interrupted-assistant',
          state: ctx.conversationState, generation: ctx.responseGeneration, contentId,
        });
        return;
      }

      if (role === 'USER') {
        latencyRegistry.mark(sessionId, 'firstUserText');
        ctx.lastUserSpeechAt = Date.now();
        ctx.awaitingUserSpeech = false; // caller spoke — self-followup guard off
        // Cancel any pending silence re-engagement timer — the caller is speaking.
        if (ctx.silenceTimer) {
          clearTimeout(ctx.silenceTimer);
          ctx.silenceTimer = null;
          log.debug('🔇 Silence timer cancelled — user speech detected (text-output)', { sessionId });
          callTrace.event(callId, sessionId, 'silence.timer', { action: 'cancelled', reason: 'user-text-output' });
        }
        // Reset the anti-loop guard — real caller speech resets the silence cycle.
        ctx.silencePromptFired = false;
        ctx.currentUserTranscript += text;
        callTrace.event(callId, sessionId, 'transcript.partial', {
          role: 'USER', state: ctx.conversationState, generation: ctx.responseGeneration,
          bargeInPending: ctx.bargeInPending, preview: ctx.currentUserTranscript.slice(0, 80),
        });
        // During barge-in recovery, suppress interim user transcripts — only the final
        // stabilized utterance (stored by onContentEnd) will enter transcript history.
        // This prevents partial/overlapping speech fragments from the interruption
        // period from polluting the session context.
        if (!ctx.bargeInPending) {
          this.sessionManager.addTranscriptEntry(sessionId, 'user', ctx.currentUserTranscript, false);
        }
      } else {
        // ── Self-followup guard: discard assistant text after turn-complete ──
        // If no user speech has occurred since the last turn-complete, this is
        // assistant continuation/repetition (Nova generating more text from the
        // same completion without new user input). Discard it.
        if (ctx.awaitingUserSpeech) {
          log.debug('🚫 ASSISTANT TEXT DISCARDED — no user speech since turn-complete (self-followup)', {
            contentId, preview: text.slice(0, 60),
          });
          callTrace.event(callId, sessionId, 'transcript.discarded', {
            kind: 'text', role, reason: 'self-followup',
            state: ctx.conversationState, generation: ctx.responseGeneration, contentId,
          });
          return;
        }
        ctx.currentAssistantTranscript += text;
        // Control-token guard: Nova's barge-in marker ({"interrupted":true}) arrives
        // as assistant text. Never surface it. Suppress the interim entry while the
        // text looks like a (forming) JSON control token — the final decision is made
        // in onContentEnd. Real spoken responses never start with '{'.
        if (ctx.currentAssistantTranscript.trimStart().startsWith('{')) {
          return;
        }
        latencyRegistry.mark(sessionId, 'firstAssistantText');
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
      // ── Cancelled content filter ──────────────────────────────────────────
      // A cancelled content block must never finalize transcripts or regain
      // ownership. Its audio is already being discarded; its text must be too.
      if (ctx.cancelledContentIds.has(contentId)) {
        log.debug('🚫 CANCELLED CONTENT-END IGNORED', { contentId });
        ctx.contentIdToGeneration.delete(contentId);
        return;
      }

      // ── Stale generation filter (unchanged) ───────────────────────────────
      const gen = ctx.contentIdToGeneration.get(contentId);
      if (gen !== undefined && gen < ctx.responseGeneration) {
        log.debug('🚫 STALE CONTENT-END IGNORED — belongs to cancelled generation', {
          contentId, gen, currentGen: ctx.responseGeneration,
        });
        callTrace.event(callId, sessionId, 'transcript.discarded', {
          kind: 'content-end', reason: 'stale-generation',
          gen, currentGen: ctx.responseGeneration, state: ctx.conversationState, contentId,
        });
        ctx.contentIdToGeneration.delete(contentId);
        return;
      }
      // ROOT-CAUSE FIX: only skip the INTERRUPTED early-return when there's NO pending
      // USER transcript. A pending USER transcript here is the caller's live
      // (barge-in) speech — fall through and finalize it below instead of dropping it.
      if (ctx.conversationState === 'INTERRUPTED' && !ctx.currentUserTranscript) {
        log.debug('🚫 STALE CONTENT-END IGNORED — conversation is INTERRUPTED', { contentId });
        callTrace.event(callId, sessionId, 'transcript.discarded', {
          kind: 'content-end', reason: 'interrupted',
          state: ctx.conversationState, generation: ctx.responseGeneration, contentId,
        });
        ctx.contentIdToGeneration.delete(contentId);
        return;
      }

      const interrupted = ctx.conversationState === 'INTERRUPTED';
      ctx.contentIdToGeneration.delete(contentId);

      if (ctx.currentUserTranscript) {
        const finalUserText = ctx.currentUserTranscript;
        ctx.lastUserSpeechAt = Date.now();
        // Cancel any pending silence timer — valid final user transcript received.
        if (ctx.silenceTimer) {
          clearTimeout(ctx.silenceTimer);
          ctx.silenceTimer = null;
          log.debug('🔇 Silence timer cancelled — final user transcript received', { sessionId });
          callTrace.event(callId, sessionId, 'silence.timer', { action: 'cancelled', reason: 'user-final-transcript' });
        }
        ctx.silencePromptFired = false;
        callTrace.event(callId, sessionId, 'transcript.user', {
          text: finalUserText.slice(0, 200),
          state: ctx.conversationState, generation: ctx.responseGeneration,
          capturedWhileInterrupted: interrupted,
        });
        this.sessionManager.addTranscriptEntry(sessionId, 'user', finalUserText, true);
        ctx.currentUserTranscript = '';
        // Only clear bargeInPending when NOT interrupted. During an interruption, multiple
        // user speech fragments may arrive as separate content blocks ("हाँ, मैं" then "भी").
        // Keeping bargeInPending=true suppresses interim transcripts from subsequent fragments
        // so they don't pollute session history. Cleared by turn-complete or promotion fire.
        if (!interrupted) {
          ctx.bargeInPending = false;
        }

        // ── Promote interrupted transcript into a new turn ─────────────────────
        // A final transcript finalized while INTERRUPTED is otherwise never answered —
        // Nova resumes its prior (non-incrementing gen) response and ignores the
        // caller's words. Promote it immediately (no dedup, no defer) to an explicit
        // USER turn so Nova responds to what the caller actually said; cancel the
        // interrupted response and recover to LISTENING so the old response is not
        // treated as the live turn. Bypasses dedup entirely — interrupted speech is
        // never suppressed by duplicate detection.
        if (interrupted && Env.nova.promoteInterruptedTranscript) {
          this.executePromotion(ctx, finalUserText, log, 'interrupted-vad-end');
        }
        ctx.lastFinalizedUserText = finalUserText;
      }
      if (ctx.currentAssistantTranscript) {
        // Control-token guard: Nova's barge-in marker ({"interrupted":true}) is not
        // speech — never finalize it into history/output. Treat it as a native
        // barge-in signal: cancel the active response's pending audio.
        if (isNovaControlToken(ctx.currentAssistantTranscript)) {
          callTrace.event(callId, sessionId, 'transcript.discarded', {
            kind: 'content-end', role: 'assistant', reason: 'control-token',
            state: ctx.conversationState, generation: ctx.responseGeneration, contentId,
            preview: ctx.currentAssistantTranscript.slice(0, 60),
          });
          if (ctx.activeContentId) {
            ctx.cancelledContentIds.add(ctx.activeContentId);
            callTrace.event(callId, sessionId, 'generation.cancelled', {
              generation: ctx.responseGeneration, contentId: ctx.activeContentId,
              reason: 'nova-control-token',
            });
          }
          // Nova signalled a native barge-in → it will produce its own response.
          // Cancel any deferred promotion so we don't double-respond.
          this.cancelPendingPromotion(ctx, 'nova-control-token');
          this.logGenerationOwner(ctx, 'nova-control-token');
          ctx.currentAssistantTranscript = '';
        }
        // Still discard assistant leftovers if this content-end arrived during an
        // interruption (the response was cancelled); only finalize live assistant text.
        else if (interrupted) {
          log.debug('🚫 Assistant transcript discarded on content-end — INTERRUPTED', {
            contentId, length: ctx.currentAssistantTranscript.length,
          });
          callTrace.event(callId, sessionId, 'transcript.discarded', {
            kind: 'content-end', role: 'assistant', reason: 'interrupted-assistant',
            state: ctx.conversationState, generation: ctx.responseGeneration, contentId,
          });
          ctx.currentAssistantTranscript = '';
        } else if (ctx.awaitingUserSpeech) {
          // Self-followup guard: discard assistant text finalized after turn-complete
          // with no intervening user speech. This is a continuation/repetition from
          // Nova's same completion, not a response to new user input.
          log.debug('🚫 Assistant transcript discarded on content-end — self-followup (no user speech)', {
            contentId, length: ctx.currentAssistantTranscript.length,
            preview: ctx.currentAssistantTranscript.slice(0, 80),
          });
          callTrace.event(callId, sessionId, 'transcript.discarded', {
            kind: 'content-end', role: 'assistant', reason: 'self-followup',
            state: ctx.conversationState, generation: ctx.responseGeneration, contentId,
          });
          ctx.currentAssistantTranscript = '';
        } else {
          callTrace.event(callId, sessionId, 'transcript.assistant', {
            text: ctx.currentAssistantTranscript.slice(0, 200),
          });
          this.sessionManager.addTranscriptEntry(sessionId, 'assistant', ctx.currentAssistantTranscript, true);
          ctx.currentAssistantTranscript = '';
        }
      }

      // ── Audio content-end: settling timer → turn-complete ─────────────────
      // In Nova's continuous-block architecture, a single response may span
      // multiple AUDIO content blocks (e.g., Nova splits a long answer into two
      // text+audio pairs). Firing turn-complete IMMEDIATELY on the first audio
      // content-end causes AI_SPEAKING → LISTENING → AI_SPEAKING ping-pong when
      // the continuation block arrives — the "assistant self-followup" bug.
      //
      // Fix: start a SHORT settling timer (500ms). If a continuation AUDIO
      // content-start arrives within the window, onContentStart cancels the timer
      // and the response plays uninterrupted. If nothing arrives, the settling
      // timer fires turn-complete (state → LISTENING, silence timer starts).
      // A 15s backstop watchdog catches genuinely stuck turns.
      if (contentId === ctx.activeContentId && ctx.conversationState === 'AI_SPEAKING') {
        callTrace.event(callId, sessionId, 'nova.content.end.audio', { contentId });
        if (ctx.turnCompleteWatchdog) clearTimeout(ctx.turnCompleteWatchdog);
        const settleGeneration = ctx.responseGeneration;
        ctx.turnCompleteWatchdog = setTimeout(() => {
          ctx.turnCompleteWatchdog = null;
          // Only fire if still AI_SPEAKING with no new active audio block.
          if (ctx.conversationState === 'AI_SPEAKING') {
            callTrace.event(callId, sessionId, 'turn.settle.fired', {
              generation: settleGeneration, reason: 'no-continuation',
            });
            log.info('🔔 Settling timer fired — no continuation AUDIO block, completing turn', {
              sessionId, generation: settleGeneration,
            });
            client.emit('turn-complete', 'AUDIO_SETTLE');
          }
          // Start 15s backstop for genuinely stuck turns.
          ctx.turnCompleteWatchdog = setTimeout(() => {
            ctx.turnCompleteWatchdog = null;
            if (ctx.pendingPromotion) {
              callTrace.event(callId, sessionId, 'watchdog.skipped', {
                reason: 'promotion-pending', generation: ctx.responseGeneration,
              });
              return;
            }
            if (ctx.conversationState === 'AI_SPEAKING' || ctx.conversationState === 'INTERRUPTED') {
              log.warn('⏰ WATCHDOG: forcing turn-complete — genuinely stuck', {
                sessionId, callId,
                conversationState: ctx.conversationState,
                generation: ctx.responseGeneration,
                activeResponseGeneration: ctx.activeResponseGeneration,
              });
              callTrace.event(callId, sessionId, 'watchdog.turn-complete', {
                generation: ctx.responseGeneration,
                recoveredState: ctx.conversationState,
              });
              client.emit('turn-complete', 'WATCHDOG_TIMEOUT');
            }
          }, 15_000);
          if (typeof ctx.turnCompleteWatchdog!.unref === 'function') ctx.turnCompleteWatchdog!.unref();
        }, 500);
        if (typeof ctx.turnCompleteWatchdog.unref === 'function') ctx.turnCompleteWatchdog.unref();
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
      // Cancel watchdog — completionEnd arrived (or watchdog itself fired).
      if (ctx.turnCompleteWatchdog) {
        clearTimeout(ctx.turnCompleteWatchdog);
        ctx.turnCompleteWatchdog = null;
      }

      // Deduplicate: audio content-end fires turn-complete immediately, and
      // completionEnd may fire another one for the same generation. Process
      // only once per generation. The state check lets INTERRUPTED recovery
      // (which needs to transition away from INTERRUPTED) still process.
      if (ctx.lastTurnCompleteGeneration === ctx.activeResponseGeneration
        && ctx.conversationState === 'LISTENING') {
        log.debug('Turn-complete deduplicated — already handled for this generation', {
          stopReason, generation: ctx.responseGeneration,
        });
        ctx.cancelledContentIds.clear();
        ctx.contentIdToGeneration.clear();
        ctx.activeContentId = '';
        return;
      }
      ctx.lastTurnCompleteGeneration = ctx.activeResponseGeneration;

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

      if (isCurrentResponse) {
        // Normal completion — release protection maps and go back to listening.
        ctx.cancelledContentIds.clear();
        ctx.contentIdToGeneration.clear();
        ctx.activeContentId = '';
        this.transitionState(ctx, 'LISTENING', log);
        // Safety: ensure bargeInPending is cleared on turn-complete even if no user
        // text block arrived (e.g. barge-in with no transcribed user speech).
        ctx.bargeInPending = false;
        // Self-followup guard: block new AUDIO/ASSISTANT content until user speaks.
        ctx.awaitingUserSpeech = true;
      } else {
        // Stale turn-complete from a barge-in interrupted response.
        // A newer response is already in progress — don't override its state.
        // CRITICAL: do NOT clear cancelledContentIds/contentIdToGeneration here.
        // They still protect against late-arriving stale events from the
        // interrupted response that may arrive after this turn-complete.
        log.debug('Stale turn-complete ignored — newer response generation already started', {
          responseGeneration: ctx.responseGeneration,
          activeResponseGeneration: ctx.activeResponseGeneration,
          stopReason,
        });
      }

      callTrace.event(callId, sessionId, 'nova.turn.complete', {
        stopReason,
        turnCount: ctx.info.turnCount,
        isGreetingTurn,
        isCurrentResponse,
      });
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
      // there?". Cancelled when the caller speaks (onTextOutput/USER,
      // onContentEnd/USER, onCompletionStart, handleInterruption).
      if (isCurrentResponse && Env.nova.silenceTimeoutMs > 0 && !ctx.silencePromptFired && !ctx.pendingPromotion) {
        if (ctx.silenceTimer) {
          clearTimeout(ctx.silenceTimer);
          log.debug('🔇 Silence timer reset — replacing previous timer on turn-complete', { sessionId });
        }
        const timerStartedAt = Date.now();
        log.debug('🔇 Silence timer started', {
          sessionId,
          silenceTimeoutMs: Env.nova.silenceTimeoutMs,
          turnCount: ctx.info.turnCount,
          stopReason,
        });
        callTrace.event(callId, sessionId, 'silence.timer', {
          action: 'started', timeoutMs: Env.nova.silenceTimeoutMs,
          turnCount: ctx.info.turnCount, state: ctx.conversationState,
        });
        ctx.silenceTimer = setTimeout(() => {
          ctx.silenceTimer = null;
          const now = Date.now();
          // Guard 1: only fire if still waiting for the caller.
          if (ctx.conversationState !== 'LISTENING' || !ctx.streamer.isListening) {
            log.debug('🔇 Silence timer expired but suppressed — not in LISTENING state', {
              sessionId,
              conversationState: ctx.conversationState,
              isListening: ctx.streamer.isListening,
            });
            callTrace.event(callId, sessionId, 'silence.timer', {
              action: 'suppressed', reason: 'not-listening', state: ctx.conversationState,
            });
            return;
          }
          // Guard 2: if user speech was detected within the timeout window
          // (race condition safety net — timer survived despite speech).
          const msSinceUserSpeech = ctx.lastUserSpeechAt > 0 ? now - ctx.lastUserSpeechAt : Infinity;
          if (msSinceUserSpeech < Env.nova.silenceTimeoutMs) {
            log.info('🔇 Silence timer expired but suppressed — user spoke recently', {
              sessionId,
              msSinceUserSpeech: Math.round(msSinceUserSpeech),
              lastUserSpeechAt: ctx.lastUserSpeechAt,
            });
            callTrace.event(callId, sessionId, 'silence.timer', {
              action: 'suppressed', reason: 'recent-user-speech',
              msSinceUserSpeech: Math.round(msSinceUserSpeech),
            });
            return;
          }
          log.info('🔇 Silence timer fired — injecting re-engagement prompt', {
            sessionId,
            silenceTimeoutMs: Env.nova.silenceTimeoutMs,
            elapsedMs: now - timerStartedAt,
            lastUserSpeechAt: ctx.lastUserSpeechAt,
            msSinceUserSpeech: msSinceUserSpeech === Infinity ? 'never' : Math.round(msSinceUserSpeech),
          });
          callTrace.event(callId, sessionId, 'silence.timer', {
            action: 'fired', elapsedMs: now - timerStartedAt,
            msSinceUserSpeech: msSinceUserSpeech === Infinity ? -1 : Math.round(msSinceUserSpeech),
          });
          ctx.silencePromptFired = true;
          ctx.streamer.sendSilencePrompt(Env.nova.silencePrompt);
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
