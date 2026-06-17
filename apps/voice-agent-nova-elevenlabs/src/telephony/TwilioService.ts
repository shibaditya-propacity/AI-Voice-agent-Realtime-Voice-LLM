/**
 * TwilioService: registry of active call streams and outbound call API.
 */

import WebSocket from 'ws';
import twilio from 'twilio';
import { Env } from '../config/env';
import { Logger } from '../shared/logger';
import { TwilioStreamHandler, OnAudioReceived, OnStreamStarted, OnStreamStopped } from './TwilioStreamHandler';
import { TwilioStreamSession, OutboundCallRequest, OutboundCallResponse } from './types';

export class TwilioService {
  private readonly handlers = new Map<string, TwilioStreamHandler>();
  private readonly log = Logger.root('TwilioService');
  private readonly client: ReturnType<typeof twilio>;

  private audioCallback?: OnAudioReceived;
  private startCallback?: OnStreamStarted;
  private stopCallback?: OnStreamStopped;

  constructor() {
    this.client = twilio(Env.twilio.accountSid, Env.twilio.authToken);
  }

  // ─── Callback Registration ────────────────────────────────────────────────

  onAudioReceived(cb: OnAudioReceived): void  { this.audioCallback = cb; }
  onStreamStarted(cb: OnStreamStarted): void  { this.startCallback = cb; }
  onStreamStopped(cb: OnStreamStopped): void  { this.stopCallback  = cb; }

  // ─── Stream Lifecycle ─────────────────────────────────────────────────────

  acceptStream(ws: WebSocket, remoteAddress: string): void {
    this.log.info('Accepting new Twilio stream', { remoteAddress });

    const handler = new TwilioStreamHandler(
      ws,
      (callSid, audio, seqNum) => this.audioCallback?.(callSid, audio, seqNum),
      (callSid, session) => {
        this.handlers.set(callSid, handler);
        this.startCallback?.(callSid, session);
      },
      (callSid) => {
        this.handlers.delete(callSid);
        this.stopCallback?.(callSid);
      },
    );
  }

  // ─── Outbound Audio ───────────────────────────────────────────────────────

  sendAudio(callSid: string, audioBase64: string): boolean {
    const handler = this.handlers.get(callSid);
    if (!handler) return false;
    const session = handler.session;
    if (!session) return false;
    return handler.sendAudio(session.streamSid, audioBase64);
  }

  clearAudio(callSid: string): void {
    const handler = this.handlers.get(callSid);
    const session = handler?.session;
    if (handler && session) handler.clearAudio(session.streamSid);
  }

  sendMark(callSid: string, name: string): void {
    const handler = this.handlers.get(callSid);
    const session = handler?.session;
    if (handler && session) handler.sendMark(session.streamSid, name);
  }

  // ─── Outbound Call ────────────────────────────────────────────────────────

  async initiateOutboundCall(request: OutboundCallRequest): Promise<OutboundCallResponse> {
    const { to, from, metadata = {} } = request;
    const statusUrl  = `${Env.twilio.webhookBaseUrl}/webhooks/twilio/status`;

    // Build TwiML inline — avoids Twilio needing to HTTP-fetch our webhook URL
    // (ngrok/cloudflare tunnels are unreliable for Twilio's TwiML fetch).
    const streamUrl = Env.twilio.webhookBaseUrl
      .replace(/^https?:\/\//, 'wss://')
      .replace(/^http:\/\//, 'ws://')
      + '/stream';

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="callerNumber" value="${to}"/>
    </Stream>
  </Connect>
</Response>`;

    try {
      const call = await this.client.calls.create({
        to,
        from: from ?? Env.twilio.phoneNumber,
        twiml,
        statusCallback: statusUrl,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        ...(Object.keys(metadata).length > 0 && { sendDigits: JSON.stringify(metadata) }),
      });

      this.log.info('Outbound call initiated', { callSid: call.sid, to, status: call.status });
      return { callSid: call.sid, status: 'queued' };
    } catch (err) {
      const msg = (err as Error).message;
      this.log.error('Failed to initiate outbound call', err as Error, { to });
      return { callSid: '', status: 'failed', message: msg };
    }
  }

  // ─── Utility ──────────────────────────────────────────────────────────────

  getSession(callSid: string): TwilioStreamSession | null {
    return this.handlers.get(callSid)?.session ?? null;
  }

  get activeStreamCount(): number { return this.handlers.size; }
}
