/**
 * Shared global types used across multiple modules.
 */

// ─── Core Primitives ─────────────────────────────────────────────────────────

export type SessionId = string;
export type CallId = string;
export type PhoneNumber = string;

// ─── Audio ───────────────────────────────────────────────────────────────────

export type AudioCodec = 'pcmu' | 'pcma' | 'pcm16' | 'pcm32' | 'opus';

export interface AudioFrame {
  data: Buffer;
  codec: AudioCodec;
  sampleRate: number;
  channelCount: number;
  durationMs: number;
  sequenceNumber: number;
  timestamp: number;
}

export interface AudioStats {
  framesReceived: number;
  framesProcessed: number;
  framesSent: number;
  bytesReceived: number;
  bytesSent: number;
  lastFrameAt: number;
  silenceFrames: number;
  totalDurationMs: number;
}

// ─── Call ────────────────────────────────────────────────────────────────────

export type CallDirection = 'inbound' | 'outbound';
export type CallStatus = 'ringing' | 'answered' | 'in-progress' | 'ended' | 'failed';
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface CallMetadata {
  callId: CallId;
  sessionId: SessionId;
  direction: CallDirection;
  callerNumber: PhoneNumber;
  toNumber: PhoneNumber;
  startedAt: number;
  answeredAt?: number;
  endedAt?: number;
  status: CallStatus;
}

// ─── Conversation ─────────────────────────────────────────────────────────────

export type ConversationRole = 'user' | 'assistant' | 'system';

export interface TranscriptEntry {
  role: ConversationRole;
  text: string;
  timestamp: number;
  isFinal: boolean;
  turnIndex: number;
}

export interface ConversationContext {
  turnCount: number;
  lastUserText: string;
  lastAssistantText: string;
  topics: string[];
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';
export type ErrorSource =
  | 'knowlarity'
  | 'krisp'
  | 'nova'
  | 'media-gateway'
  | 'session'
  | 'audio'
  | 'websocket'
  | 'network'
  | 'unknown';

export interface AppError {
  code: string;
  message: string;
  source: ErrorSource;
  severity: ErrorSeverity;
  sessionId?: SessionId;
  callId?: CallId;
  cause?: Error;
  timestamp: number;
  recoverable: boolean;
}

// ─── Service Interfaces ───────────────────────────────────────────────────────

export interface Disposable {
  dispose(): Promise<void>;
}

export interface HealthCheckable {
  isHealthy(): boolean;
}

export interface Initializable {
  initialize(): Promise<void>;
}
