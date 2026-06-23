/**
 * Humanizer: controlled conversational acknowledgements.
 *
 * Adds natural fillers to 5–10% of responses to sound human.
 *
 * Rules:
 *  - Only one filler per response.
 *  - Never every turn — uses a cooldown of 5 turns minimum.
 *  - Never on first turn.
 *  - Never on questions (only on information/confirmation inputs).
 *  - No artificial pauses.
 */

// ─── Filler Pool ────────────────────────────────────────────────────────────

const ACKNOWLEDGEMENTS = [
  'Ji.',
  'Bilkul.',
  'Samajh gaya.',
  'Haan.',
  'Achha.',
] as const;

// ─── Input Classification ───────────────────────────────────────────────────

/** User is asking a question — no acknowledgement needed. */
const QUESTION_PATTERN = /^(what|when|where|which|who|how|why|is\s|are\s|do\s|does\s|can\s|will\s|kya\s|kab\s|kaise\s|kitna|kitne|kitni|konsa|konsi)|\?\s*$/i;

/** User is providing information or confirming. */
const INFO_CONFIRM_PATTERN = /\b(my name|mera naam|i am|main|budget|lakh|crore|bhk|bedroom|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|yes|yeah|sure|okay|ok|haan|theek|bilkul|done|pakka)\b/i;

// ─── Humanizer ──────────────────────────────────────────────────────────────

export class Humanizer {
  /** Turn number of the last acknowledgement. */
  private lastAckTurn = -10;

  /** Minimum turns between acknowledgements. */
  private readonly MIN_COOLDOWN = 5;

  /** Current turn counter. */
  private turnCount = 0;

  /**
   * Maybe prepend a natural acknowledgement to a response.
   *
   * Returns the acknowledgement string (e.g. "Ji. ") or empty string.
   * The caller prepends this to the response text.
   */
  maybeAcknowledge(userText: string): string {
    this.turnCount++;

    // Never on the first turn
    if (this.turnCount <= 1) return '';

    // Cooldown — don't acknowledge too frequently
    if (this.turnCount - this.lastAckTurn < this.MIN_COOLDOWN) return '';

    // Don't acknowledge questions
    const trimmed = userText.trim();
    if (QUESTION_PATTERN.test(trimmed)) return '';

    // Only acknowledge info/confirmation inputs
    if (!INFO_CONFIRM_PATTERN.test(trimmed)) return '';

    // 50% chance when eligible — results in ~5-10% of total responses
    if (Math.random() > 0.5) return '';

    this.lastAckTurn = this.turnCount;
    const ack = ACKNOWLEDGEMENTS[this.turnCount % ACKNOWLEDGEMENTS.length];
    return ack + ' ';
  }

  /**
   * Deterministic version for testing — always acknowledges when eligible
   * (no random gate).
   */
  maybeAcknowledgeDeterministic(userText: string): string {
    this.turnCount++;

    if (this.turnCount <= 1) return '';
    if (this.turnCount - this.lastAckTurn < this.MIN_COOLDOWN) return '';

    const trimmed = userText.trim();
    if (QUESTION_PATTERN.test(trimmed)) return '';
    if (!INFO_CONFIRM_PATTERN.test(trimmed)) return '';

    this.lastAckTurn = this.turnCount;
    const ack = ACKNOWLEDGEMENTS[this.turnCount % ACKNOWLEDGEMENTS.length];
    return ack + ' ';
  }
}
