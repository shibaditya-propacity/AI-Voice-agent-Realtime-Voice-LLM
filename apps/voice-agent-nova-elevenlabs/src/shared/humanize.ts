/**
 * Context-aware conversational acknowledgements.
 *
 * Instead of randomly prepending fillers, we classify the last user utterance
 * and add a single, natural acknowledgement only when conversationally appropriate:
 *   - User provides information  → "Got it", "Okay"
 *   - User agrees / confirms     → "Great", "Sure"
 *   - User shares a preference   → "Right", "Thik hain"
 *
 * Factual questions and greetings get no acknowledgement.
 * Never more than one acknowledgement per response.
 */

// ── Classification patterns ──────────────────────────────────────────────────

/** User is asking a question — answer directly, no filler needed. */
const QUESTION_PATTERNS = [
  /^(what|when|where|which|who|how|why|is\s|are\s|do\s|does\s|can\s|will\s|kya\s|kab\s|kaise\s|kitna|kitne|kitni|konsa|konsi)/i,
  /\?\s*$/,
];

/** User is providing information (name, budget, date, BHK preference, etc.). */
const INFO_PATTERNS = [
  /\b(my name|mera naam|i am|main|i'm)\b/i,
  /\b(budget|lakh|lakhs|crore|crores)\b/i,
  /\b(bhk|bedroom|room)\b/i,
  /\b\d+\s*(lakh|lakhs|crore|crores|k)\b/i,
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b(morning|afternoon|evening|shaam|subah|dopahar)\b/i,
  /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
  /\b\d{1,2}[\s/-]\d{1,2}/,  // date-like patterns
];

/** User is confirming or agreeing. */
const CONFIRMATION_PATTERNS = [
  /^(yes|yeah|yep|yup|okay|ok|haan|ha|ji|theek|thik|sure|right|correct|sahi|bilkul|done|pakka)\b/i,
  /\b(works|works for me|that's fine|sounds good|chalega|chalta hai|ho jayega)\b/i,
];

/** User is sharing a preference. */
const PREFERENCE_PATTERNS = [
  /\b(i want|i need|i prefer|mujhe|chahiye|pasand|prefer)\b/i,
  /\b(interested in|looking for|dekh raha|dekh rahi)\b/i,
];

// ── Acknowledgement pools per intent ────────────────────────────────────────

const ACK_INFO         = ['Got it', 'Okay'] as const;
const ACK_CONFIRMATION = ['Great'] as const;
const ACK_PREFERENCE   = ['Right'] as const;

type UserIntent = 'question' | 'info' | 'confirmation' | 'preference' | 'other';

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(text));
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Classify user utterance intent. */
export function classifyUserIntent(userText: string): UserIntent {
  const trimmed = userText.trim();
  if (!trimmed) return 'other';

  // Questions first — they should never get an acknowledgement
  if (matchesAny(trimmed, QUESTION_PATTERNS)) return 'question';

  // Short confirmations (≤4 words) are almost always agreements
  if (trimmed.split(/\s+/).length <= 4 && matchesAny(trimmed, CONFIRMATION_PATTERNS)) {
    return 'confirmation';
  }

  // Information sharing
  if (matchesAny(trimmed, INFO_PATTERNS)) return 'info';

  // Preferences
  if (matchesAny(trimmed, PREFERENCE_PATTERNS)) return 'preference';

  // Longer confirmations
  if (matchesAny(trimmed, CONFIRMATION_PATTERNS)) return 'confirmation';

  return 'other';
}

/**
 * Returns a contextually appropriate acknowledgement for the given user message,
 * or empty string if no acknowledgement is warranted.
 *
 * Replaces the old random-opener approach with intent-based logic.
 */
export function maybeGetOpener(lastUserText?: string): string {
  if (!lastUserText) return '';

  const intent = classifyUserIntent(lastUserText);

  switch (intent) {
    case 'info':          return pick(ACK_INFO) + '. ';
    case 'confirmation':  return pick(ACK_CONFIRMATION) + '. ';
    case 'preference':    return pick(ACK_PREFERENCE) + '. ';
    case 'question':      return '';
    case 'other':         return '';
  }
}

/**
 * @deprecated Use maybeGetOpener(lastUserText) instead.
 * Kept for backward-compat; applies acknowledgement to already-generated text.
 */
export function humanizeResponse(text: string, lastUserText?: string): string {
  if (!text || text.length < 10) return text;
  const opener = maybeGetOpener(lastUserText);
  if (!opener) return text;
  return opener + text;
}
