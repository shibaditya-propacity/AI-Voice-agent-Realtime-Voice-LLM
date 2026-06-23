/**
 * ConversationMemory: per-call memory that tracks what the caller has asked,
 * what the agent has answered, and conversation engagement signals.
 *
 * Used to:
 *  - Avoid repeated answers to the same topic
 *  - Avoid repeated visit invitations
 *  - Avoid re-handling the same objection
 *  - Gate visit invitations on interest score
 *  - Track conversation quality metrics
 */

import { Intent } from '../intent/IntentClassifier';
import { ObjectionType } from './CommonObjections';

// ─── Interest Score Config ──────────────────────────────────────────────────

/** Points awarded per intent type for interest scoring. */
const INTEREST_POINTS: Partial<Record<Intent, number>> = {
  [Intent.PRICE]:      1,
  [Intent.AMENITIES]:  1,
  [Intent.LOCATION]:   1,
  [Intent.POSSESSION]: 1,
  [Intent.DEVELOPER]:  1,
  [Intent.BHK]:        1,
  [Intent.UNITS]:      1,
};

/** Minimum interest score before a visit invitation is allowed. */
const VISIT_INVITE_THRESHOLD = 3;

// ─── Conversation Memory ────────────────────────────────────────────────────

export class ConversationMemory {
  /** Set of intents the caller has asked about (deduped). */
  private readonly questionsAsked: Set<Intent> = new Set();

  /** Set of objection types the caller has raised (deduped). */
  private readonly objectionsRaised: Set<ObjectionType> = new Set();

  /** How many times a visit invitation has been shown this call. */
  private visitInvitesShown = 0;

  /** Running interest score. */
  private _interestScore = 0;

  /** Last intent classified. */
  private _lastIntent: Intent = Intent.UNKNOWN;

  /** Last topic that was answered with a local response. */
  private _lastAnsweredTopic: Intent | null = null;

  /** Total turns processed. */
  private _turnCount = 0;

  // ─── Recording ──────────────────────────────────────────────────────

  /**
   * Record that the caller asked about a specific intent.
   * Awards interest points on first occurrence.
   */
  recordQuestion(intent: Intent): void {
    this._lastIntent = intent;
    this._turnCount++;

    if (!this.questionsAsked.has(intent)) {
      this.questionsAsked.add(intent);
      const points = INTEREST_POINTS[intent] ?? 0;
      this._interestScore += points;
    }
  }

  /** Record that a local response was given for this topic. */
  recordAnswered(intent: Intent): void {
    this._lastAnsweredTopic = intent;
  }

  /** Record that an objection was raised. */
  recordObjection(objection: ObjectionType): void {
    this.objectionsRaised.add(objection);
    this._turnCount++;
  }

  /** Record that a visit invitation was shown. */
  recordVisitInvite(): void {
    this.visitInvitesShown++;
  }

  // ─── Queries ────────────────────────────────────────────────────────

  /** Has the caller already asked about this intent? */
  hasAsked(intent: Intent): boolean {
    return this.questionsAsked.has(intent);
  }

  /** Has this specific objection already been handled? */
  hasHandledObjection(objection: ObjectionType): boolean {
    return this.objectionsRaised.has(objection);
  }

  /** Is the caller engaged enough for a visit invitation? */
  isReadyForVisitInvite(): boolean {
    return (
      this._interestScore >= VISIT_INVITE_THRESHOLD &&
      this.visitInvitesShown === 0
    );
  }

  /** Has a visit invitation already been shown this call? */
  hasShownVisitInvite(): boolean {
    return this.visitInvitesShown > 0;
  }

  /**
   * Is this a repeated question about the same topic as the last answer?
   * Used to avoid giving the exact same response twice in a row.
   */
  isRepeatQuestion(intent: Intent): boolean {
    return this._lastAnsweredTopic === intent;
  }

  // ─── Accessors ──────────────────────────────────────────────────────

  get interestScore(): number { return this._interestScore; }
  get lastIntent(): Intent { return this._lastIntent; }
  get lastAnsweredTopic(): Intent | null { return this._lastAnsweredTopic; }
  get turnCount(): number { return this._turnCount; }
  get uniqueQuestionsCount(): number { return this.questionsAsked.size; }
  get uniqueObjectionsCount(): number { return this.objectionsRaised.size; }
  get visitInviteCount(): number { return this.visitInvitesShown; }

  // ─── Metrics Snapshot ───────────────────────────────────────────────

  getSnapshot(): Record<string, unknown> {
    return {
      questionsAsked: [...this.questionsAsked],
      objectionsRaised: [...this.objectionsRaised],
      interestScore: this._interestScore,
      visitInvitesShown: this.visitInvitesShown,
      lastIntent: this._lastIntent,
      lastAnsweredTopic: this._lastAnsweredTopic,
      turnCount: this._turnCount,
    };
  }
}
