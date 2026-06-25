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

const CORRECTION_PATTERN =
  /\b(actually|instead|change|rather|updated|nahi|nahiin|nai|badal\s*gaya|badal\s*gayi|ab\s+(?:mujhe|chahiye|dekh\s+raha|dekh\s+rahi)|correction|alag)\b/i;

// \b doesn't work after Hindi chars (\W in JS) — use lookahead instead.
const UNIT_END = '(?=[\\s,।]|$)';
const BUDGET_PATTERNS: RegExp[] = [
  new RegExp(`(\\d+(?:\\.\\d+)?(?:\\s*[-–to]+\\s*\\d+(?:\\.\\d+)?)?)\\s*(lakh|lac|lakhs|crore|crores|cr)${UNIT_END}`, 'i'),
  new RegExp(`(?:budget|range)[\\s:]+(?:around\\s*)?(\\d+(?:\\.\\d+)?)\\s*(l|cr)${UNIT_END}`, 'i'),
];

export interface PreferenceChange {
  field: 'bhk' | 'budget';
  oldValue: string;
  newValue: string;
}

export interface ChangeDetectionResult {
  hasCorrection: boolean;
  changes: PreferenceChange[];
  newBhk: string | null;
  newBudget: string | null;
}

/**
 * Extract BHK value from text.
 * When correcting, old value comes first → return LAST match.
 * On first mention, return first match.
 */
const HINDI_BHK: Record<string, string> = { 'दो': '2', 'ढाई': '2.5', 'तीन': '3' };

function extractBhk(text: string, preferLast: boolean): string | null {
  const matches: string[] = [];
  let m: RegExpExecArray | null;

  // Digit form: "2 BHK", "2.5 BHK", "3 BHK"
  const digitPat = /(2\.5|2|3)\s*bhk/gi;
  while ((m = digitPat.exec(text)) !== null) matches.push(`${m[1]} BHK`);

  // Hindi word form: "दो bhk", "तीन bhk", "ढाई bhk"
  const hindiPat = /(दो|ढाई|तीन)\s*bhk/gi;
  while ((m = hindiPat.exec(text)) !== null) {
    const digit = HINDI_BHK[m[1]];
    if (digit) matches.push(`${digit} BHK`);
  }

  if (matches.length === 0) return null;
  return preferLast ? matches[matches.length - 1] : matches[0];
}

/**
 * Extract budget value from text, returning LAST match when preferLast is true.
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

export function detectPreferenceChanges(
  text: string,
  currentBhk: string | null,
  currentBudget: string | null,
): ChangeDetectionResult {
  const hasCorrection = CORRECTION_PATTERN.test(text);
  const changes: PreferenceChange[] = [];

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
