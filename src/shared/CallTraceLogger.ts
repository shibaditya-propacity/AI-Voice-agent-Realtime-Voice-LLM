/**
 * CallTraceLogger: per-call JSONL event trace with latency gap analysis.
 *
 * Writes one file per call to logs/calls/<callId>.jsonl. Every trace entry
 * includes ts, delta (ms since call start), callId, sessionId, conversation
 * state, and event-specific data. At call end, prints the top 10 largest
 * inter-event gaps to diagnose where latency lives.
 *
 * Usage (singleton — follows the latencyRegistry pattern):
 *
 *   import { callTrace } from '../../shared/CallTraceLogger';
 *
 *   callTrace.start(callId, sessionId, { callerNumber });
 *   callTrace.event(callId, sessionId, 'greeting.play.start', { bytes: 48000 });
 *   callTrace.eventOnce(callId, sessionId, 'caller.audio.first', { seqNum: 1 });
 *   callTrace.setState(callId, 'AI_SPEAKING');
 *   callTrace.end(callId, { reason: 'hangup', durationMs: 45000 });
 */

import fs from 'fs';
import path from 'path';
import { Logger } from './Logger';

const TRACE_DIR = path.join(process.cwd(), 'logs', 'calls');
const log = Logger.root('CallTrace');

interface TraceEntry {
  ts: number;
  delta: number;
  callId: string;
  sessionId: string;
  event: string;
  state: string;
  data?: Record<string, unknown>;
}

interface ActiveCall {
  callId: string;
  sessionId: string;
  startedAt: number;
  state: string;
  entries: TraceEntry[];
  /** Guards eventOnce() — each name fires at most once per call. */
  fired: Set<string>;
}

class CallTraceLogger {
  private readonly calls = new Map<string, ActiveCall>();
  private dirReady = false;

  private ensureDir(): void {
    if (this.dirReady) return;
    try {
      fs.mkdirSync(TRACE_DIR, { recursive: true });
      this.dirReady = true;
    } catch (err) {
      log.warn('Failed to create trace directory', {
        dir: TRACE_DIR,
        error: (err as Error).message,
      });
    }
  }

  /** Begin tracing a new call. Emits `call.started` automatically. */
  start(callId: string, sessionId: string, data?: Record<string, unknown>): void {
    if (this.calls.has(callId)) return;
    this.ensureDir();
    this.calls.set(callId, {
      callId,
      sessionId,
      startedAt: Date.now(),
      state: 'SETUP',
      entries: [],
      fired: new Set(),
    });
    this.event(callId, sessionId, 'call.started', data);
  }

  /** Record a trace event. No-op if the call has not been started. */
  event(
    callId: string,
    sessionId: string,
    name: string,
    data?: Record<string, unknown>,
  ): void {
    const call = this.calls.get(callId);
    if (!call) return;
    const ts = Date.now();
    const entry: TraceEntry = {
      ts,
      delta: ts - call.startedAt,
      callId,
      sessionId,
      event: name,
      state: call.state,
    };
    if (data && Object.keys(data).length > 0) entry.data = data;
    call.entries.push(entry);
    this.writeLine(callId, entry);
  }

  /**
   * Record a trace event at most once per call for the given name.
   * Returns true if the event fired, false if it was already recorded.
   */
  eventOnce(
    callId: string,
    sessionId: string,
    name: string,
    data?: Record<string, unknown>,
  ): boolean {
    const call = this.calls.get(callId);
    if (!call || call.fired.has(name)) return false;
    call.fired.add(name);
    this.event(callId, sessionId, name, data);
    return true;
  }

  /** Update the conversation state shown in subsequent trace entries. */
  setState(callId: string, state: string): void {
    const call = this.calls.get(callId);
    if (call) call.state = state;
  }

  /** Finalize the call trace: emit `call.ended`, print summary, flush. */
  end(callId: string, data?: Record<string, unknown>): void {
    const call = this.calls.get(callId);
    if (!call) return;
    this.event(callId, call.sessionId, 'call.ended', data);
    this.printSummary(call);
    this.calls.delete(callId);
  }

  /** Flush all in-progress traces (called on process shutdown). */
  dispose(): void {
    for (const [callId, call] of this.calls) {
      this.event(callId, call.sessionId, 'call.disposed', {
        reason: 'process-shutdown',
      });
      this.printSummary(call);
    }
    this.calls.clear();
  }

  // ─── File I/O ──────────────────────────────────────────────────────────────

  private writeLine(callId: string, entry: TraceEntry): void {
    try {
      const filePath = path.join(TRACE_DIR, `${callId}.jsonl`);
      fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
    } catch {
      // Swallow — trace is best-effort, must never affect the call.
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────────────

  private printSummary(call: ActiveCall): void {
    const { entries, callId, sessionId } = call;
    if (entries.length < 2) return;

    const sorted = [...entries].sort((a, b) => a.ts - b.ts);

    // Calculate gaps between consecutive events.
    const gaps: Array<{ from: string; to: string; gapMs: number }> = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push({
        from: sorted[i - 1].event,
        to: sorted[i].event,
        gapMs: sorted[i].ts - sorted[i - 1].ts,
      });
    }

    // Top 10 largest gaps.
    gaps.sort((a, b) => b.gapMs - a.gapMs);
    const top10 = gaps.slice(0, 10);

    const totalMs = sorted[sorted.length - 1].ts - sorted[0].ts;

    log.info(
      `CALL TRACE SUMMARY — ${callId} (${(totalMs / 1000).toFixed(1)}s, ${entries.length} events)`,
      {
        sessionId,
        callId,
        totalMs,
        eventCount: entries.length,
        file: path.join(TRACE_DIR, `${callId}.jsonl`),
        top10Gaps: top10.map(
          (g, i) =>
            `${String(i + 1).padStart(2)}. ${String(g.gapMs).padStart(5)}ms  ${g.from} → ${g.to}`,
        ),
      },
    );
  }
}

export const callTrace = new CallTraceLogger();
