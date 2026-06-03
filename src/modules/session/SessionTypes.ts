/**
 * Session data structures.
 * Sessions live only in-memory for the duration of an active call.
 */

import { AudioStats, CallMetadata, ConnectionStatus, ConversationContext, TranscriptEntry } from '../../types';

// ─── Session State Machine ────────────────────────────────────────────────────

export type SessionState =
  | 'initializing'
  | 'active'
  | 'processing'   // Nova Sonic is generating a response
  | 'speaking'     // Agent audio is being streamed back
  | 'interrupted'  // User spoke while agent was speaking
  | 'terminating'
  | 'terminated';

// ─── Session ─────────────────────────────────────────────────────────────────

export interface CallSession {
  /** Unique session identifier (sess_<uuid>). */
  sessionId: string;

  /** Knowlarity call identifier. */
  callId: string;

  /** Caller's phone number (E.164). */
  callerNumber: string;

  /** Unix timestamp (ms) when session was created. */
  startedAt: number;

  /** Unix timestamp (ms) of the last audio frame or event. */
  lastActivityAt: number;

  /** Current state in the call state machine. */
  currentState: SessionState;

  /** Ordered transcript of the conversation so far. */
  transcriptHistory: TranscriptEntry[];

  /** Rolling conversation context for Nova Sonic. */
  conversationContext: ConversationContext;

  /** Aggregated audio statistics. */
  audioStatistics: AudioStats;

  /** Call metadata (direction, status, timestamps). */
  callMetadata: CallMetadata;

  /** Knowlarity WebSocket connection status. */
  connectionStatus: ConnectionStatus;

  /** Current turn index (incremented on each role-switch). */
  turnIndex: number;

  /** Whether the agent is currently speaking audio back to caller. */
  agentSpeaking: boolean;
}

// ─── Session Update Partial ───────────────────────────────────────────────────

export type SessionUpdate = Partial<
  Omit<CallSession, 'sessionId' | 'callId' | 'startedAt'>
>;

// ─── Session Store Interface ──────────────────────────────────────────────────

export interface ISessionStore {
  create(session: CallSession): void;
  get(sessionId: string): CallSession | undefined;
  getByCallId(callId: string): CallSession | undefined;
  update(sessionId: string, update: SessionUpdate): CallSession;
  destroy(sessionId: string): void;
  list(): CallSession[];
  count(): number;
}
