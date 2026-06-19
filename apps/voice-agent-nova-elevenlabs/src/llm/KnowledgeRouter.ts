/**
 * KnowledgeRouter: deterministic zero-LLM-token fact answering layer.
 *
 * Intercepts factual questions about the property (price, location, amenities,
 * possession, BHK, builder, units) and returns pre-built responses directly —
 * bypassing LLM entirely. This eliminates token usage, removes hallucination
 * risk, and cuts latency to near-zero for ~60% of inbound questions.
 *
 * The LLM is only invoked for:
 *   - Open-ended / conversational questions
 *   - Objections and comparisons
 *   - Visit scheduling dialogue
 *   - Anything not in PROPERTY_FACTS
 */

import { PROPERTY_FACTS } from './PropertyFacts';
import { Logger } from '../shared/logger';
import type { SessionState } from '../orchestration/SessionState';

// ─── Fact Intent Classification ──────────────────────────────────────────────
// Each intent maps a set of regex patterns to a response-builder function.
// Patterns are tested in order; first match wins. All patterns are
// case-insensitive. Hindi (Devanagari) keywords use direct matching since
// \b doesn't work with non-ASCII word boundaries.

export type FactIntent =
  | 'PRICE'
  | 'LOCATION'
  | 'AMENITIES'
  | 'BHK'
  | 'POSSESSION'
  | 'BUILDER'
  | 'UNITS'
  | 'PROJECT_NAME';

interface IntentRule {
  intent: FactIntent;
  patterns: RegExp[];
}

const INTENT_RULES: IntentRule[] = [
  {
    intent: 'PRICE',
    patterns: [
      /\b(price|pricing|cost|rate|budget|kitna|kitne|कितना|कितने|कीमत|दाम|amount|paisa|पैसा|per\s*sq\s*ft|sqft|square\s*feet|वर्ग\s*फ़ीट|वर्गफीट|वर्गफुट)\b/i,
      /(?:कितने|kitne|kitna|कितना)\s*(?:का|ki|में|mein|me)/i,
    ],
  },
  {
    intent: 'LOCATION',
    patterns: [
      /\b(location|where|kahan|कहाँ|कहां|address|area|place|jagah|जगह|situated|sthit|स्थित|kidhar|किधर)\b/i,
      /(?:project|property)\s+(?:kahan|kidhar|where|कहाँ|कहां)/i,
    ],
  },
  {
    intent: 'AMENITIES',
    patterns: [
      /\b(ameniti|amenity|amenities|facilities|facility|features?|suvidha|सुविधा|सुविधाएं|सुविधाएँ|gym|pool|swimming|parking|garden|club\s*house|ev\s*charg|kids?\s*zone|play\s*area)\b/i,
      // NOTE: The old catch-all "kya hai" pattern was removed — it matched ANY
      // "क्या है" question (e.g. "configuration का क्या है" → AMENITIES instead of BHK).
      // Amenity-specific keywords in the first pattern are sufficient.
    ],
  },
  {
    intent: 'BHK',
    patterns: [
      /\b(bhk|configuration|config|layout|flat\s*type|apartment\s*type|kitne\s*bhk|कितने\s*bhk|floor\s*plan)\b/i,
      /(?:kaun|कौन)\s*(?:se|से)\s*(?:bhk|flat|apartment)/i,
    ],
  },
  {
    intent: 'POSSESSION',
    patterns: [
      /\b(possession|handover|ready|complete|completion|deliver|कब\s*मिलेगा|kab\s*milega|move\s*in|ready\s*to\s*move|under\s*construction)\b/i,
      /(?:kab|कब)\s+(?:tak|तक|ready|milega|मिलेगा|complete|banega|बनेगा)/i,
    ],
  },
  {
    intent: 'BUILDER',
    patterns: [
      /\b(builder|developer|company|firm|kisne\s*banaya|किसने\s*बनाया|kaun\s*sa\s*builder|कौन\s*सा\s*builder|group|promoter)\b/i,
    ],
  },
  {
    intent: 'UNITS',
    patterns: [
      /\b(units?|total\s*flats?|kitne\s*flat|कितने\s*flat|how\s*many\s*flat|apartments?\s*available|flats?\s*available|total\s*apartments?)\b/i,
    ],
  },
  {
    intent: 'PROJECT_NAME',
    patterns: [
      /\b(project\s*name|naam|नाम|konsa\s*project|कौनसा\s*project|which\s*project|project\s*ka\s*naam)\b/i,
    ],
  },
];

// ─── Response Templates ──────────────────────────────────────────────────────
// Pre-built Hindi/Hinglish responses for each fact intent. These are spoken
// directly by TTS without LLM involvement. The name suffix is appended by
// the router when the caller's name is known.

function buildResponse(intent: FactIntent): string {
  switch (intent) {
    case 'PRICE':
      return `${PROPERTY_FACTS.project} में price ${PROPERTY_FACTS.pricePerSqft} है।`;
    case 'LOCATION':
      return `${PROPERTY_FACTS.project} ${PROPERTY_FACTS.location} में है।`;
    case 'AMENITIES':
      return `${PROPERTY_FACTS.project} में ${PROPERTY_FACTS.amenities.join(', ')} available हैं।`;
    case 'BHK':
      return `${PROPERTY_FACTS.project} में ${PROPERTY_FACTS.bhk.join(', ')} BHK options available हैं।`;
    case 'POSSESSION':
      return `Possession ${PROPERTY_FACTS.possession} में expected है।`;
    case 'BUILDER':
      return `${PROPERTY_FACTS.project} ${PROPERTY_FACTS.developer} group का project है।`;
    case 'UNITS':
      return `${PROPERTY_FACTS.project} में total ${PROPERTY_FACTS.units} units हैं।`;
    case 'PROJECT_NAME':
      return `Project का नाम ${PROPERTY_FACTS.project} है, ${PROPERTY_FACTS.location} में।`;
  }
}

