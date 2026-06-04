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

import { AppEvent } from '../../events/EventTypes';
import { eventBus } from '../../shared/EventBus';
import { Logger } from '../../shared/Logger';
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

    // 2. Open Nova Sonic session FIRST so the greeting starts as fast as possible.
    //    (Krisp is only needed once the caller speaks — i.e. after the greeting —
    //    so initializing it before Nova just adds dead time to greeting latency.)
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
      );
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
