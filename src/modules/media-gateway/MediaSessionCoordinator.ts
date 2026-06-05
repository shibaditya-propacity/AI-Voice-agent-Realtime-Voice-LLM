/**
 * MediaSessionCoordinator: session bootstrap and teardown coordination.
 *
 * When a Twilio stream starts for a call:
 *   1. Create an in-memory CallSession
 *   2. Initialize a Krisp processor for the session
 *   3. Open a Nova Sonic streaming session
 *   4. Wire the Nova Sonic audio output back to the caller
 *
 * When a call ends:
 *   1. End the Nova Sonic user turn
 *   2. Destroy the Nova Sonic session
 *   3. Destroy the Krisp processor
 *   4. Destroy the in-memory session
 */

import { Env } from '../../config';
import { AppEvent } from '../../events/EventTypes';
import { callTrace } from '../../shared/CallTraceLogger';
import { eventBus } from '../../shared/EventBus';
import { Logger } from '../../shared/Logger';
import { latencyRegistry } from '../../shared/LatencyRegistry';
import { nowMs } from '../../utils/helpers';
import { KrispService } from '../krisp/KrispService';
import { NovaSessionManager } from '../nova/NovaSessionManager';
import { SessionManager } from '../session/SessionManager';
// import { KnowlarityStreamSession } from '../knowlarity/KnowlarityTypes'; // ← commented out: replaced by Twilio
import { TwilioStreamSession } from '../twilio/TwilioTypes';
import { AudioRouter } from './AudioRouter';

const log = Logger.root('MediaSessionCoordinator');

export class MediaSessionCoordinator {
  private readonly sessionManager: SessionManager;
  private readonly krispService: KrispService;
  private readonly novaSessionManager: NovaSessionManager;
  private readonly audioRouter: AudioRouter;

  /** Maps callId → sessionId for reverse-lookup during audio routing. */
  private readonly callToSession: Map<string, string> = new Map();

  constructor(
    sessionManager: SessionManager,
    krispService: KrispService,
    novaSessionManager: NovaSessionManager,
    audioRouter: AudioRouter,
  ) {
    this.sessionManager = sessionManager;
    this.krispService = krispService;
    this.novaSessionManager = novaSessionManager;
    this.audioRouter = audioRouter;
  }

  // ─── Call Start ────────────────────────────────────────────────────────────