// ─── Exclusion Patterns ──────────────────────────────────────────────────────
// These indicate the query is too complex for a direct fact response and
// needs LLM reasoning (comparisons, multi-part questions, objections).

const NEEDS_LLM: RegExp[] = [
  // Comparisons
  /\b(compare|comparison|versus|vs\.?|differ|farak|फ़र्क|फर्क|अंतर|better|best|which\s+is)\b/i,
  // Multi-question (2+ question marks)
  /\?[^?]*\?/,
  // Objections / negotiation
  /\b(expensive|costly|mehenga|महंगा|too\s+much|zyada|ज़्यादा|discount|offer|negotiate|kam\s+kar|कम\s+कर)\b/i,
  // Visit scheduling
  /\b(visit|schedule|book|appointment|देखना|देखेंगे|देखने|dekhna|dekhenge)\b/i,
  // Explanatory / open-ended
  /\b(explain|describe|tell\s+me\s+about|overview|detail|batao|बताइए|बताओ|समझाइए|kyu|क्यों|why)\b/i,
];

// ─── Router ──────────────────────────────────────────────────────────────────

export interface RouterResult {
  /** Whether the query was handled directly (no LLM needed). */
  handled: boolean;
  /** The fact intent that matched, or null if routed to LLM. */
  intent: FactIntent | null;
  /** The pre-built response text (only when handled=true). */
  response: string;
  /** Why the router made this decision. */
  reason: string;
}

/**
 * Classify user transcript and return a direct fact response if possible.
 *
 * @param text  - User's transcript (raw from STT)
 * @param session - Current session state (for name, step context)
 * @param log   - Logger instance for the call
 * @returns RouterResult indicating whether the query was handled
 */
/** Last intent handled by the router — used to prevent identical repeated responses. */
let lastHandledIntent: FactIntent | null = null;

/** Reset after LLM handles a turn, so the next same-intent question gets the canned response. */
export function resetLastRouterIntent(): void {
  lastHandledIntent = null;
}

export function routeQuery(
  text: string,
  session: SessionState,
  log: Logger,
): RouterResult {
  const trimmed = text.trim();

  // ── Gate 1: Terminal steps are always deterministic ──────────────────────
  // CONFIRM_VISIT, BOOKED, NOT_INTERESTED are handled by the application.
  // ASK_VISIT_DAY and ASK_VISIT_TIME allow factual questions through — the
  // scheduling re-prompt is appended after the fact answer.
  const step = session.currentStep;
  const terminalSteps = new Set([
    'CONFIRM_VISIT', 'BOOKED', 'NOT_INTERESTED',
  ]);
  if (terminalSteps.has(step)) {
    return { handled: false, intent: null, response: '', reason: `step=${step} handled deterministically` };
  }

  // ── Gate 2: Check exclusion patterns (needs LLM reasoning) ──────────────
  for (const pat of NEEDS_LLM) {
    if (pat.test(trimmed)) {
      return { handled: false, intent: null, response: '', reason: `exclusion: ${pat.source.substring(0, 30)}` };
    }
  }

  // ── Gate 3: Classify fact intent ────────────────────────────────────────
  let matchedIntent: FactIntent | null = null;
  for (const rule of INTENT_RULES) {
    for (const pat of rule.patterns) {
      if (pat.test(trimmed)) {
        matchedIntent = rule.intent;
        break;
      }
    }
    if (matchedIntent) break;
  }

  if (!matchedIntent) {
    // No fact intent → during scheduling steps, fall through to the
    // deterministic scheduling handler (user is likely providing a date/time).
    return { handled: false, intent: null, response: '', reason: 'no fact intent matched' };
  }

  // ── Repeat guard: if the same fact intent was just answered, fall through
  // to LLM for a varied response instead of repeating the same canned line.
  if (matchedIntent === lastHandledIntent) {
    log.info('ROUTER_REPEAT_SKIP', { intent: matchedIntent, reason: 'same intent as last turn — falling through to LLM' });
    return { handled: false, intent: matchedIntent, response: '', reason: `repeat_skip:${matchedIntent}` };
  }

  // ── Build response ──────────────────────────────────────────────────────
  let response = buildResponse(matchedIntent);

  // During VISIT_OFFER, append the visit offer — but only once.
  if (step === 'VISIT_OFFER' && session.shouldSuggestVisit()) {
    response += ` क्या आप site visit करना चाहेंगे?`;
    session.markVisitSuggested();
  }

  // During scheduling steps (ASK_VISIT_DAY, ASK_VISIT_TIME), the user asked
  // a factual question instead of providing a date/time. Answer the question
  // and gently re-prompt for the scheduling info.
  if (step === 'ASK_VISIT_DAY') {
    response += ' तो आपको कौन सा दिन सही रहेगा — आज, कल, या weekend?';
  } else if (step === 'ASK_VISIT_TIME') {
    response += ' कितने बजे आना चाहेंगे — सुबह, दोपहर, या शाम?';
  }

  lastHandledIntent = matchedIntent;

  log.info('ROUTER_DECISION', {
    intent: matchedIntent,
    step,
    handled: true,
    queryLen: trimmed.length,
  });

  return {
    handled: true,
    intent: matchedIntent,
    response,
    reason: `direct_fact:${matchedIntent}`,
  };
}
