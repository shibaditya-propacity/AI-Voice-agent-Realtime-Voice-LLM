/**
 * Twilio Media Streams type definitions.
 *
 * Twilio Media Streams uses the same bidirectional WebSocket JSON protocol
 * as documented at:
 * https://www.twilio.com/docs/voice/media-streams/websocket-messages
 */

// ─── Inbound WebSocket Messages (Twilio → Server) ────────────────────────────

export interface TwilioStreamConnected {
  event: 'connected';
  protocol: string;
  version: string;
}

export interface TwilioStreamStart {
  event: 'start';
  sequenceNumber: string;
  start: {
    streamSid: string;
    callSid: string;
    accountSid: string;
    tracks: Array<'inbound' | 'outbound' | 'both'>;
    customParameters: Record<string, string>;
    mediaFormat: {
      encoding: 'audio/x-mulaw' | 'audio/x-alaw' | 'audio/basic';
      sampleRate: number;
      channels: number;
    };
  };
}

export interface TwilioStreamMedia {
  event: 'media';
  sequenceNumber: string;
  media: {
    track: 'inbound' | 'outbound';
    chunk: string;      // sequential number as string
    timestamp: string;  // ms since stream start as string
    payload: string;    // base64-encoded audio
  };
}

export interface TwilioStreamStop {
  event: 'stop';
  sequenceNumber: string;
  stop: {
    accountSid: string;
    callSid: string;
  };
}

export interface TwilioStreamDtmf {
  event: 'dtmf';
  sequenceNumber: string;
  streamSid: string;
  dtmf: {
    track: 'inbound_track';
    digit: string;
  };
}

export interface TwilioStreamMark {
  event: 'mark';
  sequenceNumber: string;
  streamSid: string;
  mark: {
    name: string;
  };
}

export type TwilioStreamMessage =
  | TwilioStreamConnected
  | TwilioStreamStart
  | TwilioStreamMedia
  | TwilioStreamStop
  | TwilioStreamDtmf
  | TwilioStreamMark;

// ─── Outbound WebSocket Messages (Server → Twilio) ────────────────────────────

export interface TwilioMediaSend {
  event: 'media';
  streamSid: string;
  media: {
    payload: string; // base64-encoded audio to play to the caller
  };
}

export interface TwilioMarkSend {
  event: 'mark';
  streamSid: string;
  mark: {
    name: string;
  };
}

export interface TwilioClearSend {
  event: 'clear';
  streamSid: string;
}

export type TwilioSendMessage = TwilioMediaSend | TwilioMarkSend | TwilioClearSend;

// ─── Active Stream Session ────────────────────────────────────────────────────

export interface TwilioStreamSession {
  streamSid: string;
  callSid: string;
  accountSid: string;
  encoding: 'audio/x-mulaw' | 'audio/x-alaw' | 'audio/basic';
  sampleRate: number;
  channels: number;
  /** Caller's number sourced from customParameters.callerNumber or empty string. */
  callerNumber: string;
  startedAt: number;
  sequenceNumber: number;
}

// ─── Outbound Call ────────────────────────────────────────────────────────────

export interface TwilioOutboundCallRequest {
  to: string;        // E.164 destination number
  from?: string;     // Override Twilio phone number (defaults to Env.twilio.phoneNumber)
  metadata?: Record<string, string>;
}

export interface TwilioOutboundCallResponse {
  callSid: string;
  status: 'queued' | 'ringing' | 'failed';
  message?: string;
}
