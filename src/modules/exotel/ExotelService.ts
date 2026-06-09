/**
 * ExotelService: stream registry + outbound call management for Exotel.
 *
 * Drop-in replacement for TwilioService. Implements TelephonyProvider so it
 * can be passed to AudioRouter, MediaGatewayService, and WebSocketServer
 * without changes to those modules.
 *
 * Outbound calls use Exotel REST API v1:
 *   POST https://api.exotel.com/v1/Accounts/{AccountSid}/Calls/connect.json
 *   Auth: HTTP Basic {api_key}:{api_token}
 */

import WebSocket from 'ws';
import axios from 'axios';
import { Env } from '../../config';
import { AppEvent } from '../../events/EventTypes';
import { eventBus } from '../../shared/EventBus';
import { Logger } from '../../shared/Logger';
import { TwilioStreamSession } from '../twilio/TwilioTypes';
import {
  OnAudioReceived,
  OnStreamStarted,
  OnStreamStopped,
} from '../twilio/TwilioStreamHandler';
import { TelephonyProvider } from '../telephony/TelephonyProvider';
import { ExotelStreamHandler } from './ExotelStreamHandler';
import { ExotelOutboundCallRequest, ExotelOutboundCallResponse } from './ExotelTypes';

const log = Logger.root('ExotelService');

/**
 * Exotel's API expects Indian numbers in 0-prefixed format (0XXXXXXXXXX).
 * Converts E.164 +91XXXXXXXXXX → 0XXXXXXXXXX. Leaves other formats untouched.
 */
function toExotelNumber(num: string): string {
  if (num.startsWith('+91') && num.length === 13) {
    return '0' + num.slice(3);
  }
  return num;
}

export class ExotelService implements TelephonyProvider {
  /** callSid → handler for O(1) audio routing. */
  private readonly streams: Map<string, ExotelStreamHandler> = new Map();

  private onAudioReceived: OnAudioReceived = () => {};
  private onStreamStarted: OnStreamStarted = () => {};
  private onStreamStopped: OnStreamStopped = () => {};

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

  acceptStream(ws: WebSocket, remoteAddress: string): void {
    log.info('Accepting Exotel media stream', { remoteAddress });

    const handler = new ExotelStreamHandler(
      ws,
      (callSid, audioBase64, seq) => {
        this.onAudioReceived(callSid, audioBase64, seq);
      },
      (callSid, session) => {
        this.streams.set(callSid, handler);
        log.info('Stream registered', { callSid });

        eventBus.emit(AppEvent.KNOWLARITY_CONNECTED, {
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

  // ─── Outbound Audio ────────────────────────────────────────────────────────

  sendAudio(callSid: string, audioBase64: string): boolean {
    const handler = this.streams.get(callSid);
    const session = handler?.currentStreamSession;
    if (!handler || !session) {
      log.warn('sendAudio: no stream for call', { callSid });
      return false;
    }
    return handler.sendAudio(session.streamSid, audioBase64);
  }

  clearAudio(callSid: string): void {
    const handler = this.streams.get(callSid);
    const session = handler?.currentStreamSession;
    if (!session) return;
    handler!.clearAudio(session.streamSid);
  }

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
   * Initiate an outbound call via Exotel REST API v1.
   *
   * Exotel dials the destination, then POSTs to /webhooks/exotel/voice to fetch
   * ExoML, which instructs Exotel to open a media stream to /stream.
   */
  async initiateOutboundCall(
    request: ExotelOutboundCallRequest,
  ): Promise<ExotelOutboundCallResponse> {
    try {
      const baseUrl = Env.exotel.webhookBaseUrl;
      if (!baseUrl) {
        throw new Error('EXOTEL_WEBHOOK_BASE_URL is not set — cannot initiate outbound call');
      }

      const from = toExotelNumber((request.from ?? Env.exotel.phoneNumber).trim());
      const to = toExotelNumber(request.to.trim());
      log.info('Initiating Exotel outbound call', { to, from });

      // Endpoint: POST https://{SubDomain}/v1/Accounts/{AccountSid}/Calls/connect
      const accountSid = Env.exotel.accountSid.trim();
      const url = `https://${Env.exotel.apiSubdomain.trim()}/v1/Accounts/${accountSid}/Calls/connect`;
      // Exotel Calls/connect convention:
      //   From     = ExoPhone (your virtual number — the caller ID shown to customer)
      //   To       = customer number to dial
      //   CallerId = ExoPhone (same as From)
      const params = new URLSearchParams({
        From: from,
        To: to,
        CallerId: from,
        Url: `${baseUrl}/webhooks/exotel/voice`,
        StatusCallback: `${baseUrl}/webhooks/exotel/status`,
        StatusCallbackMethod: 'POST',
      });

      log.info('Exotel API request', { url, params: params.toString() });

      const response = await axios.post(url, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        auth: {
          username: Env.exotel.apiKey.trim(),
          password: Env.exotel.apiToken.trim(),
        },
      });

      const callSid: string = response.data?.Call?.Sid ?? '';
      log.info('Exotel outbound call queued', { callSid, response: response.data });
      return { callSid, status: 'queued' };
    } catch (err) {
      const axiosErr = err as import('axios').AxiosError;
      const message = axiosErr.message;
      const responseBody = axiosErr.response?.data;
      log.error('Exotel outbound call failed', { error: message, status: axiosErr.response?.status, body: responseBody });
      return { callSid: '', status: 'failed', message: `${message} — ${JSON.stringify(responseBody)}` };
    }
  }

  activeStreamCount(): number {
    return this.streams.size;
  }
}
