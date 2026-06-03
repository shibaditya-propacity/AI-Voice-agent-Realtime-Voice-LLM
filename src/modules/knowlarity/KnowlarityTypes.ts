/**
 * Knowlarity API and streaming event type definitions.
 */

// ─── Webhook Events ───────────────────────────────────────────────────────────

export type KnowlarityEventType =
  | 'CALL_INITIATED'
  | 'CALL_ANSWERED'
  | 'CALL_HANGUP'
  | 'CALL_FAILED'
  | 'CALL_BUSY'
  | 'CALL_NO_ANSWER'
  | 'DTMF_RECEIVED'
  | 'STREAM_START'
  | 'STREAM_STOP';

export interface KnowlarityWebhookEvent {
  event: KnowlarityEventType;
  call_id: string;
  call_type: 'inbound' | 'outbound';
  caller_number: string;
  destination_number: string;
  timestamp: string;
  duration?: number;
  hangup_cause?: string;
  dtmf_digit?: string;
  sr_number?: string;
}

// ─── Realtime Media Stream Messages ───────────────────────────────────────────

export type KnowlarityStreamMessageType =
  | 'connected'
  | 'start'
  | 'media'
  | 'stop'
  | 'dtmf'
  | 'mark';

export interface KnowlarityStreamConnected {
  event: 'connected';
  protocol: string;
  version: string;
}

export interface KnowlarityStreamStart {
  event: 'start';
  sequenceNumber: string;
  start: {
    streamSid: string;
    callSid: string;         // maps to callId
    accountSid: string;
    tracks: string[];        // e.g. ["inbound"]
    customParameters: Record<string, string>;
    mediaFormat: {
      encoding: 'audio/x-mulaw' | 'audio/x-alaw' | 'audio/basic';
      sampleRate: number;
      channels: number;
    };
  };
}

export interface KnowlarityStreamMedia {
  event: 'media';
  sequenceNumber: string;
  media: {
    track: 'inbound' | 'outbound';
    chunk: string;           // sequential chunk number (as string)
    timestamp: string;       // milliseconds since stream start
    payload: string;         // base64-encoded audio
  };
}

export interface KnowlarityStreamStop {
  event: 'stop';
  sequenceNumber: string;
  stop: {
    accountSid: string;
    callSid: string;
  };
}

export interface KnowlarityStreamDtmf {
  event: 'dtmf';
  sequenceNumber: string;
  streamSid: string;
  dtmf: {
    track: 'inbound_track';
    digit: string;
  };
}

export interface KnowlarityStreamMark {
  event: 'mark';
  sequenceNumber: string;
  streamSid: string;
  mark: {
    name: string;
  };
}

export type KnowlarityStreamMessage =
  | KnowlarityStreamConnected
  | KnowlarityStreamStart
  | KnowlarityStreamMedia
  | KnowlarityStreamStop
  | KnowlarityStreamDtmf
  | KnowlarityStreamMark;

// ─── Outbound Audio Message ────────────────────────────────────────────────────

export interface KnowlarityMediaSend {
  event: 'media';
  streamSid: string;
  media: {
    payload: string; // base64-encoded audio to play to caller
  };
}

export interface KnowlarityMarkSend {
  event: 'mark';
  streamSid: string;
  mark: {
    name: string;
  };
}

export interface KnowlarityClearSend {
  event: 'clear';
  streamSid: string;
}

export type KnowlaritySendMessage = KnowlarityMediaSend | KnowlarityMarkSend | KnowlarityClearSend;

// ─── Outbound Call Request ────────────────────────────────────────────────────

export interface OutboundCallRequest {
  to: string;          // E.164 destination number
  callerId: string;    // Knowlarity caller line ID
  metadata?: Record<string, string>;
}

export interface OutboundCallResponse {
  callId: string;
  status: 'queued' | 'ringing' | 'failed';
  message?: string;
}

// ─── Stream Session ───────────────────────────────────────────────────────────

export interface KnowlarityStreamSession {
  streamSid: string;
  callSid: string;
  encoding: 'audio/x-mulaw' | 'audio/x-alaw' | 'audio/basic';
  sampleRate: number;
  channels: number;
  startedAt: number;
  sequenceNumber: number;
}
