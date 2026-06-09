/**
 * TelephonyProvider: shared interface implemented by TwilioService and ExotelService.
 *
 * AudioRouter, MediaGatewayService, and WebSocketServer depend on this interface
 * so the active telephony provider can be swapped via TELEPHONY_PROVIDER env var
 * without touching any downstream audio or session logic.
 */

import WebSocket from 'ws';
import { OnAudioReceived, OnStreamStarted, OnStreamStopped } from '../twilio/TwilioStreamHandler';

export interface TelephonyProvider {
  registerCallbacks(
    onAudio: OnAudioReceived,
    onStart: OnStreamStarted,
    onStop: OnStreamStopped,
  ): void;
  sendAudio(callId: string, audioBase64: string): boolean;
  clearAudio(callId: string): void;
  hangup(callId: string): void;
  acceptStream(ws: WebSocket, remoteAddress: string): void;
  activeStreamCount(): number;
}
