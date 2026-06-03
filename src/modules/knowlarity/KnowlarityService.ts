/**
 * KnowlarityService: outbound call management and stream registry.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * COMMENTED OUT — replaced by TwilioService.
 * Code is preserved here for reference. Do NOT delete.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// import axios, { AxiosInstance } from 'axios';
import WebSocket from 'ws';
// import { Env } from '../../config';
import { AppEvent } from '../../events/EventTypes';
import { eventBus } from '../../shared/EventBus';
import { Logger } from '../../shared/Logger';
import {
  KnowlarityStreamSession,
  OutboundCallRequest,
  OutboundCallResponse,
} from './KnowlarityTypes';
import {
  KnowlarityStreamHandler,
  OnAudioReceived,
  OnStreamStarted,
  OnStreamStopped,
} from './KnowlarityStreamHandler';

const log = Logger.root('KnowlarityService');

export class KnowlarityService {
  // private readonly http: AxiosInstance; // ← commented out: Env.knowlarity no longer exists

  private readonly streams: Map<string, KnowlarityStreamHandler> = new Map();
  private onAudioReceived: OnAudioReceived = () => {};
  private onStreamStarted: OnStreamStarted = () => {};
  private onStreamStopped: OnStreamStopped = () => {};

  constructor() {
    // ── Commented out: Env.knowlarity was removed when switching to Twilio ──
    // this.http = axios.create({
    //   baseURL: Env.knowlarity.apiUrl,
    //   headers: {
    //     'x-api-key': Env.knowlarity.apiKey,
    //     'Authorization': Env.knowlarity.apiSecret,
    //     'Content-Type': 'application/json',
    //   },
    //   timeout: 10_000,
    // });
  }

  registerCallbacks(
    onAudio: OnAudioReceived,
    onStart: OnStreamStarted,
    onStop: OnStreamStopped,
  ): void {
    this.onAudioReceived = onAudio;
    this.onStreamStarted = onStart;
    this.onStreamStopped = onStop;
  }

  acceptStream(ws: WebSocket, remoteAddress: string): void {
    log.info('Accepting new Knowlarity media stream', { remoteAddress });

    const handler = new KnowlarityStreamHandler(
      ws,
      (callId, audioBase64, seq) => { this.onAudioReceived(callId, audioBase64, seq); },
      (callId, session) => {
        this.streams.set(callId, handler);
        log.info('Stream registered', { callId });
        eventBus.emit(AppEvent.KNOWLARITY_CONNECTED, {
          sessionId: 'pending',
          callId,
          timestamp: Date.now(),
          remoteAddress,
        });
        this.onStreamStarted(callId, session);
      },
      (callId) => {
        this.streams.delete(callId);
        log.info('Stream deregistered', { callId });
        eventBus.emit(AppEvent.KNOWLARITY_DISCONNECTED, {
          sessionId: 'unknown',
          callId,
          timestamp: Date.now(),
          code: 1000,
          reason: 'stream-stopped',
        });
        this.onStreamStopped(callId);
      },
    );
  }

  sendAudio(callId: string, audioBase64: string): boolean {
    const handler = this.streams.get(callId);
    if (!handler) return false;
    const session = handler.currentStreamSession;
    if (!session) return false;
    return handler.sendAudio(session.streamSid, audioBase64);
  }

  clearAudio(callId: string): void {
    const handler = this.streams.get(callId);
    if (!handler?.currentStreamSession) return;
    handler.clearAudio(handler.currentStreamSession.streamSid);
  }

  hangup(callId: string): void {
    const handler = this.streams.get(callId);
    if (!handler) return;
    handler.close();
    this.streams.delete(callId);
    log.info('Call hung up', { callId });
  }

  getStreamSession(callId: string): KnowlarityStreamSession | null {
    return this.streams.get(callId)?.currentStreamSession ?? null;
  }

  async initiateOutboundCall(_request: OutboundCallRequest): Promise<OutboundCallResponse> {
    // ── Commented out: Env.knowlarity was removed when switching to Twilio ──
    // const payload = {
    //   customer: { phone: request.to },
    //   agent: { phone: request.callerId },
    //   caller_id: Env.knowlarity.srNumber,
    //   is_return_call: false,
    //   ...(request.metadata ?? {}),
    // };
    // const response = await this.http.post('/v1/account/{{account_id}}/call/outbound/', payload);
    // ...
    throw new Error('KnowlarityService is disabled — use TwilioService instead.');
  }

  activeStreamCount(): number {
    return this.streams.size;
  }
}
