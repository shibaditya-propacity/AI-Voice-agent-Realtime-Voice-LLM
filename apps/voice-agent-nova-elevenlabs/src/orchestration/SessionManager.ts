/**
 * SessionManager: tracks all active CallOrchestrator instances.
 * Handles idle eviction and graceful teardown.
 */

import { CallOrchestrator } from './CallOrchestrator';
import { TwilioService } from '../telephony/TwilioService';
import { Logger } from '../shared/logger';
import { Env } from '../config/env';

interface SessionEntry {
  orchestrator: CallOrchestrator;
  startedAt: number;
  lastActivityAt: number;
}

const log = Logger.root('SessionManager');

export class SessionManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly twilioService: TwilioService;
  private readonly evictionTimer: ReturnType<typeof setInterval>;

  constructor(twilioService: TwilioService) {
    this.twilioService = twilioService;

    // Evict sessions that have been idle for SESSION_IDLE_TIMEOUT_MS
    this.evictionTimer = setInterval(() => this.evictIdleSessions(), 60_000);
  }

  // ─── Session Lifecycle ────────────────────────────────────────────────────

  async onCallStarted(callSid: string): Promise<void> {
    if (this.sessions.has(callSid)) {
      log.warn('Session already exists for call', { callSid });
      return;
    }

    if (this.sessions.size >= Env.session.maxConcurrentCalls) {
      log.warn('Max concurrent calls reached, rejecting new call', {
        callSid,
        maxCalls: Env.session.maxConcurrentCalls,
        active: this.sessions.size,
      });
      return;
    }

    log.info('Starting new session', { callSid, activeSessions: this.sessions.size + 1 });

    const orchestrator = new CallOrchestrator(callSid, this.twilioService);
    this.sessions.set(callSid, {
      orchestrator,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
    });

    orchestrator.start();
  }

  handleInboundAudio(callSid: string, audioBase64: string): void {
    const entry = this.sessions.get(callSid);
    if (!entry) return;

    entry.lastActivityAt = Date.now();
    entry.orchestrator.handleInboundAudio(audioBase64);
  }

  async endSession(callSid: string, reason: string): Promise<void> {
    const entry = this.sessions.get(callSid);
    if (!entry) {
      log.debug('No session to end', { callSid });
      return;
    }

    log.info('Ending session', { callSid, reason });
    this.sessions.delete(callSid);

    try {
      await entry.orchestrator.end();
    } catch (err) {
      log.error('Error ending orchestrator', err as Error, { callSid });
    }
  }

  // ─── Idle Eviction ────────────────────────────────────────────────────────

  private evictIdleSessions(): void {
    const now = Date.now();
    for (const [callSid, entry] of this.sessions.entries()) {
      if (now - entry.lastActivityAt > Env.session.idleTimeoutMs) {
        log.warn('Evicting idle session', { callSid, idleMs: now - entry.lastActivityAt });
        void this.endSession(callSid, 'idle_timeout');
      }
    }
  }

  // ─── Graceful Shutdown ────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    clearInterval(this.evictionTimer);
    log.info('Shutting down all sessions', { count: this.sessions.size });

    const callSids = Array.from(this.sessions.keys());
    await Promise.all(callSids.map((id) => this.endSession(id, 'server_shutdown')));
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  get activeCount(): number { return this.sessions.size; }

  getState(callSid: string): string | null {
    return this.sessions.get(callSid)?.orchestrator.currentState ?? null;
  }
}
