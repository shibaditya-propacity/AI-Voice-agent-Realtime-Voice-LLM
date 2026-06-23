/**
 * IntentMetrics: per-call and aggregate metrics for intent routing.
 *
 * Tracks:
 *  - INTENT_ROUTED_LOCAL: count of queries handled without LLM
 *  - INTENT_ROUTED_LLM: count of queries sent to LLM
 *  - INTENT_CLASSIFICATION_TIME: avg classification latency (μs)
 *  - INTENT_DISTRIBUTION: count per intent type
 */

import { Intent } from './IntentClassifier';

// ─── Logger Interface ───────────────────────────────────────────────────────

/** Minimal logger interface to avoid pulling in shared/Logger (and its Env dep). */
interface MetricsLogger {
  info(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Default no-op logger. Replaced at construction time when a real logger
 * is available (CallOrchestrator passes one in production).
 */
const NOOP_LOGGER: MetricsLogger = { info: () => {} };

// ─── IntentMetrics ──────────────────────────────────────────────────────────

export class IntentMetrics {
  private readonly log: MetricsLogger;

  private routedLocal = 0;
  private routedLLM = 0;
  private objectionPlaybooksUsed = 0;
  private visitInvitesTriggered = 0;
  private classificationTimesUs: number[] = [];
  private readonly distribution: Map<Intent, number> = new Map();

  constructor(callSid: string, logger?: MetricsLogger) {
    // Lazy-load Logger to avoid test-time Env crashes. In production the
    // caller (CallOrchestrator) passes a real logger.
    if (logger) {
      this.log = logger;
    } else {
      try {
        // Dynamic require avoids pulling Env at import time in tests
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Logger } = require('../../shared/Logger');
        this.log = Logger.forSession(callSid, callSid, 'IntentMetrics');
      } catch {
        this.log = NOOP_LOGGER;
      }
    }
  }

  /** Record a routing decision. */
  record(intent: Intent, routed: 'local' | 'llm', classificationTimeUs: number): void {
    if (routed === 'local') {
      this.routedLocal++;
      // Count objection playbooks
      if (intent === Intent.OBJECTION) {
        this.objectionPlaybooksUsed++;
      }
    } else {
      this.routedLLM++;
    }

    this.classificationTimesUs.push(classificationTimeUs);
    this.distribution.set(intent, (this.distribution.get(intent) || 0) + 1);

    this.log.info('IntentRouted', {
      intent,
      routed,
      classificationTimeUs,
    });
  }

  /** Record a visit invite trigger. */
  recordVisitInvite(): void {
    this.visitInvitesTriggered++;
  }

  /** Log call-level summary. */
  logCallSummary(): void {
    const total = this.routedLocal + this.routedLLM;
    if (total === 0) return;

    const avgClassificationUs = this.classificationTimesUs.length > 0
      ? Math.round(this.classificationTimesUs.reduce((a, b) => a + b, 0) / this.classificationTimesUs.length)
      : 0;

    const localPct = Math.round((this.routedLocal / total) * 100);

    const dist: Record<string, number> = {};
    for (const [intent, count] of this.distribution) {
      dist[intent] = count;
    }

    this.log.info('IntentRoutingSummary', {
      INTENT_ROUTED_LOCAL: this.routedLocal,
      INTENT_ROUTED_LLM: this.routedLLM,
      INTENT_LOCAL_PCT: localPct,
      INTENT_CLASSIFICATION_TIME_AVG_US: avgClassificationUs,
      INTENT_DISTRIBUTION: dist,
      OBJECTION_PLAYBOOK_USED: this.objectionPlaybooksUsed,
      VISIT_INVITE_TRIGGERED: this.visitInvitesTriggered,
      latencySavedEstimateMs: this.routedLocal * 150,
    });
  }

  /** Current stats snapshot (for testing). */
  getStats(): {
    routedLocal: number;
    routedLLM: number;
    objectionPlaybooksUsed: number;
    visitInvitesTriggered: number;
    distribution: Record<string, number>;
  } {
    const dist: Record<string, number> = {};
    for (const [intent, count] of this.distribution) {
      dist[intent] = count;
    }
    return {
      routedLocal: this.routedLocal,
      routedLLM: this.routedLLM,
      objectionPlaybooksUsed: this.objectionPlaybooksUsed,
      visitInvitesTriggered: this.visitInvitesTriggered,
      distribution: dist,
    };
  }
}
