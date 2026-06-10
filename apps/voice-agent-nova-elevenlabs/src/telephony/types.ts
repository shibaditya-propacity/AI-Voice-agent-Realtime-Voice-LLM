/**
 * Twilio Media Streams WebSocket message types.
 * Reference: https://www.twilio.com/docs/voice/media-streams/websocket-messages
 */

// ─── Inbound (Twilio → Server) ────────────────────────────────────────────────

export interface TwilioConnectedMessage {
  event: 'connected';
  protocol: string;
  version: string;
}

export interface TwilioStartMessage {
  event: 'start';
  sequenceNumber: string;
  start: {
    streamSid: string;
    callSid: string;
    accountSid: string;
    tracks: string[];
    customParameters: Record<string, string>;
    mediaFormat: {
      encoding: string;   // 'audio/x-mulaw'
      sampleRate: number; // 8000
      channels: number;   // 1
    };
  };
}

export interface TwilioMediaMessage {
  event: 'media';
  sequenceNumber: string;
  media: {
    track: 'inbound' | 'outbound';
    chunk: string;       // sequential chunk number as string
    timestamp: string;   // ms since stream start
    payload: string;     // base64-encoded PCMU audio
  };
}

export interface TwilioStopMessage {
  event: 'stop';
  sequenceNumber: string;
  stop: {
    accountSid: string;
    callSid: string;
  };
}

export interface TwilioDtmfMessage {
  event: 'dtmf';
  sequenceNumber: string;
  dtmf: { track: string; digit: string };
}

export interface TwilioMarkMessage {
  event: 'mark';
  sequenceNumber: string;
  mark: { name: string };
}

export type TwilioInboundMessage =
  | TwilioConnectedMessage
  | TwilioStartMessage
  | TwilioMediaMessage
  | TwilioStopMessage
  | TwilioDtmfMessage
  | TwilioMarkMessage;

// ─── Outbound (Server → Twilio) ───────────────────────────────────────────────

export interface TwilioMediaSend {
  event: 'media';
  streamSid: string;
  media: { payload: string }; // base64-encoded PCMU
}

export interface TwilioClearSend {
  event: 'clear';
  streamSid: string;
}

export interface TwilioMarkSend {
  event: 'mark';
  streamSid: string;
  mark: { name: string };
}

// ─── Session ──────────────────────────────────────────────────────────────────

export interface TwilioStreamSession {
  streamSid: string;
  callSid: string;
  accountSid: string;
  encoding: string;
  sampleRate: number;
  channels: number;
  callerNumber: string;
  startedAt: number;
  sequenceNumber: number;
}

// ─── Outbound call ────────────────────────────────────────────────────────────

export interface OutboundCallRequest {
  to: string;
  from?: string;
  metadata?: Record<string, string>;
}

export interface OutboundCallResponse {
  callSid: string;
  status: 'queued' | 'ringing' | 'failed';
  message?: string;
}
