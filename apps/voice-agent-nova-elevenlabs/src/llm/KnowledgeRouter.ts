/**
 * KnowledgeRouter: deterministic zero-LLM-token fact answering layer.
 *
 * Intercepts factual questions about the property and returns pre-built
 * conversational responses directly — bypassing LLM entirely. This eliminates
 * token usage, removes hallucination risk, and cuts latency to near-zero for
 * ~80% of inbound questions.
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
import { factFollowUp } from '../orchestration/PreferenceRecall';

// ─── Fact Intent Classification ──────────────────────────────────────────────

export type FactIntent =
  | 'PRICE'
  | 'PRICE_BHK'
  | 'LOCATION'
  | 'LANDMARKS'
  | 'AMENITIES'
  | 'BHK'
  | 'CARPET_AREA'
  | 'POSSESSION'
  | 'CONSTRUCTION_STATUS'
  | 'BUILDER'
  | 'UNITS'
  | 'PROJECT_NAME'
  | 'PAYMENT_PLAN'
  | 'BOOKING_AMOUNT'
  | 'LOAN'
  | 'PARKING'
  | 'RERA'
  | 'STAMP_DUTY'
  | 'USP'
  | 'SITE_VISIT_INFO'
  | 'SECURITY'
  | 'FLOOR_TOWER';

interface IntentRule {
  intent: FactIntent;
  patterns: RegExp[];
}

// Rules are tested in order — more specific intents must appear before generic ones.
const INTENT_RULES: IntentRule[] = [
  // ── Booking Amount (before PRICE — "booking amount" must not match generic PRICE) ─
  {
    intent: 'BOOKING_AMOUNT',
    patterns: [
      /\b(booking\s*amount|token|token\s*money|advance|kitna\s*dena|कितना\s*देना|initial\s*amount|upfront)\b/i,
    ],
  },
  // ── Price by BHK (must be before generic PRICE) ──────────────────────
  {
    intent: 'PRICE_BHK',
    patterns: [
      /\b(2\.?5?|3|two|three)\s*bhk\b[^?]*\b(price|cost|kitna|kitne|कितना|कितने|कीमत|दाम|rate|budget|amount)\b/i,
      /\b(price|cost|kitna|kitne|कितना|कितने|कीमत|दाम|rate)\b[^?]*\b(2\.?5?|3|two|three)\s*bhk\b/i,
      /\b(2\.?5?|3|two|three)\s*bhk\b[^?]*\b(ka|ki|ke|का|की|के)\b/i,
    ],
  },
  // ── Generic Price ────────────────────────────────────────────────────
  {
    intent: 'PRICE',
    patterns: [
      /\b(price|pricing|cost|rate|budget|kitna|kitne|कितना|कितने|कीमत|दाम|paisa|पैसा|per\s*sq\s*ft|sqft|square\s*feet|वर्ग\s*फ़ीट|वर्गफीट|वर्गफुट)\b/i,
      /(?:कितने|kitne|kitna|कितना)\s*(?:का|ki|में|mein|me)/i,
    ],
  },
  // ── Carpet Area / Size ──────────────────────────────────────────────
  {
    intent: 'CARPET_AREA',
    patterns: [
      /\b(carpet\s*area|built\s*up|super\s*built|size|area|kitna\s*bada|कितना\s*बड़ा|sq\s*ft|sqft|square\s*feet|kitne\s*sq|flat\s*size|apartment\s*size)\b/i,
    ],
  },
  // ── Landmarks / Nearby ──────────────────────────────────────────────
  {
    intent: 'LANDMARKS',
    patterns: [
      /\b(nearby|near|around|paas|पास|aas\s*paas|आसपास|landmark|school|hospital|metro|station|highway|expressway|mall|market|college|connectivity|connect|transport|commute|IT\s*park|hinjewadi)\b/i,
      /\b(kya\s*hai\s*nearby|आसपास\s*क्या\s*है|paas\s*mein\s*kya)\b/i,
    ],
  },
  // ── Location ────────────────────────────────────────────────────────
  {
    intent: 'LOCATION',
    patterns: [
      /\b(location|where|kahan|कहाँ|कहां|address|area|place|jagah|जगह|situated|sthit|स्थित|kidhar|किधर)\b/i,
      /(?:project|property)\s+(?:kahan|kidhar|where|कहाँ|कहां)/i,
    ],
  },
  // ── Amenities ──────────────────────────────────────────────────────
  {
    intent: 'AMENITIES',
    patterns: [
      /\b(ameniti|amenity|amenities|facilities|facility|features?|suvidha|सुविधा|सुविधाएं|सुविधाएँ|gym|pool|swimming|garden|club\s*house|ev\s*charg|kids?\s*zone|play\s*area|joggin|walking\s*track)\b/i,
    ],
  },
  // ── Parking ────────────────────────────────────────────────────────
  {
    intent: 'PARKING',
    patterns: [
      /\b(parking|car\s*park|gaadi|गाड़ी|two\s*wheeler|bike\s*park|covered\s*park|open\s*park|basement)\b/i,
    ],
  },
  // ── Security ──────────────────────────────────────────────────────
  {
    intent: 'SECURITY',
    patterns: [
      /\b(security|safe|safety|cctv|guard|suraksha|सुरक्षा|watchman|surveillance)\b/i,
    ],
  },
  // ── BHK / Configuration ────────────────────────────────────────────
  {
    intent: 'BHK',
    patterns: [
      /\b(bhk|configuration|config|layout|flat\s*type|apartment\s*type|kitne\s*bhk|कितने\s*bhk|floor\s*plan)\b/i,
      /(?:kaun|कौन)\s*(?:se|से)\s*(?:bhk|flat|apartment)/i,
    ],
  },
  // ── Floor / Tower ─────────────────────────────────────────────────
  {
    intent: 'FLOOR_TOWER',
    patterns: [
      /\b(floor|tower|manzil|मंज़िल|kitne\s*floor|कितने\s*floor|how\s*many\s*floor|storey|story|building)\b/i,
    ],
  },
  // ── Construction Status ───────────────────────────────────────────
  {
    intent: 'CONSTRUCTION_STATUS',
    patterns: [
      /\b(construction|kahan\s*tak\s*ban|कहाँ\s*तक\s*बन|kitna\s*ban|कितना\s*बन|progress|status|slab|work\s*start|kaam\s*shuru|काम\s*शुरू)\b/i,
    ],
  },
  // ── Possession ────────────────────────────────────────────────────
  {
    intent: 'POSSESSION',
    patterns: [
      /\b(possession|handover|ready|complete|completion|deliver|कब\s*मिलेगा|kab\s*milega|move\s*in|ready\s*to\s*move|under\s*construction)\b/i,
      /(?:kab|कब)\s+(?:tak|तक|ready|milega|मिलेगा|complete|banega|बनेगा)/i,
    ],
  },
  // ── Payment Plan ──────────────────────────────────────────────────
  {
    intent: 'PAYMENT_PLAN',
    patterns: [
      /\b(payment\s*plan|payment\s*schedule|kaise\s*pay|कैसे\s*pay|instalment|installment|emi\s*plan|construction\s*linked|milestone|20.*80|down\s*payment)\b/i,
    ],
  },
  // ── Loan / Finance ────────────────────────────────────────────────
  {
    intent: 'LOAN',
    patterns: [
      /\b(loan|home\s*loan|finance|emi|bank\s*loan|sbi|hdfc|icici|axis|bank\s*se|बैंक\s*से|pre\s*approved|loan\s*available|loan\s*milega)\b/i,
    ],
  },
  // ── RERA ──────────────────────────────────────────────────────────
  {
    intent: 'RERA',
    patterns: [
      /\b(rera|registration\s*number|registered|legal|approval|permission|govt\s*approv|सरकारी\s*मंज़ूरी)\b/i,
    ],
  },
  // ── Stamp Duty / Registration / GST / Taxes ──────────────────────
  {
    intent: 'STAMP_DUTY',
    patterns: [
      /\b(stamp\s*duty|registration\s*charge|gst|tax|government\s*charge|extra\s*charge|hidden\s*charge|additional\s*cost|other\s*charge|total\s*cost|kitna\s*extra|कितना\s*extra|sarkari|सरकारी)\b/i,
    ],
  },
  // ── Builder ───────────────────────────────────────────────────────
  {
    intent: 'BUILDER',
    patterns: [
      /\b(builder|developer|company|firm|kisne\s*banaya|किसने\s*बनाया|kaun\s*sa\s*builder|कौन\s*सा\s*builder|group|promoter|lunkad)\b/i,
    ],
  },
  // ── Units ─────────────────────────────────────────────────────────
  {
    intent: 'UNITS',
    patterns: [
      /\b(units?|total\s*flats?|kitne\s*flat|कितने\s*flat|how\s*many\s*flat|apartments?\s*available|flats?\s*available|total\s*apartments?)\b/i,
    ],
  },
  // ── Project Name ──────────────────────────────────────────────────
  {
    intent: 'PROJECT_NAME',
    patterns: [
      /\b(project\s*name|naam|नाम|konsa\s*project|कौनसा\s*project|which\s*project|project\s*ka\s*naam)\b/i,
    ],
  },
  // ── USP / Why This Project ────────────────────────────────────────
  {
    intent: 'USP',
    patterns: [
      /\b(usp|special|kya\s*khaas|क्या\s*ख़ास|क्या\s*खास|unique|different|alag|अलग|why\s*this|best\s*thing|highlight|advantage|fayda|फ़ायदा|फायदा|vastu)\b/i,
    ],
  },
  // ── Site Visit Info ───────────────────────────────────────────────
  {
    intent: 'SITE_VISIT_INFO',
    patterns: [
      /\b(site\s*visit\s*address|kahan\s*aana|कहाँ\s*आना|office\s*address|site\s*address|timing|kab\s*aa\s*sakte|कब\s*आ\s*सकते|open\s*on\s*sunday|sunday\s*open|sample\s*flat|model\s*flat)\b/i,
    ],
  },
];

// ─── Response Templates ──────────────────────────────────────────────────────
// Conversational Hindi/Hinglish responses — fact + natural follow-up.

function buildResponse(intent: FactIntent): string {
  switch (intent) {
    case 'PRICE':
      // Slot-filling follow-up ("किस budget range?") is appended conditionally
      // in routeQuery via factFollowUp() — only when budget isn't captured yet.
      return `${PROPERTY_FACTS.project} में price roughly ${PROPERTY_FACTS.pricePerSqft} है, overall range ${PROPERTY_FACTS.priceRange} तक है।`;
    case 'PRICE_BHK': {
      const lines = Object.entries(PROPERTY_FACTS.configs)
        .map(([bhk, c]) => `${bhk} starting ${c.startingPrice} से`)
        .join(', ');
      return `${lines} — ये carpet area और floor के हिसाब से vary करता है।`;
    }
    case 'CARPET_AREA': {
      const lines = Object.entries(PROPERTY_FACTS.configs)
        .map(([bhk, c]) => `${bhk}: ${c.carpetArea}`)
        .join(', ');
      return `Carpet area — ${lines}। सब RERA carpet area है, no hidden super built-up।`;
    }
    case 'LOCATION':
      return `${PROPERTY_FACTS.project} ${PROPERTY_FACTS.location} में है — Pimple Gurav Metro Station से बस 5 minute walk।`;
    case 'LANDMARKS':
      return `${PROPERTY_FACTS.landmarks.slice(0, 4).join(', ')} — connectivity काफ़ी अच्छी है। Hinjewadi IT Park भी 20 minute में पहुँच जाओगे।`;
    case 'AMENITIES':
      return `Gym, स्विमिंग पूल, क्लबहाउस, किड्स ज़ोन, ई वी चार्जिंग, जॉगिंग ट्रैक, लैंडस्केप्ड गार्डन — सब कुछ available है। क्लबहाउस अकेला 5000 square feet का है।`;
    case 'PARKING':
      return `One covered parking हर flat के साथ included है price में। Additional open parking ${PROPERTY_FACTS.parking.additional} में available है, और two-wheeler parking free।`;
    case 'SECURITY':
      return `${PROPERTY_FACTS.amenitiesDetailed.security} — plus intercom facility हर flat में।`;
    case 'BHK':
      // Slot-filling follow-up ("किस configuration?") is appended conditionally
      // in routeQuery via factFollowUp() — only when bhkPreference isn't captured.
      return `${PROPERTY_FACTS.project} में ${PROPERTY_FACTS.bhk.join(', ')} BHK options available हैं।`;
    case 'FLOOR_TOWER':
      return `Total ${PROPERTY_FACTS.towers} towers हैं, हर tower ${PROPERTY_FACTS.totalFloors} floors का। हर tower में 2 high-speed lifts हैं।`;
    case 'CONSTRUCTION_STATUS':
      return `${PROPERTY_FACTS.constructionStatus}। काम तेज़ी से चल रहा है, possession ${PROPERTY_FACTS.possession} में expected है।`;
    case 'POSSESSION':
      return `Possession ${PROPERTY_FACTS.possession} में expected है। Project RERA registered है और सब approvals पहले से हैं।`;
    case 'PAYMENT_PLAN':
      return `${PROPERTY_FACTS.paymentPlan}। इसका मतलब booking पर सिर्फ 20% देना होगा, बाकी possession के time।`;
    case 'BOOKING_AMOUNT':
      return `Booking amount सिर्फ ${PROPERTY_FACTS.bookingAmount} है — इससे flat lock हो जाएगा। बाकी construction-linked plan पर आएगा।`;
    case 'LOAN':
      return `Home loan pre-approved है ${PROPERTY_FACTS.preApprovedBanks.join(', ')} से — documentation में हमारी team full help करेगी। Site visit पे आओगे तो loan details भी discuss कर लेंगे।`;
    case 'RERA':
      return `Project RERA registered है — number ${PROPERTY_FACTS.reraNumber}। सब government approvals पहले से in place हैं।`;
    case 'STAMP_DUTY':
      return `Stamp duty ${PROPERTY_FACTS.stampDuty}, registration ${PROPERTY_FACTS.registration}, और GST ${PROPERTY_FACTS.gst} — ये flat price के ऊपर additional है।`;
    case 'BUILDER':
      return `${PROPERTY_FACTS.project} ${PROPERTY_FACTS.developer} group का project है — ${PROPERTY_FACTS.developerTrackRecord}। Pune में काफ़ी trusted name है।`;
    case 'UNITS':
      return `${PROPERTY_FACTS.project} में total ${PROPERTY_FACTS.units} units हैं ${PROPERTY_FACTS.towers} towers में। Limited inventory है, तो जल्दी decide करना better रहेगा।`;
    case 'PROJECT_NAME':
      return `Project का नाम ${PROPERTY_FACTS.project} है, ${PROPERTY_FACTS.developer} group का, ${PROPERTY_FACTS.location} में।`;
    case 'USP':
      return `Metro station 5 minute walk, Vastu compliant design, no common wall between flats यानी complete privacy, और R.R. Lunkad का 30 साल का trust — ये सब cheezein इसको special बनाती हैं।`;
    case 'SITE_VISIT_INFO':
      return `Site visit ${PROPERTY_FACTS.siteVisitTimings} — Sunday भी open है। Address: ${PROPERTY_FACTS.siteVisitAddress}।`;
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

/** Last intent handled by the router — used to prevent identical repeated responses. */
let lastHandledIntent: FactIntent | null = null;

