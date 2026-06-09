/**
 * Exotel Media Streams type definitions.
 *
 * Exotel's bidirectional WebSocket streaming protocol mirrors Twilio Media Streams.
 * Reference: https://developer.exotel.com/api/media-streaming
 */

// ─── Inbound WebSocket Messages (Exotel → Server) ────────────────────────────

export interface ExotelStreamConnected {
  event: 'connected';
  protocol: string;
  version: string;
}

export interface ExotelStreamStart {
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

export interface ExotelStreamMedia {
  event: 'media';
  sequenceNumber: string;
  media: {
    track: 'inbound' | 'outbound';
    chunk: string;
    timestamp: string;
    payload: string; // base64-encoded audio
  };
}

export interface ExotelStreamStop {
  event: 'stop';
  sequenceNumber: string;
  stop: {
    accountSid: string;
    callSid: string;
  };
}

export interface ExotelStreamDtmf {
  event: 'dtmf';
  sequenceNumber: string;
  streamSid: string;
  dtmf: {
    track: 'inbound_track';
    digit: string;
  };
}

export interface ExotelStreamMark {
  event: 'mark';
  sequenceNumber: string;
  streamSid: string;
  mark: {
    name: string;
  };
}

export type ExotelStreamMessage =
  | ExotelStreamConnected
  | ExotelStreamStart
  | ExotelStreamMedia
  | ExotelStreamStop
  | ExotelStreamDtmf
  | ExotelStreamMark;

// ─── Outbound WebSocket Messages (Server → Exotel) ────────────────────────────

export interface ExotelMediaSend {
  event: 'media';
  streamSid: string;
  media: {
    payload: string;
  };
}

export interface ExotelMarkSend {
  event: 'mark';
  streamSid: string;
  mark: {
    name: string;
  };
}

export interface ExotelClearSend {
  event: 'clear';
  streamSid: string;
}

// ─── Outbound Call ────────────────────────────────────────────────────────────

export interface ExotelOutboundCallRequest {
  to: string;       // E.164 destination number
  from?: string;    // Override ExoPhone (defaults to Env.exotel.phoneNumber)
  metadata?: Record<string, string>;
}

export interface ExotelOutboundCallResponse {
  callSid: string;
  status: 'queued' | 'in-progress' | 'failed';
  message?: string;
}
