/**
 * PreferenceChangeDetector: identifies when a user is correcting a previously
 * stated preference (BHK, budget) and extracts the new value.
 *
 * Detection rules:
 *  - First mention  → always captured (no existing value to compare against)
 *  - Conflicting value + correction signal → SESSION_FIELD_UPDATED
 *  - Conflicting value with no correction signal → ignored (likely a question,
 *    e.g. "3 BHK mein price kya hai?" shouldn't overwrite a 2 BHK preference)
 *
 * Correction signals (English + Hindi/Hinglish):
 *   actually, instead, change, rather, updated
 *   nahi, badal gaya, ab, correction, alag
 */

// ─── Patterns ────────────────────────────────────────────────────────────────

const CORRECTION_PATTERN =
  /\b(actually|instead|change|rather|updated|nahi|nahiin|nai|badal\s*gaya|badal\s*gayi|ab\s+(?:mujhe|chahiye|dekh\s+raha|dekh\s+rahi)|correction|alag)\b/i;

const BHK_PATTERN = /(2\.5|2|3)\s*bhk/i;

const BUDGET_PATTERNS: RegExp[] = [
  // "50 lakh", "1.5 crore", "80 lakh se 1 crore"
  /(\d+(?:\.\d+)?(?:\s*[-–to]+\s*\d+(?:\.\d+)?)?)\s*(lakh|lac|lakhs|crore|crores|cr)\b/i,
  // "budget: 80L", "around 80L"
  /(?:budget|range)[\s:]+(?:around\s+)?(\d+(?:\.\d+)?)\s*(l|cr)\b/i,
];

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PreferenceChange {
  field: 'bhk' | 'budget';
  oldValue: string;
  newValue: string;
}

export interface ChangeDetectionResult {
  /** True if a recognized correction keyword was present in the utterance. */
  hasCorrection: boolean;
  /** Preference changes to apply (only populated when hasCorrection is true for conflicting values). */
  changes: PreferenceChange[];
  /** New BHK value extracted from text (null if not mentioned). */
  newBhk: string | null;
  /** New budget value extracted from text (null if not mentioned). */
  newBudget: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract BHK value from text.
 *
 * When a correction signal is present the utterance often reads:
 * "2 BHK nahi, 3 BHK chahiye" — the old value comes first, the new one last.
 * We return the LAST BHK match so corrections resolve to the intended new value.
 * Without a correction signal, first-mention wins (normal capture).
 */
function extractBhk(text: string, preferLast: boolean): string | null {
  const globalPattern = /(2\.5|2|3)\s*bhk/gi;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = globalPattern.exec(text)) !== null) {
    matches.push(`${m[1]} BHK`);
  }
  if (matches.length === 0) return null;
  return preferLast ? matches[matches.length - 1] : matches[0];
}

/**
 * Extract budget value from text, returning the LAST match when preferLast
 * is true (same correction-ordering logic as BHK).
 */
function extractBudget(text: string, preferLast: boolean): string | null {
  for (const pat of BUDGET_PATTERNS) {
    const globalPat = new RegExp(pat.source, pat.flags.includes('g') ? pat.flags : pat.flags + 'g');
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = globalPat.exec(text)) !== null) {
      matches.push(`${m[1]} ${m[2]}`.trim());
    }
    if (matches.length > 0) {
      return preferLast ? matches[matches.length - 1] : matches[0];
    }
  }
  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Analyse a user utterance for preference corrections.
 *
 * @param text          The raw transcript.
 * @param currentBhk    The BHK preference already stored in session (or null).
 * @param currentBudget The budget already stored in session (or null).
 */
export function detectPreferenceChanges(
  text: string,
  currentBhk: string | null,
  currentBudget: string | null,
): ChangeDetectionResult {
  const hasCorrection = CORRECTION_PATTERN.test(text);
  const changes: PreferenceChange[] = [];

  // When correcting, the new value is usually stated LAST ("2 BHK nahi, 3 BHK chahiye")
  const newBhk = extractBhk(text, hasCorrection);
  if (newBhk && currentBhk && currentBhk !== newBhk && hasCorrection) {
    changes.push({ field: 'bhk', oldValue: currentBhk, newValue: newBhk });
  }

  const newBudget = extractBudget(text, hasCorrection);
  if (newBudget && currentBudget && currentBudget !== newBudget && hasCorrection) {
    changes.push({ field: 'budget', oldValue: currentBudget, newValue: newBudget });
  }

  return { hasCorrection, changes, newBhk, newBudget };
}
