/**
 * Pure in-memory session store.
 * Thread-safe within a single Node.js event loop (single-threaded JS guarantees).
 * No persistence — all sessions are lost on process exit by design.
 */

import { Logger } from '../../shared/Logger';
import { CallSession, ISessionStore, SessionUpdate } from './SessionTypes';

const log = Logger.root('SessionStore');

export class SessionStore implements ISessionStore {
  // Primary index: sessionId → session
  private readonly sessions: Map<string, CallSession> = new Map();

  // Secondary index: callId → sessionId (for quick lookups by Knowlarity call ID)
  private readonly callIndex: Map<string, string> = new Map();

  create(session: CallSession): void {
    if (this.sessions.has(session.sessionId)) {
      throw new Error(`Session ${session.sessionId} already exists`);
    }
    this.sessions.set(session.sessionId, session);
    this.callIndex.set(session.callId, session.sessionId);
    log.info('Session created', { sessionId: session.sessionId, callId: session.callId });
  }

  get(sessionId: string): CallSession | undefined {
    return this.sessions.get(sessionId);
  }

  getByCallId(callId: string): CallSession | undefined {
    const sessionId = this.callIndex.get(callId);
    if (!sessionId) return undefined;
    return this.sessions.get(sessionId);
  }

  /**
   * Apply a partial update to an existing session.
   * Also updates lastActivityAt automatically.
   */
  update(sessionId: string, update: SessionUpdate): CallSession {
    const existing = this.sessions.get(sessionId);
    if (!existing) {
      throw new Error(`Cannot update: session ${sessionId} not found`);
    }

    const updated: CallSession = {
      ...existing,
      ...update,
      lastActivityAt: Date.now(),
    };

    this.sessions.set(sessionId, updated);
    return updated;
  }

  /**
   * Permanently remove a session and free all references.
   * Called when a call ends. No data is written anywhere.
   */
  destroy(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      log.warn('Attempted to destroy non-existent session', { sessionId });
      return;
    }

    this.callIndex.delete(session.callId);
    this.sessions.delete(sessionId);

    log.info('Session destroyed', {
      sessionId,
      callId: session.callId,
      durationMs: Date.now() - session.startedAt,
      transcriptTurns: session.transcriptHistory.length,
    });
  }

  list(): CallSession[] {
    return Array.from(this.sessions.values());
  }

  count(): number {
    return this.sessions.size;
  }

  /** Return sessions that have been idle longer than `maxIdleMs`. */
  findIdle(maxIdleMs: number): CallSession[] {
    const cutoff = Date.now() - maxIdleMs;
    return this.list().filter((s) => s.lastActivityAt < cutoff);
  }
}