  /**
   * Bootstrap all services for a new call.
   * Called when Knowlarity sends the 'start' stream event.
   */
  async onCallStarted(
    callId: string,
    streamSession: TwilioStreamSession,
    callerNumber: string,
    direction: 'inbound' | 'outbound',
  ): Promise<string> {
    log.info('Bootstrapping call session', { callId, direction, callerNumber });

    // 1. Create in-memory session
    let session;
    try {
      session = this.sessionManager.createSession({
        callId,
        callerNumber,
        toNumber: streamSession.streamSid, // use streamSid as proxy for destination
        direction,
      });
    } catch (err) {
      log.error('Failed to create session', err as Error, { callId });
      throw err;
    }

    const { sessionId } = session;
    this.callToSession.set(callId, sessionId);
    const t0 = nowMs(); // startup-latency anchor: Twilio stream 'start' → first audio out
    latencyRegistry.markStartup(sessionId, 'streamStart', t0);
    callTrace.start(callId, sessionId, { callerNumber, direction });

    // 2. INSTANT GREETING: if the opening greeting was synthesized + cached at boot,
    //    play it to the caller RIGHT NOW (the WebSocket is already open, so the first
    //    audio reaches the caller within ~1s) and prime Nova with it as its own prior
    //    turn. This takes Nova entirely off the critical path for the first words —
    //    the cold-stream + system-prompt-prefill + greeting-generation cost (the old
    //    5–7s of dead air) now happens in the background while the caller hears the
    //    greeting. When the caller replies, Nova is already connected and listening.
    //
    //    If no greeting was cached (synthesis failed / still running), greetingOptions
    //    stays undefined and Nova speaks the greeting itself — the original behaviour,
    //    no regression.
    let greetingOptions: { greetingGateMs: number } | undefined;
    const cachedGreeting = this.novaSessionManager.getCachedGreeting();
    log.info('[GREETING] step3 — getCachedGreeting() on call start', {
      sessionId, callId,
      result: cachedGreeting ? 'HIT' : 'MISS',
      audioBytes: cachedGreeting?.audioPcm16.length ?? 0,
    });
    if (cachedGreeting) {
      const greetingDurationMs = cachedGreeting.durationMs;
      // Fire-and-forget — start the static greeting flowing to the caller NOW, in
      // parallel with the Nova connect below. Do NOT await: the point is zero dead air.
      log.info('[GREETING] step4 — calling playGreeting() (static WAV)', { sessionId, callId, greetingDurationMs });
      this.audioRouter
        .playGreeting(callId, sessionId, cachedGreeting.audioPcm16)
        .then(() => log.info('[GREETING] step5 — playGreeting() resolved', { sessionId, callId, sinceStartMs: nowMs() - t0 }))
        .catch((err) => log.error('[GREETING] step5 — playGreeting() error', err as Error, { sessionId, callId }));
      // Open the caller's mic ~300ms after the greeting audio finishes playing.
      greetingOptions = { greetingGateMs: greetingDurationMs + 300 };
      log.info('▶️  Static greeting playing — Nova session initializing in parallel', {
        sessionId, callId, greetingDurationMs,
      });
    } else {
      // No greeting WAV cached → no opening greeting. Nova still answers once the
      // caller speaks (it does not speak first). Check [GREETING] step2 at boot.
      log.warn('[GREETING] step3 MISS — no greeting WAV cached; NO opening greeting. Agent responds once the caller speaks. Put a 16-bit PCM WAV at NOVA_GREETING_WAV_PATH (see [GREETING] step2 at boot).', {
        sessionId, callId,
      });
    }

    // 3. Open Nova Sonic session (Krisp is only needed once the caller speaks — i.e.
    //    after the greeting — so initializing it before Nova just adds dead time).
    //    With a cached greeting this connect happens UNDER the greeting playback, so
    //    its latency is hidden from the caller.
    latencyRegistry.markStartup(sessionId, 'novaConnectStart');
    callTrace.event(callId, sessionId, 'nova.connect.start', {});
    try {
      await this.novaSessionManager.createSession(
        sessionId,
        callId,
        (pcm16Chunk: Buffer) => {
          // This callback fires in the Nova output handler context.
          // Route asynchronously to avoid blocking the Nova output loop.
          this.audioRouter.routeOutbound(callId, sessionId, pcm16Chunk).catch((err) =>
            log.error('Outbound audio routing error', err as Error, { sessionId, callId }),
          );
        },
        () => {
          // onInterruption: called by NovaSessionManager when a Nova-side barge-in is
          // detected (new completionStart while AI_SPEAKING). Delegates to AudioRouter
          // which clears the Twilio outbound buffer and marks content as cancelled.
          // The proactive (client-side VAD) path in AudioRouter calls handleInterruption
          // directly, so both paths converge here.
          this.audioRouter.handleInterruption(callId, sessionId);
        },
        () => {
          // onNewResponse: called at the start of every new Nova response generation.
          // Resets the AudioRouter barge-in cooldown so each new response cycle gets
          // fresh barge-in detection — prevents the 2-second cooldown from the previous
          // barge-in blocking interruption of the new response.
          this.audioRouter.resetBargeInCooldown(sessionId);
        },
        greetingOptions,
      );
      latencyRegistry.markStartup(sessionId, 'novaConnected');
      callTrace.event(callId, sessionId, 'nova.connected', {
        novaReadyMs: nowMs() - t0,
      });
      log.info('⏱  Nova session ready', {
        sessionId,
        callId,
        novaReadyMs: nowMs() - t0,
        mode: greetingOptions ? 'primed (greeting already played from cache)' : 'live-nova-greeting',
      });
    } catch (err) {
      log.error('Failed to open Nova Sonic session', err as Error, { sessionId, callId });
      // Teardown partial state
      await this.teardown(callId, sessionId, 'nova-init-failure');
      throw err;
    }

    // 3. Initialize Krisp in the BACKGROUND — do not block the greeting on it.
    //    routeInbound() passes audio through unprocessed until the processor is
    //    ready, so the only cost of a not-yet-ready processor is a few early
    //    caller frames skipping noise suppression.
    this.krispService.createProcessor(sessionId).catch((err) => {
      log.warn('Krisp initialization failed — continuing without noise suppression', {
        sessionId,
        error: (err as Error).message,
      });
    });

    // 4. Transition session to active
    this.sessionManager.transitionState(sessionId, 'active');
    this.sessionManager.patchSession(sessionId, { connectionStatus: 'connected' });

    eventBus.emit(AppEvent.CALL_STARTED, {
      sessionId,
      callId,
      timestamp: nowMs(),
      callerNumber,
      direction,
      toNumber: streamSession.streamSid,
    });

    log.info('Call session bootstrapped', { sessionId, callId });
    return sessionId;
  }

  // ─── Call End ──────────────────────────────────────────────────────────────

  /**
   * Tear down all services for an ending call.
   * Idempotent — safe to call multiple times.
   */
  async onCallEnded(callId: string, reason: string): Promise<void> {
    const sessionId = this.callToSession.get(callId);
    if (!sessionId) {
      log.warn('onCallEnded: no session found for call', { callId, reason });
      return;
    }
    await this.teardown(callId, sessionId, reason);
  }

  private async teardown(callId: string, sessionId: string, reason: string): Promise<void> {
    const startedAt = this.sessionManager.getSession(sessionId)?.startedAt ?? nowMs();
    const durationMs = nowMs() - startedAt;

    log.info('Tearing down call session', { sessionId, callId, reason, durationMs });

    this.callToSession.delete(callId);

    // 1. Signal Nova Sonic — end active user turn gracefully
    try {
      this.novaSessionManager.endUserTurn(sessionId);
      await this.novaSessionManager.destroySession(sessionId);
    } catch (err) {
      log.warn('Error destroying Nova session', { sessionId, error: (err as Error).message });
    }

    // 2. Destroy Krisp processor
    try {
      this.krispService.destroyProcessor(sessionId);
    } catch (err) {
      log.warn('Error destroying Krisp processor', { sessionId, error: (err as Error).message });
    }

    // 3. Clean up AudioRouter per-session maps (seqnum dedup, barge-in cooldown)
    this.audioRouter.cleanupSession(sessionId);

    // 4. Terminate and destroy in-memory session
    this.sessionManager.terminateSession(sessionId, reason);
    this.sessionManager.destroySession(sessionId, reason);

    callTrace.end(callId, { reason, durationMs });

    eventBus.emit(AppEvent.CALL_ENDED, {
      sessionId,
      callId,
      timestamp: nowMs(),
      reason: 'hangup',
      durationMs,
    });
  }

  // ─── Lookups ───────────────────────────────────────────────────────────────

  getSessionId(callId: string): string | undefined {
    return this.callToSession.get(callId);
  }

  activeCallCount(): number {
    return this.callToSession.size;
  }
}
