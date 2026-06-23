/**
 * IntentClassifier: regex + keyword-based intent classification.
 *
 * Classifies user utterances into property-information intents that can be
 * handled with deterministic responses (no LLM), or UNKNOWN/conversational
 * intents that fall through to the LLM.
 *
 * Zero latency — pure synchronous string matching.
 */

// ─── Intent Enum ────────────────────────────────────────────────────────────

export enum Intent {
  PRICE           = 'PRICE',
  LOCATION        = 'LOCATION',
  AMENITIES       = 'AMENITIES',
  BHK             = 'BHK',
  POSSESSION      = 'POSSESSION',
  DEVELOPER       = 'DEVELOPER',
  UNITS           = 'UNITS',
  VISIT_INTEREST  = 'VISIT_INTEREST',
  VISIT_REJECTION = 'VISIT_REJECTION',
  OBJECTION       = 'OBJECTION',
  UNKNOWN         = 'UNKNOWN',
}

// ─── Classification Result ──────────────────────────────────────────────────

export interface ClassificationResult {
  intent: Intent;
  confidence: 'high' | 'medium';
  /** The matched keyword/pattern that triggered classification. */
  matchedTrigger: string;
  /** Time taken in microseconds (for metrics). */
  classificationTimeUs: number;
}

// ─── Intent Patterns ────────────────────────────────────────────────────────

interface IntentRule {
  intent: Intent;
  pattern: RegExp;
}

/**
 * Ordered by specificity — more specific intents first to avoid
 * false matches (e.g. "visit nahi" should match VISIT_REJECTION
 * before VISIT_INTEREST).
 */
