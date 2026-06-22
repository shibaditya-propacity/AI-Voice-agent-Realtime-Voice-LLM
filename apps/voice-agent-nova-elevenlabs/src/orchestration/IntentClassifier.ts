/**
 * IntentClassifier: context-aware intent classification for the scheduling flow.
 *
 * Replaces hardcoded phrase lists (AFFIRMATIVE, REJECTION, VISIT_REJECTION)
 * with linguistic PATTERN FAMILIES that capture morphological variants and
 * natural-language constructions. The classifier considers conversation context
 * (what was last asked, current step) to resolve ambiguous utterances.
 *
 * Design: word lists are brittle ("haan" works, "haanji" doesn't). Pattern
 * families match linguistic CONSTRUCTIONS — agreement morphology, willingness
 * verbs, imperative acceptance — catching variations that no word list can.
 *
 * Intent taxonomy:
 *   AGREEMENT    — user accepts, affirms, or consents
 *   REJECTION    — user declines the entire offer (end call)
 *   VISIT_REJECT — user declines a visit specifically (keep answering Qs)
 *   VISIT_INTENT — user explicitly requests a visit/scheduling
 *   QUESTION     — user asks a factual question
 *   UNCLEAR      — ambiguous or too short to classify
 */

import type { LastAskedField, ConversationStep } from './SessionState';

// ─── Intent Types ────────────────────────────────────────────────────────────

export type UserIntent =
  | 'AGREEMENT'
  | 'REJECTION'
  | 'VISIT_REJECT'
  | 'VISIT_INTENT'
  | 'QUESTION'
  | 'UNCLEAR';

export interface ClassifiedIntent {
  intent: UserIntent;
  confidence: number;   // 0.0–1.0 heuristic confidence
  reason: string;       // human-readable debug reason
}

// ─── Pattern Families ────────────────────────────────────────────────────────
// Each family captures a LINGUISTIC CONSTRUCTION, not individual words.
// This lets us match "haanji", "theek hai bhai", "चलो देखते हैं" without
// maintaining an ever-growing word list.

// ── Agreement / Acceptance ───────────────────────────────────────────────────

// Family 1: Affirmative particles (any position, flexible morphology)
// Matches: yes, yeah, yep, yup, haan, haanji, ji, ji haan, hanji, etc.
const AFFIRM_PARTICLE = /\b(y(es|eah|ep|up)|sure(ly)?|ok(ay|k)?|alright|right|fine|good|great|perfect|absolut(ely)?|definit(ely)?|certain(ly)?|of\s*course|why\s*not|correct|agreed)\b/i;

// Hindi/Hinglish affirmative morphology — catches "haanji", "haan bhai", "ji haan", etc.
// \b doesn't work with Devanagari, so these are position-flexible.
const AFFIRM_HINDI = /(ह(ाँ|ां)(जी)?|जी(\s*ह(ाँ|ां))?|ज़?रूर|बिल्कुल|पक्का|अच्छा|बढ़िया|सही|चलो|चलता\s*है|चलिए|ठीक(\s*है)?)/;
const AFFIRM_ROMANIZED = /\b(haan(ji)?|han(ji)?|ji(\s*haan)?|zaroor|bilkul|pakka|accha|badhiya|sahi|chalo|chal(ta|iye)|theek(\s*hai)?|done|pakka)\b/i;

// Family 2: Willingness constructions — "I want to", "dekhna chahta hoon"
const WILLINGNESS_EN = /\b(i('d|\s+would)\s+like\s+to|i\s+want\s+to|i('m|\s+am)\s+(ready|willing|interested)|let'?s\s+(do|go|see|visit|schedule|book)|sounds?\s+good|i('m|\s+am)\s+in|count\s+me\s+in|go\s+ahead|do\s+it)\b/i;
const WILLINGNESS_HI = /(चाह(ता|ती|ूँ|ूंगा|ेंगे|िए|ते)\s*(ह(ूँ|ूं|ैं))?|देख(ना|ने|ते|ूँगा|ेंगे|ूंगा)\s*(है|हैं|चाह)?|कर(ना|ने|ें|ो|ते)\s*(है|हैं|चाह)?|कर\s*सकते)/;
const WILLINGNESS_ROMAN = /\b(chah(ta|ti|unga|enge|iye|te)|dekh(na|ne|te|unga|enge)\s*(hai|chahta|chahunga)?|kar(na|ne|en|o|te)\s*(hai|chahta|sakte)?|kar\s*sakte)\b/i;

