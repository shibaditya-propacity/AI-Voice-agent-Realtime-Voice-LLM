/**
 * Internal event bus constants and payload types.
 * All inter-module communication flows through these typed events.
 */

// ─── Event Name Constants ────────────────────────────────────────────────────

export const AppEvent = {
  // Call lifecycle
  CALL_STARTED: 'CALL_STARTED',
  CALL_ENDED: 'CALL_ENDED',

  // Session lifecycle
  SESSION_CREATED: 'SESSION_CREATED',
  SESSION_DESTROYED: 'SESSION_DESTROYED',

  // Audio pipeline
  AUDIO_RECEIVED: 'AUDIO_RECEIVED',
  AUDIO_PROCESSED: 'AUDIO_PROCESSED',
  AUDIO_SENT: 'AUDIO_SENT',

  // Conversation events
  INTERRUPTION_DETECTED: 'INTERRUPTION_DETECTED',
  TRANSCRIPT_UPDATED: 'TRANSCRIPT_UPDATED',
  TURN_STARTED: 'TURN_STARTED',
  TURN_COMPLETED: 'TURN_COMPLETED',

  // Nova Sonic connectivity
  NOVA_CONNECTED: 'NOVA_CONNECTED',
  NOVA_DISCONNECTED: 'NOVA_DISCONNECTED',
  NOVA_SESSION_STARTED: 'NOVA_SESSION_STARTED',
  NOVA_RESPONSE_STARTED: 'NOVA_RESPONSE_STARTED',
  NOVA_RESPONSE_COMPLETED: 'NOVA_RESPONSE_COMPLETED',

  // Knowlarity connectivity
  KNOWLARITY_CONNECTED: 'KNOWLARITY_CONNECTED',
  KNOWLARITY_DISCONNECTED: 'KNOWLARITY_DISCONNECTED',

  // Errors
  ERROR_OCCURRED: 'ERROR_OCCURRED',
} as const;

export type AppEventName = (typeof AppEvent)[keyof typeof AppEvent];

// ─── Event Payload Types ─────────────────────────────────────────────────────

export interface BaseEventPayload {
  sessionId: string;
  callId: string;
  timestamp: number;
}

export interface CallStartedPayload extends BaseEventPayload {
  callerNumber: string;
  direction: 'inbound' | 'outbound';
  toNumber: string;
}

export interface CallEndedPayload extends BaseEventPayload {
  reason: 'hangup' | 'timeout' | 'error' | 'completed';
  durationMs: number;
}

export interface SessionCreatedPayload extends BaseEventPayload {
  callerNumber: string;
}

export interface SessionDestroyedPayload extends BaseEventPayload {
  reason: string;
}

export interface AudioReceivedPayload extends BaseEventPayload {
  chunk: Buffer;
  codec: string;
  sampleRate: number;
  sequenceNumber: number;
}

export interface AudioProcessedPayload extends BaseEventPayload {
  chunk: Buffer;
  sampleRate: number;
  source: 'krisp' | 'raw';
}

export interface AudioSentPayload extends BaseEventPayload {
  bytesSent: number;
  destination: 'twilio' | 'nova';
}

export interface InterruptionDetectedPayload extends BaseEventPayload {
  confidence: number;
}

export interface TranscriptUpdatedPayload extends BaseEventPayload {
  role: 'user' | 'assistant';
  text: string;
  isFinal: boolean;
}

export interface TurnCompletedPayload extends BaseEventPayload {
  role: 'user' | 'assistant';
  turnIndex: number;
}

export interface NovaConnectedPayload extends BaseEventPayload {
  modelId: string;
}

export interface NovaDisconnectedPayload extends BaseEventPayload {
  reason: string;
  willReconnect: boolean;
}

export interface KnowlarityConnectedPayload extends BaseEventPayload {
  remoteAddress: string;
}

export interface KnowlarityDisconnectedPayload extends BaseEventPayload {
  code: number;
  reason: string;
}

export interface ErrorOccurredPayload extends BaseEventPayload {
  error: Error;
  source: string;
  recoverable: boolean;
}

// ─── Union Payload Map ────────────────────────────────────────────────────────

export interface EventPayloadMap {
  [AppEvent.CALL_STARTED]: CallStartedPayload;
  [AppEvent.CALL_ENDED]: CallEndedPayload;
  [AppEvent.SESSION_CREATED]: SessionCreatedPayload;
  [AppEvent.SESSION_DESTROYED]: SessionDestroyedPayload;
  [AppEvent.AUDIO_RECEIVED]: AudioReceivedPayload;
  [AppEvent.AUDIO_PROCESSED]: AudioProcessedPayload;
  [AppEvent.AUDIO_SENT]: AudioSentPayload;
  [AppEvent.INTERRUPTION_DETECTED]: InterruptionDetectedPayload;
  [AppEvent.TRANSCRIPT_UPDATED]: TranscriptUpdatedPayload;
  [AppEvent.TURN_STARTED]: BaseEventPayload;
  [AppEvent.TURN_COMPLETED]: TurnCompletedPayload;
  [AppEvent.NOVA_CONNECTED]: NovaConnectedPayload;
  [AppEvent.NOVA_DISCONNECTED]: NovaDisconnectedPayload;
  [AppEvent.NOVA_SESSION_STARTED]: BaseEventPayload;
  [AppEvent.NOVA_RESPONSE_STARTED]: BaseEventPayload;
  [AppEvent.NOVA_RESPONSE_COMPLETED]: BaseEventPayload;
  [AppEvent.KNOWLARITY_CONNECTED]: KnowlarityConnectedPayload;
  [AppEvent.KNOWLARITY_DISCONNECTED]: KnowlarityDisconnectedPayload;
  [AppEvent.ERROR_OCCURRED]: ErrorOccurredPayload;
}
