/**
 * MediaGatewayService: the central brain of the platform.
 *
 * Wires TwilioService, AudioRouter, and MediaSessionCoordinator together.
 * Single facade used by TwilioController and the application entry point.
 */

import { Logger } from '../../shared/Logger';
import { AppEvent } from '../../events/EventTypes';
import { eventBus } from '../../shared/EventBus';
// import { KnowlarityService } from '../knowlarity/KnowlarityService'; // ← commented out: replaced by Twilio
// import { KnowlarityStreamSession } from '../knowlarity/KnowlarityTypes'; // ← commented out
import { TelephonyProvider } from '../telephony/TelephonyProvider';
import { TwilioStreamSession } from '../twilio/TwilioTypes';
import { AudioRouter } from './AudioRouter';
import { MediaSessionCoordinator } from './MediaSessionCoordinator';

const log = Logger.root('MediaGatewayService');

export class MediaGatewayService {
  // private readonly knowlarityService: KnowlarityService; // ← commented out
  private readonly twilioService: TelephonyProvider;
  private readonly audioRouter: AudioRouter;
  private readonly coordinator: MediaSessionCoordinator;
  private readonly eventUnsubs: Array<() => void> = [];

  constructor(
    // knowlarityService: KnowlarityService, // ← commented out
    twilioService: TelephonyProvider,
    audioRouter: AudioRouter,
    coordinator: MediaSessionCoordinator,
  ) {
    // this.knowlarityService = knowlarityService; // ← commented out
    this.twilioService = twilioService;
    this.audioRouter = audioRouter;
    this.coordinator = coordinator;

    this.twilioService.registerCallbacks(
      this.handleInboundAudio.bind(this),
      this.handleStreamStarted.bind(this),
      this.handleStreamStopped.bind(this),
    );

    this.subscribeToInternalEvents();
    log.info('MediaGatewayService initialized');
  }

  // ─── Twilio Stream Callbacks ───────────────────────────────────────────────

  private handleInboundAudio(callSid: string, audioBase64: string, seqNum: number): void {
    const sessionId = this.coordinator.getSessionId(callSid);
    if (!sessionId) return;

    this.audioRouter.routeInbound(callSid, sessionId, audioBase64, seqNum).catch((err) => {
      log.error('Inbound audio routing error', err as Error, { callSid, sessionId });
    });
  }

  private handleStreamStarted(callSid: string, streamSession: TwilioStreamSession): void {
    log.info('Stream started — bootstrapping session', {
      callSid,
      streamSid: streamSession.streamSid,
      callerNumber: streamSession.callerNumber,
    });

    const callerNumber = streamSession.callerNumber || 'unknown';
    const direction: 'inbound' | 'outbound' = 'inbound';

    this.coordinator
      .onCallStarted(callSid, streamSession, callerNumber, direction)
      .catch((err) => {
        log.error('Session bootstrap failed', err as Error, { callSid });
        // this.knowlarityService.hangup(callSid); // ← commented out
        this.twilioService.hangup(callSid);
      });
  }

  private handleStreamStopped(callSid: string): void {
    log.info('Stream stopped', { callSid });
    this.coordinator.onCallEnded(callSid, 'stream-stopped').catch((err) => {
      log.error('Session teardown error', err as Error, { callSid });
    });
  }

  // ─── Internal Event Subscriptions ─────────────────────────────────────────

  private subscribeToInternalEvents(): void {
    this.eventUnsubs.push(
      eventBus.on(AppEvent.ERROR_OCCURRED, async (payload) => {
        if (!payload.recoverable) {
          log.error(`Non-recoverable error from ${payload.source}`, payload.error, {
            sessionId: payload.sessionId,
            callId: payload.callId,
          });
        }
      }),

      eventBus.on(AppEvent.INTERRUPTION_DETECTED, async (payload) => {
        log.info('Barge-in detected', {
          sessionId: payload.sessionId,
          callId: payload.callId,
        });
      }),
    );
  }

  /** Unsubscribe all internal event listeners. Call on shutdown. */
  dispose(): void {
    for (const unsub of this.eventUnsubs) unsub();
    this.eventUnsubs.length = 0;
    log.info('MediaGatewayService disposed');
  }

  // ─── External API ─────────────────────────────────────────────────────────

  async handleCallEnded(callId: string, reason: string): Promise<void> {
    await this.coordinator.onCallEnded(callId, reason);
  }

  triggerInterruption(callId: string): void {
    const sessionId = this.coordinator.getSessionId(callId);
    if (!sessionId) return;
    this.audioRouter.handleInterruption(callId, sessionId);
  }

  activeSessionCount(): number {
    return this.coordinator.activeCallCount();
  }
}
