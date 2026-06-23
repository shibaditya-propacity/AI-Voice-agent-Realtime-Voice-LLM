/**
 * ConversationMemory: tracks what the caller has asked about, objections raised,
 * and how engaged they are — used to decide when to pitch a site visit.
 *
 * Ported to use FactIntent from KnowledgeRouter (Sarvam infra).
 */

import type { FactIntent } from '../llm/KnowledgeRouter';
import type { ObjectionType } from './CommonObjections';

// ─── Interest Score Points ──────────────────────────────────────────────────

/**
 * Points awarded when the caller asks about a specific topic.
 * Higher points = stronger buying signal.
 */
const INTEREST_POINTS: Partial<Record<FactIntent, number>> = {
  PRICE: 3,
  AMENITIES: 2,
  LOCATION: 2,
  POSSESSION: 3,
  BUILDER: 2,
  BHK: 3,
  UNITS: 1,
};

// ─── Thresholds ─────────────────────────────────────────────────────────────

/** Minimum interest score before we start suggesting site visits. */
const VISIT_INVITE_THRESHOLD = 3;

// ─── Memory Class ───────────────────────────────────────────────────────────

export class ConversationMemory {
  /** Set of fact intents the caller has asked about. */
  readonly questionsAsked: Set<FactIntent> = new Set();

  /** Set of objection types the caller has raised. */
  readonly objectionsRaised: Set<ObjectionType> = new Set();

  /** Cumulative interest score. */
  private _interestScore = 0;

  /** How many times we've shown a visit invite. */
  private _visitInvitesShown = 0;

  // ── Getters ─────────────────────────────────────────────────────────────

  get interestScore(): number {
    return this._interestScore;
  }

  get visitInvitesShown(): number {
    return this._visitInvitesShown;
  }

  // ── Recording ───────────────────────────────────────────────────────────

  /**
   * Record that the caller asked about a fact intent.
   * Awards interest points on first occurrence only.
   */
  recordQuestion(intent: FactIntent): void {
    if (!this.questionsAsked.has(intent)) {
      this.questionsAsked.add(intent);
      const points = INTEREST_POINTS[intent] ?? 1;
      this._interestScore += points;
    }
  }

  /**
   * Record that the caller raised an objection.
   */
  recordObjection(type: ObjectionType): void {
    this.objectionsRaised.add(type);
  }

  /**
   * Record that we showed a visit invite.
   */
  recordVisitInvite(): void {
    this._visitInvitesShown++;
  }

  // ── Decision Helpers ────────────────────────────────────────────────────

  /**
   * Whether the caller's interest score is high enough to suggest a visit.
   */
  shouldSuggestVisit(): boolean {
    return this._interestScore >= VISIT_INVITE_THRESHOLD;
  }

  /**
   * Whether we've already shown too many visit invites (max 3).
   */
  hasExhaustedVisitInvites(): boolean {
    return this._visitInvitesShown >= 3;
  }

  /**
   * Returns a summary of the conversation memory for debugging.
   */
  toSummary(): {
    questionsAsked: FactIntent[];
    objectionsRaised: ObjectionType[];
    interestScore: number;
    visitInvitesShown: number;
  } {
    return {
      questionsAsked: [...this.questionsAsked],
      objectionsRaised: [...this.objectionsRaised],
      interestScore: this._interestScore,
      visitInvitesShown: this._visitInvitesShown,
    };
  }
}
