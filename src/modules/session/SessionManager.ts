/**
 * SessionManager: lifecycle orchestration for call sessions.
 * Responsible for creating, updating, and destroying sessions.
 * Coordinates with the event bus to broadcast session events.
 */

import { Env } from '../../config';
import { AppEvent } from '../../events/EventTypes';
import { eventBus } from '../../shared/EventBus';
import { Logger } from '../../shared/Logger';
import { AudioStats, CallMetadata, ConversationContext, TranscriptEntry } from '../../types';
import { generateSessionId, nowMs } from '../../utils/helpers';
import { CallSession, SessionState, SessionStore, SessionUpdate } from './index';

const log = Logger.root('SessionManager');

export class SessionManager {
  private readonly store: SessionStore;
  private idleCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(store: SessionStore) {
    this.store = store;
    this.startIdleCheck();
  }

  // ─── Session Lifecycle ───────────────────────────────────────────────────

  /**
   * Create a new session for an incoming or outgoing call.
   * Throws if max concurrent sessions would be exceeded.
   */
  createSession(params: {
    callId: string;
    callerNumber: string;
    toNumber: string;
    direction: 'inbound' | 'outbound';
  }): CallSession {
    const maxCalls = Env.session.maxConcurrentCalls;
    if (maxCalls > 0 && this.store.count() >= maxCalls) {
      throw new Error(
        `Max concurrent calls reached (${maxCalls}). Rejecting call ${params.callId}.`,
      );
    }

    const sessionId = generateSessionId();
    const now = nowMs();

    const audioStats: AudioStats = {
      framesReceived: 0,
      framesProcessed: 0,
      framesSent: 0,
      bytesReceived: 0,
      bytesSent: 0,
      lastFrameAt: now,
      silenceFrames: 0,
      totalDurationMs: 0,
    };

    const callMetadata: CallMetadata = {
      callId: params.callId,
      sessionId,
      direction: params.direction,
      callerNumber: params.callerNumber,
      toNumber: params.toNumber,
      startedAt: now,
      status: 'answered',
    };

    const conversationContext: ConversationContext = {
      turnCount: 0,
      lastUserText: '',
      lastAssistantText: '',
      topics: [],
    };

    const session: CallSession = {
      sessionId,
      callId: params.callId,
      callerNumber: params.callerNumber,
      startedAt: now,
      lastActivityAt: now,
      currentState: 'initializing',
      transcriptHistory: [],
      conversationContext,
      audioStatistics: audioStats,
      callMetadata,
      connectionStatus: 'connecting',
      turnIndex: 0,
      agentSpeaking: false,
    };

    this.store.create(session);

    eventBus.emit(AppEvent.SESSION_CREATED, {
      sessionId,
      callId: params.callId,
      callerNumber: params.callerNumber,
      timestamp: now,
    });

    log.info('Session created', { sessionId, callId: params.callId, direction: params.direction });
    return session;
  }

  /**
   * Transition a session to a new state.
   */
  transitionState(sessionId: string, newState: SessionState): CallSession {
    const session = this.requireSession(sessionId);
    log.debug(`State transition: ${session.currentState} → ${newState}`, {
      sessionId,
      callId: session.callId,
    });
    return this.store.update(sessionId, { currentState: newState });
  }

  /**
   * Append a transcript entry. Keeps the conversation context in sync.
   */
  addTranscriptEntry(
    sessionId: string,
    role: 'user' | 'assistant',
    text: string,
    isFinal: boolean,
  ): CallSession {
    const session = this.requireSession(sessionId);
    const now = nowMs();

    const entry: TranscriptEntry = {
      role,
      text,
      timestamp: now,
      isFinal,
      turnIndex: session.turnIndex,
    };

    const updatedHistory = [...session.transcriptHistory, entry];
    const updatedContext: ConversationContext = {
      ...session.conversationContext,
      turnCount: session.conversationContext.turnCount + (isFinal ? 1 : 0),
      lastUserText: role === 'user' && isFinal ? text : session.conversationContext.lastUserText,
      lastAssistantText:
        role === 'assistant' && isFinal ? text : session.conversationContext.lastAssistantText,
    };

    const updated = this.store.update(sessionId, {
      transcriptHistory: updatedHistory,
      conversationContext: updatedContext,
    });

    if (isFinal) {
      eventBus.emit(AppEvent.TRANSCRIPT_UPDATED, {
        sessionId,
        callId: session.callId,
        timestamp: now,
        role,
        text,
        isFinal,
      });
    }

    return updated;
  }

