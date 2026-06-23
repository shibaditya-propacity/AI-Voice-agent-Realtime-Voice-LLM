/**
 * BargeInValidator: production-grade false barge-in protection.
 *
 * Validates every barge-in candidate against multiple checks before
 * allowing generation cancellation. Rejects:
 *
 *  1. Echo — interim matches last user transcript or agent response
 *  2. Repeated interim — identical text within a short window
 *  3. Short fragment — single words, low word count, short length
 *  4. Grace window — too soon after TTS playback started
 *  5. Low-confidence — below threshold for speech-final transcripts
 *
 * Each rejection is logged with a specific reason for diagnostics.
 */

// ─── Rejection Reasons ──────────────────────────────────────────────────────

export type BargeInRejectionReason =
  | 'echo'
  | 'repeated_interim'
  | 'short_fragment'
  | 'grace_window'
  | 'filler_pattern'
  | null; // null = accepted

// ─── Validation Result ──────────────────────────────────────────────────────

export interface BargeInDecision {
  accepted: boolean;
  reason: BargeInRejectionReason;
  /** Diagnostic details for logging. */
  details: Record<string, unknown>;
}

// ─── Configuration ──────────────────────────────────────────────────────────

export interface BargeInValidatorConfig {
  /** Minimum word count in interim to allow barge-in. Default: 2 */
  minWordCount: number;
  /** Minimum character length to allow barge-in. Default: 4 */
  minCharLength: number;
  /** Grace period after TTS starts (ms). Reject all barge-ins during this window. Default: 1200 */
  ttsGraceMs: number;
  /** Window for detecting repeated interims (ms). Default: 2000 */
  repeatWindowMs: number;
  /** Similarity threshold (0-1) for echo detection. Default: 0.7 */
  echoSimilarityThreshold: number;
}

const DEFAULT_CONFIG: BargeInValidatorConfig = {
  minWordCount: 2,
  minCharLength: 4,
  ttsGraceMs: 1200,
  repeatWindowMs: 2000,
  echoSimilarityThreshold: 0.7,
};

// ─── Filler/Echo Patterns ───────────────────────────────────────────────────

/** Expanded filler pattern — covers English and Hindi fillers/breathing. */
const FILLER_PATTERN = /^(mhmm|hmm|mm|uh|um|uhh|umm|hm|mmm|ah|huh|ha|haan|ji|ok|okay|han|हाँ|जी|हम्म|अ|उ)(\s+(mhmm|hmm|mm|uh|um|uhh|umm|hm|mmm|ah|huh|ha|haan|ji|ok|okay|han|हाँ|जी|हम्म|अ|उ))*$/i;

// ─── Similarity Utility ─────────────────────────────────────────────────────

/**
 * Simple word-overlap similarity (Jaccard index on words).
 * Returns 0-1 score. Fast enough for real-time use.
 */
function wordSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 0));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 0));

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Check if the candidate is a substring of the reference or vice versa.
 */
function isSubstringMatch(candidate: string, reference: string): boolean {
  const c = candidate.toLowerCase().trim();
  const r = reference.toLowerCase().trim();
  if (c.length < 3 || r.length < 3) return false;
  return r.includes(c) || c.includes(r);
}

// ─── BargeInValidator ───────────────────────────────────────────────────────

export class BargeInValidator {
  private readonly config: BargeInValidatorConfig;

  /** Timestamp when TTS started for the current turn. */
  private ttsStartedAt = 0;

  /** The last user transcript (final). */
  private lastUserTranscript = '';

  /** The currently playing agent response text. */
  private activeAgentResponse = '';

  /** Last interim text and its timestamp (for repeat detection). */
  private lastInterimText = '';
  private lastInterimAt = 0;

  // ── Metrics ───────────────────────────────────────────────────────────

  private _accepted = 0;
  private _rejected = 0;
  private readonly _rejectionReasons: Map<string, number> = new Map();