// Family 3: Imperative acceptance — "book kar do", "schedule karo", "fix it"
const IMPERATIVE_ACCEPT = /\b(book|schedule|fix|confirm|proceed|arrange)\s*(it|kar|karo|कर|करो|कर\s*दो|kr)\b/i;
const IMPERATIVE_HI = /(बुक|शेड्यूल|फिक्स|कन्फर्म)\s*(कर|करो|कर\s*दो|दो|लो|दीजिए)|कर\s*(दो|दीजिए|लो|लीजिए)/;

// ── Rejection / Decline ──────────────────────────────────────────────────────

// Family 1: Explicit disinterest in the entire offer
const REJECT_EXPLICIT = /\b(not\s+interest|no\s+thanks?|no\s+thank\s+you|don'?t\s+call|stop\s+call|remove\s+my\s+number|don'?t\s+want|not\s+looking|leave\s+me\s+alone|please\s+stop)\b/i;
const REJECT_HI = /(interest(ed)?\s*नहीं|नहीं\s*चाहिए|नहीं\s*चाहता|मत\s*करो|बंद\s*करो|मत\s*कर|फ़ोन\s*मत)/;
const REJECT_ROMAN = /\b(interest(ed)?\s+nahi|nahi\s+chah(iye|ta|ti)|mat\s+kar(o)?|band\s+kar(o)?|phone\s+mat)\b/i;

// Family 2: Bare negative — ONLY when contextually a rejection (after offer/visit ask)
const BARE_NEGATIVE = /^(no|nope|nah(i)?|नहीं|ना|नहीं\s*भाई|नहीं\s*जी)\s*[.!]?\s*$/i;

// ── Visit-Specific Rejection ─────────────────────────────────────────────────
// User declines a visit but may want to continue the conversation.