  /**
   * Remove all non-final (interim) transcript entries from history.
   * Called during barge-in to discard partial/overlapping transcripts so only
   * complete, finalized utterances remain in the transcript record.
   */
  purgeInterimTranscripts(sessionId: string): void {
    const session = this.store.get(sessionId);
    if (!session) return;

    const cleaned = session.transcriptHistory.filter(e => e.isFinal);
    if (cleaned.length < session.transcriptHistory.length) {
      log.info('Purged interim transcript entries on interruption', {
        sessionId,
        callId: session.callId,
        removed: session.transcriptHistory.length - cleaned.length,
        remaining: cleaned.length,
      });
      this.store.update(sessionId, { transcriptHistory: cleaned });
    }
  }

  /**
   * Increment the turn index (called when one side finishes speaking).
   */
  incrementTurn(sessionId: string): CallSession {
    const session = this.requireSession(sessionId);
    return this.store.update(sessionId, { turnIndex: session.turnIndex + 1 });
  }

  /**
   * Update audio statistics incrementally.
   */
  recordAudioStats(
    sessionId: string,
    delta: Partial<Pick<AudioStats, 'framesReceived' | 'framesProcessed' | 'framesSent' | 'bytesReceived' | 'bytesSent' | 'silenceFrames'>>,
    durationDeltaMs: number = 0,
  ): void {
    const session = this.requireSession(sessionId);
    const stats = session.audioStatistics;

    this.store.update(sessionId, {
      audioStatistics: {
        framesReceived: stats.framesReceived + (delta.framesReceived ?? 0),
        framesProcessed: stats.framesProcessed + (delta.framesProcessed ?? 0),
        framesSent: stats.framesSent + (delta.framesSent ?? 0),
        bytesReceived: stats.bytesReceived + (delta.bytesReceived ?? 0),
        bytesSent: stats.bytesSent + (delta.bytesSent ?? 0),
        silenceFrames: stats.silenceFrames + (delta.silenceFrames ?? 0),
        lastFrameAt: nowMs(),
        totalDurationMs: stats.totalDurationMs + durationDeltaMs,
      },
    });
  }

  /**
   * Mark the session as terminated and emit SESSION_DESTROYED.
   * Callers should follow up with destroySession() after cleanup.
   */
  terminateSession(sessionId: string, reason: string): void {
    const session = this.store.get(sessionId);
    if (!session) return;

    const now = nowMs();
    this.store.update(sessionId, {
      currentState: 'terminating',
      callMetadata: { ...session.callMetadata, status: 'ended', endedAt: now },
    });

    log.info('Session terminating', {
      sessionId,
      callId: session.callId,
      reason,
      durationMs: now - session.startedAt,
    });
  }

  /**
   * Permanently destroy a session from memory.
   */
  destroySession(sessionId: string, reason: string): void {
    const session = this.store.get(sessionId);
    if (!session) return;

    this.store.destroy(sessionId);

    eventBus.emit(AppEvent.SESSION_DESTROYED, {
      sessionId,
      callId: session.callId,
      timestamp: nowMs(),
      reason,
    });
  }

  // ─── Lookups ─────────────────────────────────────────────────────────────

  /** Apply an arbitrary partial update to a session (escape hatch for coordinators). */
  patchSession(sessionId: string, patch: SessionUpdate): CallSession {
    return this.store.update(sessionId, patch);
  }

  getSession(sessionId: string): CallSession | undefined {
    return this.store.get(sessionId);
  }

  getSessionByCallId(callId: string): CallSession | undefined {
    return this.store.getByCallId(callId);
  }

  requireSession(sessionId: string): CallSession {
    const session = this.store.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }

  activeSessions(): CallSession[] {
    return this.store.list();
  }

  activeCount(): number {
    return this.store.count();
  }

  // ─── Idle Cleanup ─────────────────────────────────────────────────────────

  private startIdleCheck(): void {
    const interval = Math.min(Env.session.idleTimeoutMs / 2, 60_000); // check at most every 60s
    this.idleCheckTimer = setInterval(() => this.evictIdleSessions(), interval);
    // Prevent the timer from keeping the process alive
    this.idleCheckTimer.unref?.();
  }

  private evictIdleSessions(): void {
    const idle = this.store.findIdle(Env.session.idleTimeoutMs);
    for (const session of idle) {
      log.warn('Evicting idle session', {
        sessionId: session.sessionId,
        callId: session.callId,
        idleMs: Date.now() - session.lastActivityAt,
      });
      this.destroySession(session.sessionId, 'idle-timeout');
    }
  }

  dispose(): void {
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }
  }
}