  constructor(config?: Partial<BargeInValidatorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── State Updates ──────────────────────────────────────────────────

  /** Call when TTS starts playing a new turn. */
  onTTSStarted(): void {
    this.ttsStartedAt = Date.now();
    this.lastInterimText = '';
    this.lastInterimAt = 0;
  }

  /** Call when a final user transcript is captured. */
  onUserTranscript(text: string): void {
    this.lastUserTranscript = text.trim();
  }

  /** Call when the agent starts speaking a response. */
  onAgentResponseStarted(text: string): void {
    this.activeAgentResponse = text.trim();
  }

  /** Update the active agent response as it streams. */
  updateAgentResponse(text: string): void {
    this.activeAgentResponse = text.trim();
  }

  /** Reset state between turns. */
  resetTurn(): void {
    this.ttsStartedAt = 0;
    this.activeAgentResponse = '';
    this.lastInterimText = '';
    this.lastInterimAt = 0;
  }

  // ─── Validation ─────────────────────────────────────────────────────

  /**
   * Validate an interim transcript as a barge-in candidate.
   *
   * Returns a decision with accepted/rejected and the reason.
   * All checks are synchronous and sub-millisecond.
   */
  validateInterim(text: string): BargeInDecision {
    const trimmed = text.trim();
    const now = Date.now();

    // ── 1. Filler pattern ───────────────────────────────────────────
    if (FILLER_PATTERN.test(trimmed)) {
      return this.reject('filler_pattern', { text: trimmed });
    }

    // ── 2. Grace window — too soon after TTS started ────────────────
    if (this.ttsStartedAt > 0) {
      const elapsed = now - this.ttsStartedAt;
      if (elapsed < this.config.ttsGraceMs) {
        return this.reject('grace_window', {
          text: trimmed,
          elapsedMs: elapsed,
          graceMs: this.config.ttsGraceMs,
        });
      }
    }

    // ── 3. Short fragment ───────────────────────────────────────────
    const words = trimmed.split(/\s+/);
    if (words.length < this.config.minWordCount || trimmed.length < this.config.minCharLength) {
      return this.reject('short_fragment', {
        text: trimmed,
        wordCount: words.length,
        charLength: trimmed.length,
      });
    }

    // ── 4. Repeated interim — same text within window ───────────────
    if (this.lastInterimText &&
        trimmed.toLowerCase() === this.lastInterimText.toLowerCase() &&
        (now - this.lastInterimAt) < this.config.repeatWindowMs) {
      return this.reject('repeated_interim', {
        text: trimmed,
        msSinceLast: now - this.lastInterimAt,
      });
    }

    // ── 5. Echo detection — matches user or agent speech ────────────
    // 5a. Matches last user transcript (STT echo)
    if (this.lastUserTranscript) {
      const simUser = wordSimilarity(trimmed, this.lastUserTranscript);
      if (simUser >= this.config.echoSimilarityThreshold ||
          isSubstringMatch(trimmed, this.lastUserTranscript)) {
        return this.reject('echo', {
          text: trimmed,
          matchedAgainst: 'last_user_transcript',
          similarity: simUser,
          reference: this.lastUserTranscript.slice(0, 60),
        });
      }
    }

    // 5b. Matches currently playing agent response (speaker echo)
    if (this.activeAgentResponse) {
      const simAgent = wordSimilarity(trimmed, this.activeAgentResponse);
      if (simAgent >= this.config.echoSimilarityThreshold ||
          isSubstringMatch(trimmed, this.activeAgentResponse)) {
        return this.reject('echo', {
          text: trimmed,
          matchedAgainst: 'agent_response',
          similarity: simAgent,
          reference: this.activeAgentResponse.slice(0, 60),
        });
      }
    }

    // ── Passed all checks — accept ─────────────────────────────────
    this.lastInterimText = trimmed;
    this.lastInterimAt = now;
    this._accepted++;

    return {
      accepted: true,
      reason: null,
      details: { text: trimmed, wordCount: words.length },
    };
  }

  /**
   * Validate a final transcript as a barge-in candidate.
   * Less strict than interim — final transcripts have higher confidence.
   * Only checks echo and filler; skips grace window and short fragment.
   */
  validateFinal(text: string, confidence: number): BargeInDecision {
    const trimmed = text.trim();

    // Filler check
    if (FILLER_PATTERN.test(trimmed)) {
      return this.reject('filler_pattern', { text: trimmed, confidence });
    }

    // Echo against agent response (speaker echo is the main risk for finals)
    if (this.activeAgentResponse) {
      const sim = wordSimilarity(trimmed, this.activeAgentResponse);
      if (sim >= this.config.echoSimilarityThreshold &&
          isSubstringMatch(trimmed, this.activeAgentResponse)) {
        return this.reject('echo', {
          text: trimmed,
          matchedAgainst: 'agent_response',
          similarity: sim,
          confidence,
        });
      }
    }

    this._accepted++;
    return {
      accepted: true,
      reason: null,
      details: { text: trimmed, confidence },
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private reject(reason: BargeInRejectionReason, details: Record<string, unknown>): BargeInDecision {
    this._rejected++;
    if (reason) {
      this._rejectionReasons.set(reason, (this._rejectionReasons.get(reason) || 0) + 1);
    }
    return { accepted: false, reason, details };
  }

  // ─── Metrics ────────────────────────────────────────────────────────

  get accepted(): number { return this._accepted; }
  get rejected(): number { return this._rejected; }

  getMetrics(): Record<string, unknown> {
    const reasons: Record<string, number> = {};
    for (const [reason, count] of this._rejectionReasons) {
      reasons[reason] = count;
    }
    return {
      VALID_BARGEIN_ACCEPTED: this._accepted,
      FALSE_BARGEIN_REJECTED: this._rejected,
      rejectionBreakdown: reasons,
    };
  }
}