const VISIT_REJECT_PAT = /\b(don'?t\s+want.*visit|no.*visit|not.*site\s*visit|not\s+now|not\s+today|maybe\s+later)\b/i;
const VISIT_REJECT_HI = /(visit\s*(नहीं|nahi|cancel)|site\s*visit\s*(नहीं|nahi)|नहीं\s*.*visit|अभी\s*नहीं|बाद\s*में|रहने\s*दो|फिर\s*कभी|visit\s*नहीं\s*चाहिए)/;
const VISIT_REJECT_ROMAN = /\b(visit\s+nahi|nahi\s+.*visit|abhi\s+nahi|baad\s+mein|rehne\s+do|phir\s+kabhi|nahi\s+chahiye\s*.*visit)\b/i;

// ── Visit / Scheduling Intent ────────────────────────────────────────────────
// User explicitly wants to visit or schedule.

const VISIT_EXPLICIT = /\b(visit|schedule|book\s*(a\s+)?(visit|appointment)|come\s+(see|visit|look)|want\s+to\s+(see|visit|come)|show\s+me)\b/i;
const VISIT_EXPLICIT_HI = /(देखना|देखने|देखेंगे|देख\s*लेते|विज़िट|विजिट|साइट\s*विज़िट|साइट\s*विजिट|site\s*visit|बुक\s*कर)/;
const VISIT_EXPLICIT_ROMAN = /\b(dekhna|dekhne|dekhenge|dekh\s*lete|site\s*visit|visit\s*(karna|karenge|karunga|karte)|chal(enge|te|o)\s*(dekhte|dekhne)|kar\s*sakte|book\s*kar)\b/i;

// ── Question Indicators ──────────────────────────────────────────────────────

// \b doesn't work with Devanagari (non-\w chars), so split into two patterns:
// Latin words use \b; Devanagari words are position-flexible (like AFFIRM_HINDI).
const QUESTION_MARKERS_LATIN = /\b(what|how|where|when|which|why|who|can|does|is\s+there|tell\s+me|kya|kaise|kahan|kab|kaun|kitna|kitne)\b/i;
const QUESTION_MARKERS_HINDI = /(क्या|कैसे|कहाँ|कहां|कब|कौन|कितना|कितने)/;

// ─── Classifier ──────────────────────────────────────────────────────────────

/**
 * Classify user intent from transcript + conversation context.
 *
 * Context-aware: a bare "haan" after a visit offer means VISIT_INTENT,
 * but after a name question it means AGREEMENT. The same utterance can
 * mean different things depending on what was last asked.
 */
export function classifyIntent(
  text: string,
  context: {
    lastAskedField: LastAskedField;
    currentStep: ConversationStep;
    hasDate: boolean;
    hasTime: boolean;
    /** A budget figure was mentioned in THIS utterance (e.g. "10 lakh"). */
    hasBudget?: boolean;
    /** A BHK preference was mentioned in THIS utterance (e.g. "2 BHK"). */
    hasBhk?: boolean;
  },
): ClassifiedIntent {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Substantive NON-scheduling entities supplied this turn (budget / BHK).
  // Date/time are scheduling entities and are handled as visit intent below;
  // budget/BHK are discovery content and must outweigh a leading affirmative
  // so "haan, budget 10 lakh" updates the budget slot instead of booking a visit.
  const hasNonSchedulingEntity = !!context.hasBudget || !!context.hasBhk;

  // ── Priority 1: Visit-specific rejection (before general rejection) ────
  if (VISIT_REJECT_PAT.test(lower) || VISIT_REJECT_HI.test(trimmed) || VISIT_REJECT_ROMAN.test(lower)) {
    return { intent: 'VISIT_REJECT', confidence: 0.9, reason: 'visit_rejection_pattern' };
  }

  // During visit scheduling, simple negatives are visit rejections, not call rejections
  const inVisitScheduling = context.currentStep === 'ASK_VISIT_DAY' ||
    context.currentStep === 'ASK_VISIT_TIME' ||
    context.currentStep === 'VISIT_OFFER';

  // When the active question is budget/BHK collection, a bare affirmative is an
  // answer to THAT, not a visit request. Never infer visit intent from context
  // while discovery slots are being collected (req: question-tracking sync).
  const activeDiscoveryCollection =
    context.lastAskedField === 'budget' || context.lastAskedField === 'bhk';
  // Visit can be inferred from context only when we actually asked about a
  // visit, or we're mid-scheduling — and NOT while collecting budget/BHK.
  const visitContext =
    (context.lastAskedField === 'site_visit_interest' || inVisitScheduling) &&
    !activeDiscoveryCollection;

  if (inVisitScheduling && BARE_NEGATIVE.test(trimmed)) {
    return { intent: 'VISIT_REJECT', confidence: 0.85, reason: 'bare_negative_during_scheduling' };
  }

  // ── Priority 2: Explicit call rejection ────────────────────────────────
  if (REJECT_EXPLICIT.test(lower) || REJECT_HI.test(trimmed) || REJECT_ROMAN.test(lower)) {
    return { intent: 'REJECTION', confidence: 0.9, reason: 'explicit_rejection' };
  }

  // Bare negative after the initial offer = full rejection
  if (context.lastAskedField === 'site_visit_interest' && !inVisitScheduling && BARE_NEGATIVE.test(trimmed)) {
    return { intent: 'REJECTION', confidence: 0.8, reason: 'bare_negative_to_offer' };
  }

  // ── Priority 3: Explicit visit/scheduling intent ───────────────────────
  if (VISIT_EXPLICIT.test(lower) || VISIT_EXPLICIT_HI.test(trimmed) || VISIT_EXPLICIT_ROMAN.test(lower)) {
    return { intent: 'VISIT_INTENT', confidence: 0.95, reason: 'explicit_visit_language' };
  }

  // Volunteering a day or time = implicit visit intent
  if (context.hasDate || context.hasTime) {
    return { intent: 'VISIT_INTENT', confidence: 0.9, reason: 'volunteered_scheduling_entity' };
  }

  // ── Priority 4: Agreement / acceptance ─────────────────────────────────
  const hasAffirmParticle = AFFIRM_PARTICLE.test(lower) || AFFIRM_HINDI.test(trimmed) || AFFIRM_ROMANIZED.test(lower);
  const hasWillingness = WILLINGNESS_EN.test(lower) || WILLINGNESS_HI.test(trimmed) || WILLINGNESS_ROMAN.test(lower);
  const hasImperative = IMPERATIVE_ACCEPT.test(lower) || IMPERATIVE_HI.test(trimmed);

  if (hasWillingness || hasImperative) {
    const hasQuestionMarker = QUESTION_MARKERS_LATIN.test(lower) || QUESTION_MARKERS_HINDI.test(trimmed) || trimmed.includes('?');
    // Willingness/imperative in visit context = visit intent, even with question
    // markers. "कितने बजे कर सकते हैं" in visit context = scheduling intent.
    if (visitContext) {
      // Entity priority: a budget/BHK figure this turn is discovery content.
      // A non-imperative willingness verb ("dekhna chahta hoon") next to it is
      // not scheduling language, so don't infer a visit from context alone.
      if (hasNonSchedulingEntity && !hasImperative) {
        return { intent: 'AGREEMENT', confidence: 0.7, reason: 'entity_priority_over_affirmative' };
      }
      return { intent: 'VISIT_INTENT', confidence: 0.9, reason: hasQuestionMarker ? 'scheduling_question_in_visit_context' : 'willingness_in_visit_context' };
    }
    // Outside visit context, question markers override willingness
    if (hasQuestionMarker) {
      return { intent: 'QUESTION', confidence: 0.75, reason: 'question_with_willingness_verb' };
    }
    return { intent: 'AGREEMENT', confidence: 0.85, reason: 'willingness_construction' };
  }

  if (hasAffirmParticle) {
    // Affirmative after a visit offer/question = visit intent...
    if (visitContext) {
      // ...UNLESS the same utterance carries substantive discovery content
      // (budget/BHK). "haan, budget 10 lakh" is a budget answer prefixed with a
      // courtesy "haan", not a request to book a visit. Entity wins.
      if (hasNonSchedulingEntity) {
        return { intent: 'AGREEMENT', confidence: 0.7, reason: 'entity_priority_over_affirmative' };
      }
      // ...UNLESS the utterance also contains a factual question.
      // "हां property और facilities क्या क्या होंगे" = question with courtesy
      // "हां" prefix, NOT visit agreement. Only treat bare affirmatives (short
      // responses without question markers) as visit intent.
      const hasQuestion = QUESTION_MARKERS_LATIN.test(lower) || QUESTION_MARKERS_HINDI.test(trimmed) || trimmed.includes('?');
      if (hasQuestion) {
        return { intent: 'QUESTION', confidence: 0.75, reason: 'question_overrides_affirmative_in_visit_context' };
      }
      return { intent: 'VISIT_INTENT', confidence: 0.85, reason: 'affirmative_to_visit_ask' };
    }
    return { intent: 'AGREEMENT', confidence: 0.8, reason: 'affirmative_particle' };
  }

  // ── Priority 5: Question ───────────────────────────────────────────────
  if (QUESTION_MARKERS_LATIN.test(lower) || QUESTION_MARKERS_HINDI.test(trimmed) || trimmed.includes('?')) {
    return { intent: 'QUESTION', confidence: 0.7, reason: 'question_markers' };
  }

  // ── Fallback: real content = positive engagement ───────────────────────
  // If the user provides substantive text (not noise), treat as interest
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount >= 3) {
    return { intent: 'QUESTION', confidence: 0.5, reason: 'substantive_utterance' };
  }

  return { intent: 'UNCLEAR', confidence: 0.3, reason: 'insufficient_signal' };
}
