
/**
 * TwilioService: stream registry + outbound call management.
 *
 * Responsibilities:
 *   - Register WebSocket stream handlers as calls arrive
 *   - Route audio to/from active streams
 *   - Initiate outbound calls via Twilio REST API
 */

import WebSocket from 'ws';
import twilio, { Twilio } from 'twilio';
import { Env } from '../../config';
import { AppEvent } from '../../events/EventTypes';
import { eventBus } from '../../shared/EventBus';
import { Logger } from '../../shared/Logger';
import { TwilioStreamSession, TwilioOutboundCallRequest, TwilioOutboundCallResponse } from './TwilioTypes';
import {
  TwilioStreamHandler,
  OnAudioReceived,
  OnStreamStarted,
  OnStreamStopped,
} from './TwilioStreamHandler';

const log = Logger.root('TwilioService');

export class TwilioService {
  private readonly client: Twilio;

  /** callSid → handler for O(1) audio routing. */
  private readonly streams: Map<string, TwilioStreamHandler> = new Map();

  private onAudioReceived: OnAudioReceived = () => {};
  private onStreamStarted: OnStreamStarted = () => {};
  private onStreamStopped: OnStreamStopped = () => {};

  constructor() {
    this.client = twilio(Env.twilio.accountSid, Env.twilio.authToken);
  }

  // ─── Callback Registration ─────────────────────────────────────────────────

  registerCallbacks(
    onAudio: OnAudioReceived,
    onStart: OnStreamStarted,
    onStop: OnStreamStopped,
  ): void {
    this.onAudioReceived = onAudio;
    this.onStreamStarted = onStart;
    this.onStreamStopped = onStop;
  }

  // ─── WebSocket Stream Management ───────────────────────────────────────────

  /** Accept a new Twilio Media Stream WebSocket connection. */
  acceptStream(ws: WebSocket, remoteAddress: string): void {
    log.info('Accepting Twilio media stream', { remoteAddress });

    const handler = new TwilioStreamHandler(
      ws,
      (callSid, audioBase64, seq) => {
        this.onAudioReceived(callSid, audioBase64, seq);
      },
      (callSid, session) => {
        this.streams.set(callSid, handler);
        log.info('Stream registered', { callSid });

        eventBus.emit(AppEvent.KNOWLARITY_CONNECTED, {
          // Re-using KNOWLARITY_CONNECTED event key — telephony-agnostic semantics
          sessionId: 'pending',
          callId: callSid,
          timestamp: Date.now(),
          remoteAddress,
        });

        this.onStreamStarted(callSid, session);
      },
      (callSid) => {
        this.streams.delete(callSid);
        log.info('Stream deregistered', { callSid });

        eventBus.emit(AppEvent.KNOWLARITY_DISCONNECTED, {
          sessionId: 'unknown',
          callId: callSid,
          timestamp: Date.now(),
          code: 1000,
          reason: 'stream-stopped',
        });

        this.onStreamStopped(callSid);
      },
    );
  }

  // ─── Outbound Audio ───────────────────────────────────────────────────────

  /** Send base64-encoded telephony audio to the caller. */
  sendAudio(callSid: string, audioBase64: string): boolean {
    const handler = this.streams.get(callSid);
    const session = handler?.currentStreamSession;
    if (!handler || !session) {
      log.warn('sendAudio: no stream for call', { callSid });
      return false;
    }
    return handler.sendAudio(session.streamSid, audioBase64);
  }

  /** Clear queued outbound audio — used for barge-in. */
  clearAudio(callSid: string): void {
    const handler = this.streams.get(callSid);
    const session = handler?.currentStreamSession;
    if (!session) return;
    handler!.clearAudio(session.streamSid);
  }

  /** Hang up a call by closing the WebSocket stream. */
  hangup(callSid: string): void {
    const handler = this.streams.get(callSid);
    if (!handler) return;
    handler.close();
    this.streams.delete(callSid);
    log.info('Call hung up', { callSid });
  }

  getStreamSession(callSid: string): TwilioStreamSession | null {
    return this.streams.get(callSid)?.currentStreamSession ?? null;
  }

  // ─── Outbound Call Initiation ─────────────────────────────────────────────

  /**
   * Initiate an outbound call via Twilio REST API.
   *
   * Twilio will call the destination, then POST to our /webhooks/twilio/voice
   * endpoint to fetch TwiML, which instructs Twilio to open a media stream
   * back to our /stream WebSocket endpoint.
   */
  async initiateOutboundCall(
    request: TwilioOutboundCallRequest,
  ): Promise<TwilioOutboundCallResponse> {
    try {
      const baseUrl = Env.twilio.webhookBaseUrl;
      if (!baseUrl) {
        throw new Error('TWILIO_WEBHOOK_BASE_URL is not set — cannot initiate outbound call');
      }

      const from = request.from ?? Env.twilio.phoneNumber;
      log.info('Initiating outbound call', { to: request.to, from });

      const call = await this.client.calls.create({
        to: request.to,
        from,
        url: `${baseUrl}/webhooks/twilio/voice`,
        statusCallback: `${baseUrl}/webhooks/twilio/status`,
        statusCallbackMethod: 'POST',
      });

      return { callSid: call.sid, status: 'queued' };
    } catch (err) {
      const message = (err as Error).message;
      log.error('Outbound call failed', { error: message });
      return { callSid: '', status: 'failed', message };
    }
  }

  activeStreamCount(): number {
    return this.streams.size;
  }
}
