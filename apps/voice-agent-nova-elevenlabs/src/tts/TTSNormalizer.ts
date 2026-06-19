/**
 * TTSNormalizer: minimal, GENERIC text normalization before Sarvam TTS.
 *
 * This layer is deliberately small. It does NOT carry a project-specific
 * pronunciation dictionary (no builder names, no project names, no amenity
 * transliterations). Producing naturally speakable text is the LLM's job —
 * enforced by the system prompt. This normalizer only handles the small set
 * of generic tokens that Sarvam hi-IN reliably mispronounces regardless of
 * which project the model is talking about:
 *
 *   1. Leading conversational fillers (Ahh, Hmm, Umm) — strip them.
 *   2. Unit/size abbreviations the model may still emit (sqft, sq ft).
 *   3. Domain acronyms read letter-by-letter (BHK, EMI, GST, RERA, OC, EV).
 *   4. Punctuation/whitespace cleanup that affects TTS pacing.
 *
 * Proper nouns stay in Latin script — Sarvam pronounces Latin proper nouns
 * acceptably, and the prompt keeps them in English. If the model slips and
 * transliterates a name into Devanagari, Sarvam still reads it phonetically;
 * we do NOT maintain a lookup of every possible spelling to "correct" it.
 */

// ─── Leading filler removal ─────────────────────────────────────────────────
// Strip a leading filler word plus any punctuation/whitespace that trails it
// (e.g. "Hmm...", "Umm, ", "Ahh —"). \b prevents matching inside real words
// (Ahmedabad, Umbrella). Only the leading position is touched.
const LEADING_FILLER =
  /^(?:Ahh|Aah|Hmm|Hm|Mmm|Umm|Um|Uhh|Uh|Ah|Oh)\b[\s,.\-—…]*/i;

// ─── Generic unit / abbreviation expansion ──────────────────────────────────
// A small, stable, project-agnostic set. Order matters: longer/compound
// patterns first so they win over their shorter sub-patterns.
const GENERIC_EXPANSIONS: [RegExp, string][] = [
  // Area units — expand to the spoken English form Sarvam handles well.
  [/\bper\s+sq\.?\s*ft\.?\b/gi, 'per square feet'],
  [/\bper\s+sqft\.?\b/gi,       'per square feet'],
  [/\bsq\.?\s*ft\.?\b/gi,       'square feet'],
  [/\bsqft\.?\b/gi,             'square feet'],
  [/\bsq\.?\s*m\.?\b/gi,        'square meter'],

  // Common numeric magnitude abbreviation (₹3 Cr → "3 crore").
  [/\bCr\b/g, 'crore'],

  // Domain acronyms Sarvam spells out wrong — render as Hindi phonetics.
  [/\bBHK\b/g,            'बी एच के'],
  [/\bRK\b/g,             'आर के'],
  [/\bEV\s+charging\b/gi, 'ई वी charging'],
  [/\bEV\b/g,             'ई वी'],
  [/\bEMI\b/g,            'ई एम आई'],
  [/\bGST\b/g,            'जी एस टी'],
  [/\bOC\b/g,             'ओ सी'],
  [/\bRERA\b/gi,          'रेरा'],
];

// ─── Punctuation cleanup ────────────────────────────────────────────────────
const EXCESS_PUNCTUATION = /\.{2,}/g;           // "..." → single Devanagari stop
const STRAY_DASH = /\s*[—–-]\s*$/;              // trailing dash → drop

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Normalize text for Sarvam TTS pronunciation.
 * Safe to call on any text — returns the input unchanged if no rule matches.
 */
export function normalizeTTSText(text: string): string {
  if (!text) return text;

  let out = text;

  // 1. Remove leading filler (+ its trailing punctuation).
  out = out.replace(LEADING_FILLER, '');

  // 2. Expand generic unit/abbreviation tokens.
  for (const [pattern, replacement] of GENERIC_EXPANSIONS) {
    out = out.replace(pattern, replacement);
  }

  // 3. Clean up punctuation/whitespace.
  out = out.replace(EXCESS_PUNCTUATION, '।');
  out = out.replace(STRAY_DASH, '');
  out = out.replace(/\s{2,}/g, ' ').trim();

  return out;
}