const INTENT_RULES: IntentRule[] = [
  // ── Visit rejection (before visit interest) ───────────────────────────
  {
    intent: Intent.VISIT_REJECTION,
    pattern: /\b(not\s*interested|visit\s*nahi|no\s*visit|nahi\s*aana|nahi\s*chahiye|abhi\s*nahi|busy\b|time\s*nahi|baad\s*mein|not\s*now|don'?t\s*want|नहीं\s*आना|बाद\s*में|बिज़ी)\b/i,
  },

  // ── Objection ─────────────────────────────────────────────────────────
  {
    intent: Intent.OBJECTION,
    pattern: /\b(expensive|costly|mehnga|महंगा|zyada\s*hai|compare|comparison|not\s*sure|think\s*(?:about|later)|sochna|sochu|सोचूं|soch\s*ke|budget\s*(?:se\s*)?(?:zyada|bahar)|over\s*budget|too\s*(?:much|high)|out\s*of\s*(?:budget|range)|later)\b/i,
  },

  // ── Visit interest ────────────────────────────────────────────────────
  {
    intent: Intent.VISIT_INTEREST,
    pattern: /\b(visit|site\s*visit|schedule|book\s*(?:visit|appointment)|dekhna\s*(?:hai|chahte)?|dekh\s*sakte|देखना|देखेंगे|aana\s*chahte|come\s*and\s*see|can\s*i\s*(?:visit|come|see)|interested\s*(?:in\s*)?visit)\b/i,
  },

  // ── Price ──────────────────────────────────────────────────────────────
  {
    intent: Intent.PRICE,
    pattern: /\b(price|pricing|rate|cost|kitna\s*(?:hai|hoga|padega|lagega)?|kharcha|per\s*sq|psf|sqft|sq\s*ft|rupee|paisa|keemat|कीमत|दाम|रेट|कितना|खर्चा|महंगा|सस्ता|affordable|cheap|value|worth)\b/i,
  },

  // ── Possession ────────────────────────────────────────────────────────
  {
    intent: Intent.POSSESSION,
    pattern: /\b(possession|ready\s*(?:to\s*move|kab|hoga)|handover|move\s*in|delivery|complete\s*(?:kab|hoga)|kab\s*(?:milega|hoga|tak|ready)|timeline|कब|तैयार|पज़ेशन|मिलेगा|ready\s*to\s*move|under\s*construction|construction\s*status)\b/i,
  },

  // ── Location ──────────────────────────────────────────────────────────
  {
    intent: Intent.LOCATION,
    pattern: /\b(location|kahan|kidhar|where\s*(?:is|exactly)|area|jagah|address|direction|connectivity|commute|transport|metro|road|highway|कहाँ|कहां|जगह|पता|लोकेशन|neighborhood|near(?:by)?|distance|kitni\s*door)\b/i,
  },

  // ── Amenities ─────────────────────────────────────────────────────────
  {
    intent: Intent.AMENITIES,
    pattern: /\b(amenity|amenities|facilities|facility|features|gym|pool|garden|clubhouse|club\s*house|parking|play\s*area|jogging|ev\s*charging|सुविधा|सुविधाएं|फैसिलिटी|गार्डन|क्लबहाउस|पार्किंग|what\s*all|kya\s*kya\s*hai)\b/i,
  },

  // ── Developer ─────────────────────────────────────────────────────────
  {
    intent: Intent.DEVELOPER,
    pattern: /\b(developer|builder|company|brand|group|promoter|construction\s*company|बिल्डर|डेवलपर|कंपनी|ब्रांड|कौन\s*bana|kisne\s*banaya|किसका\s*project|who\s*(?:is\s*)?build|reputation|track\s*record|builder\s*kaun)\b/i,
  },

  // ── BHK / configuration ───────────────────────────────────────────────
  {
    intent: Intent.BHK,
    pattern: /\b(bhk|b\.?h\.?k|bedroom|bed\s*room|flat\s*(?:size|type)|configuration|carpet|super\s*built|बीएचके|बेडरूम|कमरे|kitne\s*kamre|apartment\s*type|layout|floor\s*plan|(?:flat|unit)\s*size|size\s*(?:kya|kitna)|kaun\s*kaun\s*se\s*(?:bhk|flat))\b/i,
  },

  // ── Units / project scale ─────────────────────────────────────────────
  {
    intent: Intent.UNITS,
    pattern: /\b(units|flats|apartments|kitne\s*flat|total\s*(?:flats|units)|how\s*many\s*(?:flats|units|apartments)|towers|floors|buildings|कितने\s*फ्लैट|यूनिट|टावर|मंज़िल|total\s*kitne)\b/i,
  },
];

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Classify a user utterance into an Intent.
 *
 * Very short utterances (≤2 words) that don't contain strong keywords
 * are classified as UNKNOWN to avoid false positives on greetings,
 * confirmations, etc.
 */
export function classifyIntent(userText: string): ClassificationResult {
  const start = performance.now();
  const text = userText.trim();
  const lower = text.toLowerCase();

  const wordCount = text.split(/\s+/).length;

  // Single-word utterances: only classify known standalone keywords
  if (wordCount === 1) {
    const isStrongKeyword = /^(price|location|amenities|bhk|possession|builder|developer|visit)$/i.test(text);
    if (!isStrongKeyword) {
      const elapsed = performance.now() - start;
      return {
        intent: Intent.UNKNOWN,
        confidence: 'medium',
        matchedTrigger: '',
        classificationTimeUs: Math.round(elapsed * 1000),
      };
    }
  }

  for (const { intent, pattern } of INTENT_RULES) {
    const match = lower.match(pattern);
    if (match) {
      const elapsed = performance.now() - start;
      return {
        intent,
        confidence: wordCount >= 3 ? 'high' : 'medium',
        matchedTrigger: match[0],
        classificationTimeUs: Math.round(elapsed * 1000),
      };
    }
  }

  const elapsed = performance.now() - start;
  return {
    intent: Intent.UNKNOWN,
    confidence: 'medium',
    matchedTrigger: '',
    classificationTimeUs: Math.round(elapsed * 1000),
  };
}

/**
 * Returns true if this intent can be handled with a deterministic
 * local response (no LLM needed).
 */
export function isLocallyRoutable(intent: Intent): boolean {
  switch (intent) {
    case Intent.PRICE:
    case Intent.LOCATION:
    case Intent.AMENITIES:
    case Intent.BHK:
    case Intent.POSSESSION:
    case Intent.DEVELOPER:
    case Intent.UNITS:
      return true;
    default:
      return false;
  }
}
