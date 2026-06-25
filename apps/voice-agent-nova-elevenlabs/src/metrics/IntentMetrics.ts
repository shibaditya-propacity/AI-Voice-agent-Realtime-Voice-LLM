/**
 * IntentMetrics: tracks intent classification statistics for a single call.
 *
 * Captures routing decisions (local vs LLM), classification latency,
 * objection playbook usage, and visit invite triggers. Logged as a summary
 * at call end for analytics and tuning.
 */

import type { FactIntent } from '../llm/KnowledgeRouter';
import { Logger } from '../shared/logger';

export type IntentLabel = FactIntent | 'OBJECTION' | 'UNKNOWN';

export interface IntentStats {
  routedLocal: number;
  routedLLM: number;
  objectionPlaybooksUsed: number;
  visitInvitesTriggered: number;
  multiIntentDetected: number;
  multiIntentTotalCount: number;
  totalClassificationTimeUs: number;
  avgClassificationTimeUs: number;
  distribution: Record<string, number>;
}

export class IntentMetrics {
  private readonly log: Logger;

  private routedLocal = 0;
  private routedLLM = 0;
  private objectionPlaybooksUsed = 0;
  private visitInvitesTriggered = 0;
  private multiIntentDetected = 0;
  private multiIntentTotalCount = 0;
  private totalClassificationTimeUs = 0;
  private totalClassifications = 0;
  private readonly distribution = new Map<IntentLabel, number>();

  constructor(callSid: string) {
    this.log = Logger.forCall(callSid, 'IntentMetrics');
  }

  /**
   * Record a single intent classification event.
   *
   * @param intent               The classified intent label
   * @param routed               Whether the query was handled locally or sent to LLM
   * @param classificationTimeUs Time taken to classify, in microseconds
   */
  record(
    intent: IntentLabel,
    routed: 'local' | 'llm',
    classificationTimeUs: number,
  ): void {
    if (routed === 'local') {
      this.routedLocal++;
    } else {
      this.routedLLM++;
    }

    if (intent === 'OBJECTION') {
      this.objectionPlaybooksUsed++;
    }

    this.totalClassificationTimeUs += classificationTimeUs;
    this.totalClassifications++;

    const current = this.distribution.get(intent) ?? 0;
    this.distribution.set(intent, current + 1);

    this.log.debug('INTENT_RECORDED', {
      intent,
      routed,
      classificationTimeUs,
    });
  }

  /** Record that a multi-intent query was handled. */
  recordMultiIntent(count: number): void {
    this.multiIntentDetected++;
    this.multiIntentTotalCount += count;
    this.log.info('MultiIntentDetected', { count, totalEvents: this.multiIntentDetected });
  }

  /** Record that a visit invite was triggered during this call. */
  recordVisitInvite(): void {
    this.visitInvitesTriggered++;
    this.log.debug('VISIT_INVITE_TRIGGERED', {
      total: this.visitInvitesTriggered,
    });
  }

  /** Log a human-readable summary at the end of the call. */
  logCallSummary(): void {
    const stats = this.getStats();
    this.log.info('INTENT_CALL_SUMMARY', {
      routedLocal: stats.routedLocal,
      routedLLM: stats.routedLLM,
      objectionPlaybooksUsed: stats.objectionPlaybooksUsed,
      visitInvitesTriggered: stats.visitInvitesTriggered,
      MULTI_INTENT_DETECTED: stats.multiIntentDetected,
      MULTI_INTENT_COUNT: stats.multiIntentTotalCount,
      avgClassificationTimeUs: stats.avgClassificationTimeUs,
      totalClassifications: this.totalClassifications,
      distribution: stats.distribution,
    });
  }

  /** Return a snapshot of current metrics. */
  getStats(): IntentStats {
    const distribution: Record<string, number> = {};
    for (const [label, count] of this.distribution) {
      distribution[label] = count;
    }

    return {
      routedLocal: this.routedLocal,
      routedLLM: this.routedLLM,
      objectionPlaybooksUsed: this.objectionPlaybooksUsed,
      visitInvitesTriggered: this.visitInvitesTriggered,
      multiIntentDetected: this.multiIntentDetected,
      multiIntentTotalCount: this.multiIntentTotalCount,
      totalClassificationTimeUs: this.totalClassificationTimeUs,
      avgClassificationTimeUs:
        this.totalClassifications > 0
          ? Math.round(this.totalClassificationTimeUs / this.totalClassifications)
          : 0,
      distribution,
    };
  }
}