/** Reset after LLM handles a turn, so the next same-intent question gets the canned response. */
export function resetLastRouterIntent(): void {
  lastHandledIntent = null;
}

/**
 * Side-effect-free probe: does this text match a fact intent?
 * Used by speculative containment to compare spec vs final intent without
 * mutating lastHandledIntent or triggering markVisitSuggested().
 */
export function probeFactIntent(text: string): FactIntent | null {
  const trimmed = text.trim();
  for (const pat of NEEDS_LLM) {
    if (pat.test(trimmed)) return null;
  }
  for (const rule of INTENT_RULES) {
    for (const pat of rule.patterns) {
      if (pat.test(trimmed)) return rule.intent;
    }
  }
  return null;
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

  // Missing-field logic: append the slot-filling follow-up ONLY when the field
  // isn't captured yet — never re-ask a preference the caller already gave.
  const follow = factFollowUp(matchedIntent, {
    budget: session.budget,
    bhk: session.bhkPreference,
  });
  if (follow.clause) {
    response += ` ${follow.clause}`;
  } else if (follow.reused && follow.field) {
    log.info('SESSION_FIELD_REUSED', {
      field: follow.field,
      value: follow.field === 'budget' ? session.budget : session.bhkPreference,
      reason: 'fact follow-up suppressed — already captured',
    });
  }

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
