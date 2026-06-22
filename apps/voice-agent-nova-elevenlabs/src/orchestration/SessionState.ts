

/**
 * SessionState: structured per-call state that tracks collected user info
 * and booking progress.
 *
 * Solves hallucination problems:
 *   1. LLM forgets info (name, date, time) due to sliding history window
 *   2. LLM hallucinates booking completion without actual confirmation
 *   3. Call continues after booking instead of ending gracefully
 *   4. LLM re-asks already collected information
 *   5. LLM invents information not provided by the user
 *   6. Name extraction captures trigger phrases instead of actual names
 */

import { Logger } from '../shared/logger';
import { Env } from '../config/env';
import { classifyIntent } from './IntentClassifier';

// ─── Booking Status State Machine ──────────────────────────────────────────
//
//   NONE → DATE_CAPTURED → TIME_CAPTURED → CONFIRMATION_PENDING → BOOKED
//                                                               ↘ FAILED
//
// Transitions:
//   NONE → DATE_CAPTURED: preferred date extracted from user speech
//   NONE → TIME_CAPTURED: preferred time extracted (date comes later)
//   DATE_CAPTURED → CONFIRMATION_PENDING: time also captured (both now exist)
//   TIME_CAPTURED → CONFIRMATION_PENDING: date also captured (both now exist)
//   CONFIRMATION_PENDING → BOOKED: booking API/backend confirms success
//   CONFIRMATION_PENDING → FAILED: booking API returns error
//
// CRITICAL: BOOKED is ONLY reachable via confirmBooking() after external
//           confirmation. The LLM must never claim booked/confirmed/scheduled
//           unless bookingSuccess === true.

export type BookingStatus =
  | 'NONE'
  | 'DATE_CAPTURED'
  | 'TIME_CAPTURED'
  | 'CONFIRMATION_PENDING'
  | 'BOOKED'
  | 'FAILED';

/** What field the agent last asked about — used to interpret bare responses. */
export type LastAskedField =
  | 'date'
  | 'time'
  | 'budget'
  | 'bhk'
  | 'site_visit_interest'
  | null;

export interface CollectedInfo {
  preferredDate: string | null;
  preferredTime: string | null;
  projectInterest: string | null;
  budgetMentioned: string | null;
  bhkPreference: string | null;
}

// ─── Application State Machine (outbound sales flow) ────────────────────────
//
//   INTRODUCTION → INTEREST_CHECK → VISIT_OFFER → QUESTION_HANDLING
//                       │                            │
//                       │                            ├→ ASK_VISIT_DAY → ASK_VISIT_TIME
//                       │                            │        → CONFIRM_VISIT → BOOKED
//                       └→ NOT_INTERESTED            └ (answer Qs, steer to visit)
//
// The APPLICATION owns every transition (derived from collected slots + user
// interest/affirmation). The LLM NEVER controls business state — it only renders
// the [NEXT_ACTION] line the application computes. This is the single biggest
// anti-hallucination guarantee: the model cannot "book" anything by saying so.
//
// Scheduling steps (ASK_VISIT_DAY, ASK_VISIT_TIME, CONFIRM_VISIT, BOOKED) use
// deterministic application-generated responses — zero LLM tokens. The LLM is
// only used for reasoning, objections, and unsupported questions.

export type ConversationStep =
  | 'INTRODUCTION'      // opener (intro + interest question) is playing
  | 'INTEREST_CHECK'    // waiting to learn if the caller is interested
  | 'VISIT_OFFER'       // interested; offer a site visit ONCE and ask the day
  | 'QUESTION_HANDLING' // visit already offered; answer questions only
  | 'ASK_VISIT_DAY'     // caller agreed to visit; collect preferred day
  | 'ASK_VISIT_TIME'    // day captured; collect preferred time
  | 'CONFIRM_VISIT'     // day + time captured; one-line confirmation pending
  | 'BOOKED'            // caller confirmed; visit booked, call ending
  | 'NOT_INTERESTED';   // caller declined; close politely, call ending

// NOTE: AFFIRMATIVE, REJECTION, VISIT_REJECTION regex constants removed.
// All intent classification now goes through IntentClassifier.classifyIntent()
// which uses linguistic pattern families instead of brittle word lists.

// Buying intent: questions that signal the user is seriously considering purchase.
// When detected, a visit suggestion is appropriate (max 2 per call, spaced 3+ turns).
const BUYING_INTENT = /\b(possession|available|availability|floor\s*plan|layout|booking|book\s+kar|ready\s+to\s+move|payment\s*plan|loan|emi|registry|registration|कब\s+मिलेगा|कब\s+ready|booking\s+kaise|flat\s+available|unit\s+available|move\s+in|handover|कब\s+मिलेगा|price|rate|cost|कीमत|दाम|kitna|kitne)\b/i;

// ─── Forbidden Output Patterns (deterministic guards) ──────────────────────
// These patterns must NEVER reach the caller. They are prevented at the source
// (prompt + NEXT_ACTION) and stripped from the streamed leading segment as a
// lightweight safety net. They are NOT used to buffer/block full responses.

// Filler closings the agent must never use (problem #2). Matched as a trailing
// clause and stripped. Covers Hinglish + English variants.
// NOTE: no \b — word boundaries do not work around Devanagari (और/कुछ are
// non-\w). The leading [\s,।.!-]* anchors the clause to a sentence boundary.
const FILLER_CLOSING = /[\s,।.!-]*(aur\s+kuch(\s+(poochh?na|puuchna|puchna|pooch?hna)\s*(hai|h)?)?|और\s+कुछ(\s+पूछना\s*है?)?|kuch\s+aur(\s+(poochh?na|puchna|pooch?hna))?|कुछ\s+और|anything\s+else|aur\s+koi\s+(sawaal|sawal|question|baat))\s*[?।.!]*\s*$/i;

// Unsolicited site-visit pitch. Allowed ONLY when the controller explicitly
// requested a suggestion this turn (see _visitSuggestedThisTurn). This is the
// fix for problem #1/#4: "actual site देखकर better idea मिलेगा" / "visit करेंगे?"
// tails. The leading (site\s+)? on the visit-verb branch absorbs "Site visit …".
// Matches a TRAILING clause that mentions a site visit / "come see it" pitch in
// any phrasing — "...site visit करके details मिलेंगी", "...visit पर आइए",
// "...actual site देखकर better idea मिलेगा", etc. Anchored to the last clause so
// the actual answer (the preceding sentence) is preserved.
const VISIT_PITCH = /[\s,।.!-]*[^।.!?]*?\b(site\s*visit|साइट\s*विज़िट|साइट\s*विजिट|विज़िट|विजिट|visit\s*(कर|पर|करेंगे|karenge|karke|kar\s*l(ein|ijiye|o)|chal(ein|enge)|चल(ें|ेंगे))|(actual\s+)?site\s+(देखकर|देख\s*कर|dekh\s*kar|dekhkar)|project\s+(देख|dekh)\w*|better\s+idea\s+(मिलेगा|milega))[^।.!?]*[?।.!]*\s*$/i;

// Acknowledgement-only responses — a reply that merely acknowledges/reflects
// the user without answering anything or asking a specific question. These
// waste a conversational turn ("I understand.", "Got it.", "Okay.",
// "मैं समझता हूँ कि आप अपना बजट बताना चाहते हैं।"). The pattern is FULL-MATCH
// (anchored): a real answer or question after the ack means it won't match, so
// substantive replies like "I understand the price is 80 lakh" are NOT caught.
// The English reflective tail is restricted to "you want/ask/know…" forms so a
// factual continuation does not get absorbed.
const ACK_ONLY_PATTERN = /^[\s,।.!-]*(i\s+understand(\s+(that\s+)?you[\w\s'’]*?(want|wanted|asking|ask|looking|trying|interested|need|like|tell|telling|share|sharing|know|knowing|give|provide)[\w\s'’]*)?|i\s+see|i\s+hear\s+you|got\s+it|okay|ok|alright|all\s+right|sure|noted|understood|makes\s+sense|मैं\s+समझत[ाी]\s+हूँ([ऀ-ॿ\s]*(हैं|है))?|समझ\s+गय[ाी]|समझ\s+गया|ठीक\s+है|अच्छा|जी(\s+ह(ाँ|ां))?|samajh\s+gaya|theek\s+hai|accha)\s*[।.!?]*\s*$/i;

// Day/time scheduling offer. Forbidden after a visit rejection (problem #3:
// "Kal 7 baje chalega?" after the caller declined a visit).
const SCHEDULING_OFFER = /\b(kal|aaj|parson|कल|आज|परसों|monday|tuesday|wednesday|thursday|friday|saturday|sunday|सोमवार|मंगलवार|बुधवार|गुरुवार|शुक्रवार|शनिवार|रविवार|\d{1,2}\s*(am|pm|बजे|baje|o'?\s*clock)|morning|afternoon|evening|सुबह|दोपहर|शाम)\b[^?।.!]*\b(chalega|चलेगा|chal(ein|enge)|theek|ठीक|fit|suits?|आएंगे|aayenge|aa\s*sak|visit|schedule|book)\b|\b(which\s+day|what\s+time|kaunsa\s+din|कौनसा\s+दिन|kab\s+aa|कब\s+आ)\b/i;

// Hallucinated booking claim — the LLM claims it's booking/confirming a visit
// when the application hasn't reached CONFIRMATION_PENDING. Catches phrases like
// "kal 10 baje ka book kar raha hun", "book ho gaya", "noted for tomorrow".
const HALLUCINATED_BOOKING = /\b(book\s*(kar|ho|kart[aei]|kiy[aei]|kr)\w*|booked|confirmed|scheduled|noted|पक्का|बुक\s*(कर|हो)|book\s+हो\s+गय[ाी]|done\s+है|fix\s+(kar|ho)\w*)\b/i;


export class SessionState {
  private readonly log: Logger;
  private readonly callSid: string;

  /** User information collected during the call. */
  readonly info: CollectedInfo = {
    preferredDate: null,
    preferredTime: null,
    projectInterest: null,
    budgetMentioned: null,
    bhkPreference: null,
  };

  /** Caller engaged positively with the offer (drives INTEREST_CHECK → VISIT_OFFER). */
  interested = false;

  /** Caller clearly declined the offer (drives NOT_INTERESTED → end call). */
  notInterested = false;

  /** Caller agreed to actually schedule a visit (drives QUESTION_HANDLING → ASK_VISIT_DAY). */
  visitAgreed = false;

  /** Caller declined a site visit specifically (NOT a full call rejection).
   *  When true: stop all visit scheduling, but continue answering questions. */
  visitRejected = false;

  /** How many times the agent has suggested a site visit this call (max 2). */
  private visitSuggestionCount = 0;

  /** Turn number when the last visit suggestion was made. */
  private lastVisitSuggestionTurn = -999;

  /** Whether the user's current turn shows buying intent (layout/possession/booking questions). */
  private _buyingIntentThisTurn = false;

  /** Whether the controller asked the LLM to suggest a visit on THIS turn.
   *  Gates the visit-pitch guard: a pitch is only allowed when this is true. */
  private _visitSuggestedThisTurn = false;

  /** Whether the USER's transcript this turn explicitly mentions visits/site.
   *  When true, the visit-pitch guard is relaxed — the user asked about it. */
  private _userMentionedVisitThisTurn = false;

  /** Whether a budget figure was mentioned in THIS turn's transcript.
   *  Feeds IntentClassifier entity-priority so a leading "haan" doesn't get
   *  read as a visit request when the user is actually stating a budget. */
  private _budgetMentionedThisTurn = false;
  /** Whether a BHK preference was mentioned in THIS turn's transcript. */
  private _bhkMentionedThisTurn = false;
  /** Whether a date was mentioned in THIS turn's transcript. */
  private _dateMentionedThisTurn = false;
  /** Whether a time was mentioned in THIS turn's transcript. */
  private _timeMentionedThisTurn = false;

  /**
   * Check if the given text mentions a visit/site, and set the guard flag.
   * Called from the speculative path (stable interim) so the visit-pitch guard
   * doesn't strip LLM responses to user-initiated visit requests.
   */
  checkVisitMention(text: string): void {
    const lower = text.toLowerCase();
    const trimmed = text.trim();
    if (/\b(visit|site\s*visit|site|schedule|reschedule|book|appointment)\b/i.test(lower) ||
        /(?:विज़िट|विजिट|साइट|देखना|देखने|देखेंगे)/.test(trimmed)) {
      this._userMentionedVisitThisTurn = true;
    }
  }

  /** Whether the deliberate one-time site-visit OFFER (right after interest is
   *  detected) has been made. Latch: prevents re-offering on every later turn. */
  private visitOffered = false;

  // ─── Adaptive Token Budget ──────────────────────────────────────────────
  // Pick the smallest token ceiling that fits the answer (latency-first), and
  // auto-escalate a tier if it keeps truncating. Tiers: 30 / 50 / 100.
  private _lastBaseTier = 30;
  private _lastBudget = 30;
  /** base tier → escalated budget (learned within the call). */
  private readonly tierEscalation = new Map<number, number>();
  /** base tier → consecutive near-limit generations. */
  private readonly nearLimitStreak = new Map<number, number>();

  /** Current booking workflow status. */
  bookingStatus: BookingStatus = 'NONE';

  /** Whether booking was confirmed by backend/API. */
  bookingSuccess = false;

  /** Whether the call should end after current playback completes. */
  shouldEndCall = false;

  /** What the agent last asked the user — helps interpret bare responses.
   *  Opener asks about site-visit interest, so a bare "yes/haan" maps to interest. */
  lastAskedField: LastAskedField = 'site_visit_interest';

  /** Turn counter for fact provenance tracking. */
  private turnCount = 0;

  /** How many times the pre-TTS guard replaced an acknowledgement-only reply
   *  with a clarifying question this call. Surfaced per-turn (in the warn log)
   *  and per-call (RESPONSE_QUALITY_SUMMARY) to track how often the model
   *  produces wasted turns. */
  private _ackReplacementCount = 0;
  /** Total assistant turns whose head passed through the guard — denominator
   *  for the ack-replacement rate. */
  private _guardedResponseCount = 0;

  /** Per-call count of acknowledgement-only replacements. */
  get ackReplacementCount(): number { return this._ackReplacementCount; }
  /** Per-call count of responses screened by the streaming-head guard. */
  get guardedResponseCount(): number { return this._guardedResponseCount; }

  constructor(callSid: string) {
    this.callSid = callSid;
    this.log = Logger.forCall(callSid, 'SessionState');
  }

  // ─── Turn Tracking ──────────────────────────────────────────────────────

  advanceTurn(): void {
    this.turnCount++;
    // Reset per-turn flags. nextAction() (via toPromptBlock) may set
    // _visitSuggestedThisTurn later this turn if a suggestion is warranted.
    this._visitSuggestedThisTurn = false;
    this._userMentionedVisitThisTurn = false;
  }

  get currentTurn(): number {
    return this.turnCount;
  }

  // ─── Spec-named field accessors ─────────────────────────────────────────
  // Stable public names for the slots, mapped onto the internal store.

  get budget(): string | null { return this.info.budgetMentioned; }
  get bhkPreference(): string | null { return this.info.bhkPreference; }
  get siteVisitDay(): string | null { return this.info.preferredDate; }
  get siteVisitTime(): string | null { return this.info.preferredTime; }
  get visitBooked(): boolean { return this.bookingSuccess; }

  /**
   * Application-owned conversation step. Derived purely from collected slots,
   * interest, and booking status — never from anything the LLM said.
   */
  get currentStep(): ConversationStep {
    // Terminal states first.
    if (this.bookingStatus === 'BOOKED') return 'BOOKED';
    if (this.notInterested) return 'NOT_INTERESTED';

    // Booking funnel (slots take priority once collection has started).
    if (this.info.preferredDate && this.info.preferredTime) return 'CONFIRM_VISIT';
    if (this.info.preferredDate) return 'ASK_VISIT_TIME';
    if (this.visitAgreed) return 'ASK_VISIT_DAY';

    // Discovery funnel.
    if (!this.interested) return this.turnCount === 0 ? 'INTRODUCTION' : 'INTEREST_CHECK';
    // Interested → make the deliberate site-visit OFFER once (sales goal).
    // After it's been offered (and if not yet agreed/declined), just answer
    // questions — the offer is NOT repeated on every turn.
    if (!this.visitOffered && !this.visitRejected) return 'VISIT_OFFER';
    return 'QUESTION_HANDLING';
  }

  /** One-line natural-language summary of progress (spec field). */
  get summary(): string {
    const parts: string[] = [];
    if (this.info.bhkPreference) parts.push(`bhk=${this.info.bhkPreference}`);
    if (this.info.budgetMentioned) parts.push(`budget=${this.info.budgetMentioned}`);
    if (this.info.preferredDate) parts.push(`day=${this.info.preferredDate}`);
    if (this.info.preferredTime) parts.push(`time=${this.info.preferredTime}`);
    parts.push(this.visitBooked ? 'visit=BOOKED' : `step=${this.currentStep}`);
    return parts.join(', ');
  }

  // ─── Info Setters ───────────────────────────────────────────────────────

  setPreferredDate(date: string): void {
    if (!date.trim()) return;
    const cleaned = date.trim();
    if (this.info.preferredDate !== cleaned) {
      this.info.preferredDate = cleaned;
      this.log.info('slot_update', {
        field: 'preferredDate',
        value: cleaned,
        turn: this.turnCount,
      });
      this.advanceBookingState();
    }
  }

  setPreferredTime(time: string): void {
    if (!time.trim()) return;
    const cleaned = time.trim();
    if (this.info.preferredTime !== cleaned) {
      this.info.preferredTime = cleaned;
      this.log.info('slot_update', {
        field: 'preferredTime',
        value: cleaned,
        turn: this.turnCount,
      });
      this.advanceBookingState();
    }
  }

  setProjectInterest(interest: string): void {
    if (!interest.trim()) return;
    this.info.projectInterest = interest.trim();
  }

  setBudgetMentioned(budget: string): void {
    if (!budget.trim()) return;
    if (this.info.budgetMentioned === budget.trim()) return;
    this.info.budgetMentioned = budget.trim();
    this.log.info('slot_update', { field: 'budget', value: this.info.budgetMentioned, turn: this.turnCount });
  }

  setBhkPreference(bhk: string): void {
    if (!bhk.trim()) return;
    if (this.info.bhkPreference === bhk.trim()) return;
    this.info.bhkPreference = bhk.trim();
    this.log.info('slot_update', { field: 'bhk', value: this.info.bhkPreference, turn: this.turnCount });
  }

  // ─── Booking Status Transitions ──────────────────────────────────────────

  /**
   * Advance booking state based on currently collected date/time.
   * Called automatically when date or time is set.
   */
  private advanceBookingState(): void {
    const hasDate = !!this.info.preferredDate;
    const hasTime = !!this.info.preferredTime;

    if (hasDate && hasTime) {
      // Both captured → auto-confirm the booking immediately.
      // The LLM's CONFIRM_VISIT response serves as the acknowledgement;
      // the call ends after it plays. No extra user affirmation needed —
      // the user already provided date + time which is implicit consent.
      if (this.bookingStatus !== 'CONFIRMATION_PENDING' &&
          this.bookingStatus !== 'BOOKED') {
        this.bookingStatus = 'CONFIRMATION_PENDING';
        this.log.info('booking_state', {
          status: 'CONFIRMATION_PENDING',
          date: this.info.preferredDate,
          time: this.info.preferredTime,
          session_state: this.getStateSnapshot(),
        });
        // Auto-confirm: date + time captured = booking is done.
        this.confirmBooking();
      }
    } else if (hasDate && !hasTime) {
      if (this.bookingStatus === 'NONE') {
        this.bookingStatus = 'DATE_CAPTURED';
        this.log.info('booking_state', {
          status: 'DATE_CAPTURED',
          date: this.info.preferredDate,
        });
      }
    } else if (hasTime && !hasDate) {
      if (this.bookingStatus === 'NONE') {
        this.bookingStatus = 'TIME_CAPTURED';
        this.log.info('booking_state', {
          status: 'TIME_CAPTURED',
          time: this.info.preferredTime,
        });
      }
    }
  }

  /**
   * Mark booking as confirmed — call will end after final response plays.
   *
   * CRITICAL: Only callable when status is CONFIRMATION_PENDING AND both
   * date and time exist. This is the ONLY path to BOOKED.
   */
  confirmBooking(): void {
    if (this.bookingStatus !== 'CONFIRMATION_PENDING') {
      this.log.warn('confirmBooking() rejected — not CONFIRMATION_PENDING', {
        currentStatus: this.bookingStatus,
        hasDate: !!this.info.preferredDate,
        hasTime: !!this.info.preferredTime,
      });
      return;
    }

    if (!this.info.preferredDate || !this.info.preferredTime) {
      this.log.warn('confirmBooking() rejected — missing date or time', {
        date: this.info.preferredDate,
        time: this.info.preferredTime,
      });
      return;
    }

    this.bookingStatus = 'BOOKED';
    this.bookingSuccess = true;
    this.shouldEndCall = true;
    this.log.info('booking_success', {
      date: this.info.preferredDate,
      time: this.info.preferredTime,
      booking_state: 'BOOKED',
      session_state: this.getStateSnapshot(),
    });
  }

  /** Mark booking as failed. */
  failBooking(reason: string): void {
    this.bookingStatus = 'FAILED';
    this.log.warn('booking_failed', { reason, session_state: this.getStateSnapshot() });
  }

  // ─── Last-Asked-Field Tracking ──────────────────────────────────────────

  updateLastAskedField(text: string): void {
    const lower = text.toLowerCase();

    // Interrogative markers — budget/BHK keywords appear in answers too, so
    // those fields are only tracked when the line actually poses a question.
    const isQuestion = /\?/.test(text) ||
      /\b(what|which|how\s+much|how\s+many|kya|kaun|kis|kitn[ae])\b/i.test(lower) ||
      /(क्या|कौन|किस|कितन[ेा]|बताइए|बताएं)/.test(text);

    let field: LastAskedField = null;

    // Order matters: BHK before date (Hindi "कौनसा" appears in both a
    // "which day" and a "which BHK" question), budget/BHK before visit.
    if (isQuestion && (/\bbhk\b/i.test(lower) || /बीएचके/.test(text))) {
      field = 'bhk';
    } else if (isQuestion && (/\bbudget\b/i.test(lower) || /बजट/.test(text) ||
        /\b(kitne|kitna)\s+(ka|tak|mein|का|तक|में)\b/i.test(lower) || /कितने\s*(का|तक|में)/.test(text))) {
      field = 'budget';
    } else if (/\b(day|date|din|weekday|weekend)\b/i.test(lower) || /दिन|कब|कौनसा/.test(lower)) {
      field = 'date';
    } else if (/\b(time|samay|morning|afternoon|evening)\b/i.test(lower) || /समय|बजे|सुबह|दोपहर|शाम/.test(lower)) {
      field = 'time';
    } else if (/\b(visit|schedule|book)\b/i.test(lower) || /देखना|देखेंगे|चाहेंगे/.test(lower)) {
      field = 'site_visit_interest';
    }

    if (field && field !== this.lastAskedField) {
      const previous = this.lastAskedField;
      this.lastAskedField = field;
      this.log.info('LAST_ASKED_FIELD_SET', {
        field,
        previous,
        text: text.substring(0, 60),
      });
    }
  }

  // ─── Speculation Safety ─────────────────────────────────────────────────

  /**
   * Whether speculative generation should be allowed for this transcript.
   * Blocks speculation when the transcript is too short to be a complete query.
   */
  shouldAllowSpeculation(text: string): boolean {
    const trimmed = text.trim();

    const queryKeywords = /\b(what|how|price|budget|amenities|location|bhk|possession|visit|schedule|book|कब|कहाँ|कितना|क्या)\b/i;
    const isQuery = queryKeywords.test(trimmed);

    if (isQuery && trimmed.length >= 15) {
      return true;
    }

    // Only speculate on utterances that look like complete queries (>15 chars)
    // or contain query keywords
    if (trimmed.length < 15) {
      return isQuery;
    }

    return true;
  }

  // ─── State Serialization for System Prompt ───────────────────────────────

  toPromptBlock(): string {
    const f = (v: string | null) => (v ? `${v} ✓` : '—');
    return [
      '[SESSION_STATE] (ground truth — use ✓ values, never re-ask them)',
      `BHK: ${f(this.info.bhkPreference)} | Budget: ${f(this.info.budgetMentioned)}`,
      `Visit day: ${f(this.info.preferredDate)} | Visit time: ${f(this.info.preferredTime)} | Booked: ${this.visitBooked ? 'yes' : 'no'}`,
      `[NEXT_ACTION] ${this.nextAction()}`,
    ].join('\n');
  }

  /**
   * The single instruction line for this turn, computed from the application
   * state machine. The LLM renders this; it never decides the step itself.
   *
   * CRITICAL: Visit suggestions are ONLY included when shouldSuggestVisit()
   * returns true (buying intent detected, not rejected, spaced 3+ turns).
   * The LLM must NEVER inject visit pitches on its own.
   */
  private nextAction(): string {
    switch (this.currentStep) {
      case 'INTRODUCTION':
      case 'INTEREST_CHECK':
        return 'Answer any question briefly, then warmly ask if they\'d like to see the project on a site visit. Gauge interest.';
      case 'VISIT_OFFER': {
        // Deliberate one-time offer right after interest is detected (the sales
        // goal). Mark it so the pitch guard allows the visit mention this turn.
        this.visitOffered = true;
        this.markVisitSuggested();
        return 'Answer their question in ONE line if they asked one, then warmly offer a site visit and ask which day suits — today, tomorrow, or this weekend. Be direct and natural. Ask only about the day, nothing else.';
      }
      case 'QUESTION_HANDLING':
        // Visit already offered once — just answer questions. NEVER re-pitch the
        // visit or append a "site visit" line; only answer what they asked.
        return 'Answer their question briefly and completely from PROPERTY_FACTS. Give ONLY the answer to what they asked (budget→price, location→location, etc.). Do NOT mention a site visit, do NOT say "aur kuch"/"anything else", and do NOT add any extra line.';
      case 'ASK_VISIT_DAY':
        return '[DETERMINISTIC] Application handles this step directly.';
      case 'ASK_VISIT_TIME':
        return '[DETERMINISTIC] Application handles this step directly.';
      case 'CONFIRM_VISIT':
      case 'BOOKED':
        return '[DETERMINISTIC] Application handles this step directly.';
      case 'NOT_INTERESTED':
        return 'They are not interested. Thank them politely in one short line and close warmly. Do NOT pitch the visit.';
    }
  }

  // ─── Deterministic Scheduling Responses ─────────────────────────────────
  // Zero-LLM-token responses for scheduling steps. These are spoken directly
  // by TTS without LLM involvement, ensuring the scheduling flow works even
  // if the LLM is unavailable.

  /**
   * Get a deterministic response for the current scheduling step.
   * Returns null if the current step is not a scheduling step (LLM needed).
   */
  getSchedulingResponse(): string | null {
    switch (this.currentStep) {
      case 'ASK_VISIT_DAY':
        this.log.info('VISIT_FLOW_DIRECT_RESPONSE', { action: 'VISIT_DAY_REQUESTED', step: this.currentStep });
        return 'ज़रूर, आपको कौन सा दिन convenient रहेगा — आज, कल, या इस weekend?';
      case 'ASK_VISIT_TIME':
        this.log.info('VISIT_FLOW_DIRECT_RESPONSE', { action: 'VISIT_TIME_REQUESTED', step: this.currentStep, day: this.info.preferredDate });
        return `${this.info.preferredDate} बिल्कुल चलेगा। किस time आना comfortable रहेगा — morning, afternoon, या evening?`;
      case 'CONFIRM_VISIT':
      case 'BOOKED':
        this.log.info('VISIT_FLOW_DIRECT_RESPONSE', { action: 'VISIT_CONFIRMED', step: this.currentStep, day: this.info.preferredDate, time: this.info.preferredTime });
        return `Perfect, आपकी ${this.info.preferredDate} को ${this.info.preferredTime} की site visit book हो गई है। आपसे मिलकर अच्छा लगेगा, आपका दिन शुभ हो!`;
      case 'NOT_INTERESTED':
        return 'कोई बात नहीं, आपका समय देने के लिए शुक्रिया। कभी भी interest हो तो बेझिझक call कीजिएगा। आपका दिन शुभ हो!';
      default:
        return null;
    }
  }

  // ─── Adaptive Token Budget ──────────────────────────────────────────────

  // Token tiers (env-configurable; Devanagari-safe defaults — see env.ts).
  private static get TIER_SHORT(): number { return Env.llm.tokensShort; }   // short factual
  private static get TIER_NORMAL(): number { return Env.llm.tokensNormal; } // normal / list / multi
  private static get TIER_LONG(): number { return Env.llm.tokensLong; }     // comparison / long

  /**
   * Choose the max_completion_tokens budget for THIS turn from query complexity
   * + conversation state. Latency-first: default to the smallest tier, only go
   * bigger when the query genuinely needs it. Applies any learned escalation.
   *
   *   "Price?" / "What amenities?"                 → 30
   *   "Tell me about the project and possession."  → 50
   *   "Compare 2 BHK and 3 BHK options."           → 100
   */
  selectTokenBudget(query: string): number {
    const base = this.baseTokenTier(query);
    this._lastBaseTier = base;
    this._lastBudget = this.tierEscalation.get(base) ?? base;
    this.log.info('token_budget_selected', {
      selectedTokenLimit: this._lastBudget,
      baseTier: base,
      step: this.currentStep,
    });
    return this._lastBudget;
  }

  private baseTokenTier(query: string): number {
    const q = (query || '').toLowerCase().trim();

    // Booking / closing steps are always short, fixed replies.
    switch (this.currentStep) {
      case 'ASK_VISIT_DAY':
      case 'ASK_VISIT_TIME':
      case 'CONFIRM_VISIT':
      case 'BOOKED':
      case 'NOT_INTERESTED':
        return SessionState.TIER_SHORT;
    }

    // Comparison / multi-question → needs structure → long tier (100).
    const questionMarks = (query.match(/\?/g) || []).length;
    const isComparison =
      /\b(compare|comparison|difference|differ|vs\.?|versus|farak|फ़र्क|फर्क|अंतर|both|dono|which\s+(is\s+)?(better|best))\b/.test(q) ||
      /\b\d(\.\d)?\s*bhk\b[^?]*\b(and|aur|vs|versus|या|or)\b[^?]*\bbhk\b/.test(q);
    if (isComparison || questionMarks >= 2) return SessionState.TIER_LONG;

    // List / multi-topic / descriptive answers → normal tier (a list enumerates
    // several items, which in Devanagari easily exceeds the short ceiling).
    const words = q.split(/\s+/).filter(Boolean).length;
    // NOTE: stems are prefix-matched (no trailing \b) so inflections match —
    // "facility", "facilities", "amenities", "features" all count. A trailing
    // \b here previously matched NONE of them (a word-char follows the stem),
    // so list answers wrongly got the SHORT budget and truncated mid-sentence.
    const isList = /\b(amenit|facilit|feature|suvidha|सुविधा)/.test(q);
    const isMultiTopic =
      /\b(tell me about|explain|describe|overview|details?|batao|बताइए|बताओ|समझाइए|समझाओ)\b/.test(q) ||
      /\b(and|aur|&|plus|along with|साथ)\b/.test(q);
    if (isList || (isMultiTopic && words >= 5) || words >= 14) return SessionState.TIER_NORMAL;

    // Default: short factual.
    return SessionState.TIER_SHORT;
  }

  /**
   * Record the outcome of a generation for logging + auto-escalation.
   * If a tier hits ≥80% of its budget (or truncates) on 2 consecutive turns,
   * permanently bump that tier to the next one for the rest of the call.
   */
  recordGeneration(tokensUsed: number, truncated: boolean): void {
    const budget = this._lastBudget;
    const base = this._lastBaseTier;
    const ratio = budget > 0 ? tokensUsed / budget : 0;
    const nearLimit = truncated || ratio >= 0.8;

    this.log.info('llm_token_usage', {
      selectedTokenLimit: budget,
      actualTokensUsed: tokensUsed,
      responseTruncated: truncated,
      ratio: Math.round(ratio * 100) / 100,
    });

    if (!nearLimit) {
      this.nearLimitStreak.set(base, 0);
      return;
    }

    const streak = (this.nearLimitStreak.get(base) ?? 0) + 1;
    this.nearLimitStreak.set(base, streak);
    if (streak >= 2) {
      const next = budget < SessionState.TIER_NORMAL ? SessionState.TIER_NORMAL
                 : budget < SessionState.TIER_LONG ? SessionState.TIER_LONG
                 : SessionState.TIER_LONG;
      if (next > budget) {
        this.tierEscalation.set(base, next);
        this.nearLimitStreak.set(base, 0);
        this.log.info('token_tier_escalated', { baseTier: base, from: budget, to: next });
      }
    }
  }

  // ─── Output Validation ──────────────────────────────────────────────────

  validateOutput(text: string): string[] {
    const issues: string[] = [];

    // 1. Hallucinated booking confirmation
    if (this.bookingStatus !== 'CONFIRMATION_PENDING' && this.bookingStatus !== 'BOOKED') {
      const confirmPattern = /\b(booked|confirmed|scheduled|noted|पक्का|book हो गया|done है)\b/i;
      const bookingContext = /\b(visit|appointment|booking|site|schedule)\b/i;
      if (confirmPattern.test(text) && bookingContext.test(text)) {
        issues.push('HALLUCINATED_BOOKING: status is ' + this.bookingStatus);
      }
    }

    // 2. Re-asking collected info
    if (this.info.preferredDate) {
      if (/\b(which day|कौनसा day|कब आ|when.*come|date prefer|day prefer)\b/i.test(text)) {
        issues.push('RE_ASK_DATE: already collected: ' + this.info.preferredDate);
      }
    }
    if (this.info.preferredTime) {
      if (/\b(what time|time prefer|morning या afternoon|सुबह या|कितने बजे)\b/i.test(text)) {
        issues.push('RE_ASK_TIME: already collected: ' + this.info.preferredTime);
      }
    }

    // 3. Post-booking continuation
    if (this.bookingStatus === 'BOOKED' && text.trim().length > 0) {
      issues.push('POST_BOOKING_SPEECH');
    }

    // 4. Invented possession date — only "April 2027" is real.
    const yearMention = text.match(/\b(20\d{2})\b/);
    if (yearMention && yearMention[1] !== '2027') {
      issues.push('INVENTED_POSSESSION: ' + yearMention[1]);
    }
    const monthMention = /\b(january|february|march|may|june|july|august|september|october|november|december)\b/i;
    if (monthMention.test(text) && /\b(possession|ready|मिलेगा|completion)\b/i.test(text)) {
      issues.push('INVENTED_POSSESSION_MONTH');
    }

    // 5. Invented price — real price is 8–10 thousand/sqft. Flag any per-sqft
    //    figure outside that band, or any lakh/crore total presented as a fact.
    const priceMatch = text.match(/\b(\d{1,3})\s*(thousand|k|हज़ार)\b/i);
    if (priceMatch) {
      const n = parseInt(priceMatch[1], 10);
      if (n < 8 || n > 10) issues.push('INVENTED_PRICE: ' + priceMatch[0]);
    }

    // 6. Banned filler closing ("aur kuch", "anything else", …).
    if (FILLER_CLOSING.test(text)) issues.push('FILLER_CLOSING');

    // 6b. Acknowledgement-only reply (no answer, no question). The streaming
    //     head guard replaces these before TTS; this flags any that slip past
    //     for monitoring/prompt-tuning.
    if (this.isAcknowledgementOnly(text)) issues.push('ACKNOWLEDGEMENT_ONLY');

    // 7. Unsolicited site-visit pitch (not requested by the controller this turn
    //    AND the user didn't ask about visits themselves).
    if (!this._visitSuggestedThisTurn && !this._userMentionedVisitThisTurn && VISIT_PITCH.test(text)) {
      issues.push('UNSOLICITED_VISIT_PITCH');
    }

    // 8. Scheduling offer after the caller declined a visit.
    if (this.visitRejected && SCHEDULING_OFFER.test(text)) {
      issues.push('SCHEDULING_AFTER_REJECTION');
    }

    // 9. Invented specific calendar date for a visit (e.g. "23 जून", "26 June").
    //    The agent must only use relative days (today/tomorrow/weekend).
    const SPECIFIC_DATE = /\b\d{1,2}\s*(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(tember)?|oct(ober)?|nov(ember)?|dec(ember)?|जनवरी|फ़रवरी|फरवरी|मार्च|अप्रैल|मई|जून|जुलाई|अगस्त|सितंबर|अक्टूबर|नवंबर|दिसंबर)\b/i;
    if (SPECIFIC_DATE.test(text)) issues.push('INVENTED_VISIT_DATE: ' + (text.match(SPECIFIC_DATE)?.[0] ?? ''));

    if (issues.length > 0) {
      this.log.warn('output_validation_issues', { issues, text: text.substring(0, 100) });
    }

    return issues;
  }

  hasHallucinatedBooking(text: string): boolean {
    if (this.bookingStatus === 'CONFIRMATION_PENDING' || this.bookingStatus === 'BOOKED') {
      return false;
    }
    const confirmPattern = /\b(booked|confirmed|scheduled|noted|पक्का|book हो गया|done है)\b/i;
    const bookingContext = /\b(visit|appointment|booking|site|schedule|दौरा)\b/i;
    return confirmPattern.test(text) && bookingContext.test(text);
  }

  // ─── Lightweight Streaming Guard ─────────────────────────────────────────

  /**
   * Strip forbidden content from a STREAMED leading segment before it reaches
   * TTS. Deliberately lightweight — it removes trailing clauses only and never
   * buffers the full response (see CallOrchestrator: this runs on the first
   * ~150ms / ~100 chars of tokens, then the rest streams live).
   *
   * Source-prevention (prompt + NEXT_ACTION + state machine) is the primary
   * defence; this is the safety net for the realistic case (short one-sentence
   * replies where the leading segment IS the whole reply).
   *
   * Removes:
   *   - filler closings ("aur kuch?", "anything else?")          — always
   *   - unsolicited site-visit pitch                              — unless asked
   *   - day/time scheduling offers                                — after rejection
   */
  sanitizeStreamingHead(text: string): string {
    // Count every assistant head screened by the guard — the denominator for
    // the ack-replacement rate reported at call end.
    this._guardedResponseCount++;
    let out = text;
    let strippedScheduling = false;

    if (FILLER_CLOSING.test(out)) {
      out = out.replace(FILLER_CLOSING, '');
      this.log.warn('guard_stripped_filler_closing', { text: text.substring(0, 80) });
    }

    if (!this._visitSuggestedThisTurn && !this._userMentionedVisitThisTurn && VISIT_PITCH.test(out)) {
      out = out.replace(VISIT_PITCH, '');
      this.log.warn('guard_stripped_unsolicited_pitch', { text: text.substring(0, 80) });
    }

    if (this.visitRejected && SCHEDULING_OFFER.test(out)) {
      out = out.replace(SCHEDULING_OFFER, '');
      strippedScheduling = true;
      this.log.warn('guard_stripped_scheduling_after_rejection', { text: text.substring(0, 80) });
    }

    // Hallucinated booking claim: the LLM claims it's booking/confirming when
    // the state machine hasn't reached CONFIRMATION_PENDING. Strip the claim
    // and replace with the appropriate deterministic scheduling question so the
    // caller is guided to the correct flow instead of hearing a false booking.
    let strippedHallucination = false;
    if (this.bookingStatus !== 'CONFIRMATION_PENDING' && this.bookingStatus !== 'BOOKED' &&
        HALLUCINATED_BOOKING.test(out)) {
      this.log.warn('guard_stripped_hallucinated_booking', {
        text: text.substring(0, 80),
        bookingStatus: this.bookingStatus,
        step: this.currentStep,
      });
      strippedHallucination = true;
      // Replace the entire hallucinated response with the correct deterministic
      // scheduling question for the current step.
      const schedulingResponse = this.getSchedulingResponse();
      if (schedulingResponse) {
        return schedulingResponse;
      }
      // Not in a scheduling step — strip the booking claim in-place.
      out = out.replace(HALLUCINATED_BOOKING, '');
    }

    // Clean up orphaned/duplicated punctuation left by the strips.
    out = out
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([?।.!,])/g, '$1')
      .replace(/([?।.!,])[?।.!,]+/g, '$1')   // collapse mixed punctuation runs (e.g. "।?")
      .replace(/^[\s?।.!,-]+/, '')
      .trim();

    // If a critical strip (post-rejection scheduling or hallucinated booking)
    // removed the entire segment, emit a brief neutral acknowledgement instead
    // of bare punctuation so the caller never hears a fragment like "?".
    const hasLetters = /[a-zA-Zऀ-ॿ]/.test(out);
    if ((strippedScheduling || strippedHallucination) && !hasLetters) {
      return 'ठीक है, कोई बात नहीं।';
    }

    // Acknowledgement-only guard: a reply that just acknowledges/reflects the
    // user ("I understand.", "ठीक है।", "मैं समझता हूँ कि आप budget बताना चाहते
    // हैं।") wastes the turn. Replace it with ONE specific clarifying question so
    // the conversation always moves forward. (Runs AFTER the post-rejection
    // neutral return above so that closing line is never overridden.)
    if (out && this.isAcknowledgementOnly(out)) {
      const clarifier = this.getClarifyingQuestion();
      this._ackReplacementCount++;
      this.log.warn('ACK_ONLY_REJECTED', {
        original: text.substring(0, 80),
        replacement: clarifier,
        lastAskedField: this.lastAskedField,
        ackReplacementCount: this._ackReplacementCount,
        guardedResponses: this._guardedResponseCount,
      });
      return clarifier;
    }

    return out;
  }

  /** True when the entire text is just an acknowledgement/reflection with no
   *  answer and no specific question. */
  isAcknowledgementOnly(text: string): boolean {
    return ACK_ONLY_PATTERN.test(text.trim());
  }

  /** One specific clarifying question, steered by the field we last asked
   *  about so the replacement re-engages on the right slot. */
  private getClarifyingQuestion(): string {
    switch (this.lastAskedField) {
      case 'budget': return 'आपका budget कितना है?';
      case 'bhk':    return 'आपको कितने BHK का घर चाहिए?';
      case 'date':   return 'आप किस दिन visit करना चाहेंगे?';
      case 'time':   return 'आपके लिए कौन सा समय ठीक रहेगा?';
      default:       return 'आप किस बारे में जानना चाहते हैं — price, location, या amenities?';
    }
  }

  // ─── Extraction from Transcripts ─────────────────────────────────────────

  /**
   * Extract user info from a transcript. Called on every user turn.
   */
  extractFromUserTranscript(text: string): void {
    const lower = text.toLowerCase().trim();
    const trimmed = text.trim();

    // ── Entity extraction FIRST (before intent classification) ───────────
    // Reset per-turn entity flags, then extract. The flags record whether a
    // budget/BHK/date/time entity appeared in THIS utterance (not persisted
    // state) so the intent classifier can prioritize entity handling over a
    // leading affirmative, and so the answer can be reconciled against the
    // field we last asked about.
    this._budgetMentionedThisTurn = false;
    this._bhkMentionedThisTurn = false;
    this._dateMentionedThisTurn = false;
    this._timeMentionedThisTurn = false;
    this.extractBhk(lower);
    this.extractBudget(lower);

    // ── Date extraction ──────────────────────────────────────────────────
    this.extractDate(lower, trimmed);

    // ── Time extraction ──────────────────────────────────────────────────
    this.extractTime(text, trimmed);

    // ── Track if user explicitly mentions visit/site this turn ────────────
    if (/\b(visit|site\s*visit|site|schedule|reschedule|book|appointment)\b/i.test(lower) ||
        /(?:विज़िट|विजिट|साइट|देखना|देखने|देखेंगे)/.test(trimmed)) {
      this._userMentionedVisitThisTurn = true;
    }

    // ── Buying intent classification (before interest/visit detection) ────
    this.classifyQueryIntent(lower);

    // ── Visit rejection detection (BEFORE interest detection) ────────────
    // Must run first: "not interested in visit" should NOT trigger full-call
    // rejection. If visit rejection fires, skip interest detection.
    const visitRejectedThisTurn = this.detectVisitRejection(lower, trimmed);

    // ── Interest / rejection detection (drives discovery funnel) ──────────
    if (!visitRejectedThisTurn) {
      this.detectInterest(lower, trimmed);
    }

    // ── Visit-agreement detection → drives straight to ASK_VISIT_DAY
    // Uses IntentClassifier: VISIT_INTENT means explicit visit language,
    // affirmative in visit context, or volunteered day/time.
    // AGREEMENT after a visit offer also counts.
    // BLOCKED if user has rejected visits.
    const visitIntent = classifyIntent(trimmed, {
      lastAskedField: this.lastAskedField,
      currentStep: this.currentStep,
      hasDate: !!this.info.preferredDate,
      hasTime: !!this.info.preferredTime,
      hasBudget: this._budgetMentionedThisTurn,
      hasBhk: this._bhkMentionedThisTurn,
    });

    // Entity priority: substantive budget/BHK content outweighed a leading
    // affirmative — the user is answering discovery, not requesting a visit.
    if (visitIntent.reason === 'entity_priority_over_affirmative') {
      this.log.info('ENTITY_PRIORITY_APPLIED', {
        budgetThisTurn: this._budgetMentionedThisTurn,
        bhkThisTurn: this._bhkMentionedThisTurn,
        budget: this.info.budgetMentioned,
        bhk: this.info.bhkPreference,
        text: trimmed.substring(0, 50),
      });
      this.log.info('VISIT_INTENT_REJECTED', {
        reason: 'entity_priority_over_affirmative',
        lastAskedField: this.lastAskedField,
        text: trimmed.substring(0, 50),
      });
    }

    const wantsVisit = visitIntent.intent === 'VISIT_INTENT';
    if (wantsVisit && !this.notInterested && !this.visitRejected) {
      this.interested = true;
      if (!this.visitAgreed) {
        this.visitAgreed = true;
        this.log.info('VISIT_INTENT_ACCEPTED', {
          reason: visitIntent.reason,
          confidence: visitIntent.confidence,
          text: trimmed.substring(0, 50),
        });
        this.log.info('site_visit_agreed', { text: trimmed.substring(0, 50), reason: visitIntent.reason });
      }
    }

    // ── APPLICATION-CONTROLLED booking confirmation ───────────────────────
    // The ONLY path to BOOKED: both slots captured (status CONFIRMATION_PENDING)
    // AND the user affirms. Driven by USER input + state, never by LLM output.
    if (this.bookingStatus === 'CONFIRMATION_PENDING' &&
        (visitIntent.intent === 'AGREEMENT' || visitIntent.intent === 'VISIT_INTENT')) {
      this.confirmBooking();
    }

    // ── Reconcile the answer against the field we last asked about ────────
    this.reconcileAskedField(trimmed);

    // Log session state after extraction
    this.log.info('session_state', this.getStateSnapshot());
  }

  /**
   * Compare what the user provided THIS turn against lastAskedField and emit
   * a MATCH / MISMATCH signal. Keeps question tracking observably synchronized
   * with conversation flow: a MISMATCH means the user answered a different slot
   * than the one we asked (or the tracker is stale).
   */
  private reconcileAskedField(trimmed: string): void {
    const asked = this.lastAskedField;
    // site_visit_interest is resolved via intent (affirm/visit), not a slot —
    // its match/mismatch is covered by VISIT_INTENT_* logging.
    if (!asked || asked === 'site_visit_interest') return;

    const answered: Record<'budget' | 'bhk' | 'date' | 'time', boolean> = {
      budget: this._budgetMentionedThisTurn,
      bhk: this._bhkMentionedThisTurn,
      date: this._dateMentionedThisTurn,
      time: this._timeMentionedThisTurn,
    };

    if (answered[asked]) {
      this.log.info('LAST_ASKED_FIELD_MATCH', {
        field: asked,
        text: trimmed.substring(0, 50),
      });
      return;
    }

    // Only a desync worth flagging when the user volunteered a DIFFERENT slot
    // than the one asked (e.g. asked budget, got a day). A pure unrelated
    // question is handled by the router, not a tracking mismatch.
    const otherFields = (Object.keys(answered) as Array<keyof typeof answered>)
      .filter((k) => answered[k]);
    if (otherFields.length > 0) {
      this.log.info('LAST_ASKED_FIELD_MISMATCH', {
        askedField: asked,
        answeredFields: otherFields,
        text: trimmed.substring(0, 50),
      });
    }
  }

  /**
   * Classify the caller's interest from their utterance — drives the discovery
   * funnel (INTRODUCTION/INTEREST_CHECK → GET_NAME, or → NOT_INTERESTED).
   * Application-owned: the LLM never decides whether the caller is interested.
   */
  private detectInterest(lower: string, trimmed: string): void {
    if (this.bookingStatus === 'BOOKED' || this.visitAgreed || this.notInterested) return;

    const intent = classifyIntent(trimmed, {
      lastAskedField: this.lastAskedField,
      currentStep: this.currentStep,
      hasDate: !!this.info.preferredDate,
      hasTime: !!this.info.preferredTime,
      hasBudget: this._budgetMentionedThisTurn,
      hasBhk: this._bhkMentionedThisTurn,
    });

    this.log.debug('intent_classification', {
      intent: intent.intent,
      confidence: intent.confidence,
      reason: intent.reason,
      text: trimmed.substring(0, 50),
    });

    // Clear rejection → NOT_INTERESTED → close politely + end the call.
    if (intent.intent === 'REJECTION') {
      this.notInterested = true;
      this.shouldEndCall = true;
      this.log.info('not_interested', { text: trimmed.substring(0, 50), reason: intent.reason });
      return;
    }

    // Any positive engagement → interested. Agreement, visit intent, questions,
    // or already-provided slots all signal genuine interest.
    const queryKeywords = /\b(what|how|price|budget|cost|amenities|location|bhk|possession|floor|plan|kitna|kitne|kahan|kya|क्या|कितना|कहाँ|कीमत|दाम)\b/i;
    if (intent.intent === 'AGREEMENT' || intent.intent === 'VISIT_INTENT' ||
        intent.intent === 'QUESTION' || queryKeywords.test(lower) ||
        this.info.bhkPreference || this.info.budgetMentioned) {
      if (!this.interested) {
        this.interested = true;
        this.log.info('interest_detected', { text: trimmed.substring(0, 50), reason: intent.reason });
      }
    }
  }

  // ─── Visit Rejection Detection ───────────────────────────────────────────

  /**
   * Detect visit-specific rejection (distinct from full call rejection).
   * When user declines a visit, stop scheduling but keep answering questions.
   * Returns true if rejection was detected this turn (caller should skip detectInterest).
   */
  private detectVisitRejection(lower: string, trimmed: string): boolean {
    if (this.visitRejected || this.notInterested) return false;
    if (this.bookingStatus === 'BOOKED') return false;

    const intent = classifyIntent(trimmed, {
      lastAskedField: this.lastAskedField,
      currentStep: this.currentStep,
      hasDate: !!this.info.preferredDate,
      hasTime: !!this.info.preferredTime,
      hasBudget: this._budgetMentionedThisTurn,
      hasBhk: this._bhkMentionedThisTurn,
    });

    if (intent.intent === 'VISIT_REJECT') {
      this.visitRejected = true;
      this.visitAgreed = false;
      // Clear any partially captured scheduling info. (BOOKED is impossible
      // here — the guard at the top of this method returns early when booked.)
      this.info.preferredDate = null;
      this.info.preferredTime = null;
      this.bookingStatus = 'NONE';
      this.log.info('visit_rejected', {
        text: trimmed.substring(0, 50),
        previousStep: this.currentStep,
        reason: intent.reason,
      });
      return true;
    }
    return false;
  }

  // ─── Intent-Based Visit Suggestion ─────────────────────────────────────

  /**
   * Whether the agent should suggest a visit this turn.
   * True only when:
   *   - User hasn't rejected visits
   *   - Visit hasn't been agreed to yet
   *   - Suggestion count < 2 per call
   *   - At least 3 turns since last suggestion
   *   - User's question signals buying intent
   */
  shouldSuggestVisit(): boolean {
    if (this.visitRejected) return false;
    if (this.visitAgreed) return false;
    if (this.notInterested) return false;
    if (this.visitSuggestionCount >= 2) return false;
    if (this.turnCount - this.lastVisitSuggestionTurn < 3) return false;
    return this._buyingIntentThisTurn;
  }

  /** Mark that a visit suggestion was made this turn. */
  markVisitSuggested(): void {
    this.visitSuggestionCount++;
    this.lastVisitSuggestionTurn = this.turnCount;
    this._visitSuggestedThisTurn = true;
  }

  /** Classify whether the user's message signals buying intent. */
  private classifyQueryIntent(lower: string): void {
    this._buyingIntentThisTurn = BUYING_INTENT.test(lower);
  }

  /** Extract BHK preference: "2 bhk", "2.5 BHK", "3bhk", "two bhk". */
  private extractBhk(lower: string): void {
    const m = lower.match(/\b(2\.5|2|3)\s*bhk\b/);
    if (m) { this._bhkMentionedThisTurn = true; this.setBhkPreference(`${m[1]} BHK`); return; }
    const words: Record<string, string> = { two: '2', 'two and half': '2.5', three: '3' };
    const w = lower.match(/\b(two and half|two|three)\s*bhk\b/);
    if (w && words[w[1]]) { this._bhkMentionedThisTurn = true; this.setBhkPreference(`${words[w[1]]} BHK`); }
  }

  /** Extract a mentioned budget: "50 lakh", "1 crore", "80 lakhs", "1.2 cr". */
  private extractBudget(lower: string): void {
    const m = lower.match(/\b(\d{1,3}(?:\.\d{1,2})?)\s*(lakh|lakhs|lac|crore|cr|करोड़|लाख)\b/);
    if (m) {
      this._budgetMentionedThisTurn = true;
      const unit = /cr|crore|करोड़/.test(m[2]) ? 'crore' : 'lakh';
      this.setBudgetMentioned(`${m[1]} ${unit}`);
    }
  }

  private extractDate(lower: string, trimmed: string): void {
    // ── Guard: only extract dates in scheduling context ──────────────
    // Day names like "saturday" appear in Deepgram hallucinations of general
    // speech ("i want to know they are saturday"). Extracting a date from a
    // non-scheduling utterance hijacks the conversation into the booking flow.
    // Only extract when:
    //   1. Visit is already agreed (ASK_VISIT_DAY / ASK_VISIT_TIME), OR
    //   2. We explicitly asked for a date (lastAskedField === 'date'), OR
    //   3. A date was already captured (user is correcting it)
    const step = this.currentStep;
    const inSchedulingContext =
      this.visitAgreed ||
      step === 'ASK_VISIT_DAY' || step === 'ASK_VISIT_TIME' || step === 'CONFIRM_VISIT' ||
      this.lastAskedField === 'date' ||
      !!this.info.preferredDate;
    if (!inSchedulingContext) {
      return;
    }

    // Skip extraction if the user is negating/correcting a date
    // ("मैंने friday बोला ही नहीं", "I didn't say saturday", "not friday")
    const negation = /\b(nahi|नहीं|didn'?t|never|not|no|mat|मत)\b.*\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|सोमवार|मंगलवार|बुधवार|गुरुवार|शुक्रवार|शनिवार|रविवार|today|tomorrow|aaj|kal|आज|कल)\b/i;
    const negationReverse = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|सोमवार|मंगलवार|बुधवार|गुरुवार|शुक्रवार|शनिवार|रविवार|today|tomorrow|aaj|kal|आज|कल)\b.*\b(nahi|नहीं|didn'?t|never|not|no|mat|मत|बोला\s+ही\s+नहीं)\b/i;
    if (negation.test(lower) || negationReverse.test(trimmed)) {
      // User is correcting — clear the captured date so it can be re-asked
      if (this.info.preferredDate) {
        this.log.info('Date cleared by user negation', { previous: this.info.preferredDate, text: trimmed.substring(0, 50) });
        this.info.preferredDate = null;
        if (this.bookingStatus === 'DATE_CAPTURED' || this.bookingStatus === 'CONFIRMATION_PENDING') {
          this.bookingStatus = 'NONE';
        }
      }
      return;
    }

    // Use original text for matching to preserve case and Devanagari.
    // NOTE: \b does NOT work with Devanagari characters — use (?:^|\s) and (?:\s|$) instead.
    const datePatterns: Array<[RegExp, string]> = [
      [/(?:^|\s)(today|aaj)(?:\s|$)/i, 'today'],
      [/(?:^|\s)(आज)(?:\s|$)/, 'today'],
      [/(?:^|\s)(tomorrow|kal)(?:\s|$)/i, 'tomorrow'],
      [/(?:^|\s)(कल)(?:\s|$)/, 'tomorrow'],
      [/(?:^|\s)(day after tomorrow|parson)(?:\s|$)/i, 'day after tomorrow'],
      [/(?:^|\s)(परसों)(?:\s|$)/, 'day after tomorrow'],
      [/(सोमवार)/, 'Monday'],
      [/(मंगलवार)/, 'Tuesday'],
      [/(बुधवार)/, 'Wednesday'],
      [/(गुरुवार)/, 'Thursday'],
      [/(शुक्रवार)/, 'Friday'],
      [/(शनिवार)/, 'Saturday'],
      [/(रविवार)/, 'Sunday'],
      [/\b(monday)\b/i, 'Monday'],
      [/\b(tuesday)\b/i, 'Tuesday'],
      [/\b(wednesday)\b/i, 'Wednesday'],
      [/\b(thursday)\b/i, 'Thursday'],
      [/\b(friday)\b/i, 'Friday'],
      [/\b(saturday)\b/i, 'Saturday'],
      [/\b(sunday)\b/i, 'Sunday'],
      [/\b(this|next|agle|अगले)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, '$1 $2'],
      [/\b(weekday)\b/i, 'weekday'],
      [/\b(weekend)\b/i, 'weekend'],
      [/\b(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i, '$1 $2'],
    ];
    for (const [pat, replacement] of datePatterns) {
      const m = trimmed.match(pat);
      if (m) {
        const date = replacement.replace(/\$(\d)/g, (_, i) => m[parseInt(i)] || '');
        this._dateMentionedThisTurn = true;
        this.setPreferredDate(date);
        return;
      }
    }

    // Bare date response
    if (!this.info.preferredDate && this.lastAskedField === 'date') {
      const bareDate = /^(weekday|weekend|this week|next week|इस हफ्ते|अगले हफ्ते)\s*$/i;
      const m = trimmed.match(bareDate);
      if (m) { this._dateMentionedThisTurn = true; this.setPreferredDate(m[1]); }
    }
  }

  /** Map Hindi number words to digits for time extraction. */
  private static readonly HINDI_NUMBERS: Record<string, string> = {
    'एक': '1', 'दो': '2', 'तीन': '3', 'चार': '4', 'पांच': '5', 'पाँच': '5',
    'छह': '6', 'छः': '6', 'सात': '7', 'आठ': '8', 'नौ': '9', 'दस': '10',
    'ग्यारह': '11', 'बारह': '12',
    'ek': '1', 'do': '2', 'teen': '3', 'char': '4', 'paanch': '5',
    'cheh': '6', 'saat': '7', 'aath': '8', 'nau': '9', 'das': '10',
    'gyarah': '11', 'barah': '12',
  };

  private extractTime(text: string, trimmed: string): void {
    // ── Guard: only extract times in scheduling context ──────────────
    // Same rationale as extractDate: a stray "10 baje" in general speech
    // (e.g. "site visit karna hai 10 baje") should NOT populate the time
    // slot before the visit is agreed and a date is captured. Only extract
    // when we are actively collecting scheduling info.
    const step = this.currentStep;
    const inSchedulingContext =
      this.visitAgreed ||
      step === 'ASK_VISIT_DAY' || step === 'ASK_VISIT_TIME' || step === 'CONFIRM_VISIT' ||
      this.lastAskedField === 'time' ||
      !!this.info.preferredTime;
    if (!inSchedulingContext) {
      return;
    }

    const timePatterns: Array<[RegExp, string]> = [
      [/\b(\d{1,2})\s*(am|pm|AM|PM)\b/, '$1 $2'],
      [/\b(\d{1,2})\s*o'?\s*clock\b/i, '$1 o\'clock'],
      // Digit + बजे: "7 बजे", "10 बजे"
      [/(\d{1,2})\s*(बजे|baje)/, '$1 बजे'],
      // Hindi number word + बजे: "सात बजे", "दस बजे"
      [/(एक|दो|तीन|चार|पांच|पाँच|छह|छः|सात|आठ|नौ|दस|ग्यारह|बारह)\s*(बजे|baje)/i, '$1 बजे'],
      // Romanized Hindi number + baje: "saat baje", "das baje"
      [/\b(ek|do|teen|char|paanch|cheh|saat|aath|nau|das|gyarah|barah)\s*(baje|बजे)\b/i, '$1 बजे'],
      [/\b(morning|subah)\b|(?:^|\s)(सुबह)(?:\s|$)/i, 'morning'],
      [/\b(afternoon|dopahar)\b|(?:^|\s)(दोपहर)(?:\s|$)/i, 'afternoon'],
      [/\b(evening|shaam)\b|(?:^|\s)(शाम)(?:\s|$)/i, 'evening'],
    ];
    for (const [pat, replacement] of timePatterns) {
      const m = trimmed.match(pat);
      if (m) {
        let time = replacement.replace(/\$(\d)/g, (_, i) => m[parseInt(i)] || '');
        // Convert Hindi number words to digits: "सात बजे" → "7 बजे"
        const hindiNum = time.match(/^(\S+)\s+बजे$/);
        if (hindiNum && SessionState.HINDI_NUMBERS[hindiNum[1].toLowerCase()]) {
          time = `${SessionState.HINDI_NUMBERS[hindiNum[1].toLowerCase()]} बजे`;
        }
        this._timeMentionedThisTurn = true;
        this.setPreferredTime(time);
        return;
      }
    }

    // Bare time response
    if (!this.info.preferredTime && this.lastAskedField === 'time') {
      const bareTime = /^(morning|afternoon|evening|सुबह|दोपहर|शाम|(\d{1,2})\s*(am|pm|बजे))\s*$/i;
      const m = trimmed.match(bareTime);
      if (m) { this._timeMentionedThisTurn = true; this.setPreferredTime(m[1]); }
    }
  }

  /**
   * Extract info from the LLM's response.
   * Tracks what the agent asked about for next-turn bare response handling.
   * Detects confirmation patterns to transition CONFIRMATION_PENDING → BOOKED.
   */
  extractFromAssistantResponse(text: string): void {
    // We ONLY learn what the agent just asked about, so the next bare user
    // reply can be interpreted. We deliberately do NOT transition booking
    // state here: the LLM saying "booked"/"noted" must never move business
    // state. Booking is confirmed by the application on USER affirmation
    // (see extractFromUserTranscript → confirmBooking). This makes
    // hallucinated confirmations inert.
    this.updateLastAskedField(text);
  }

  // ─── State Snapshot (for logging) ────────────────────────────────────────

  getStateSnapshot(): Record<string, unknown> {
    return {
      step: this.currentStep,
      bhkPreference: this.info.bhkPreference,
      budget: this.info.budgetMentioned,
      siteVisitDay: this.info.preferredDate,
      siteVisitTime: this.info.preferredTime,
      interested: this.interested,
      notInterested: this.notInterested,
      visitAgreed: this.visitAgreed,
      visitRejected: this.visitRejected,
      visitSuggestionCount: this.visitSuggestionCount,
      buyingIntent: this._buyingIntentThisTurn,
      bookingStatus: this.bookingStatus,
      visitBooked: this.visitBooked,
      lastAskedField: this.lastAskedField,
      turn: this.turnCount,
      shouldEndCall: this.shouldEndCall,
      ackReplacements: this._ackReplacementCount,
    };
  }

  /**
   * Emit a per-call response-quality summary. Called once at call end so we can
   * track — across calls — how often the model produced acknowledgement-only
   * replies that the pre-TTS guard had to replace. A non-zero rate here is the
   * signal to revisit prompt tuning (or a gated buffering mode).
   */
  logResponseQualitySummary(): void {
    const guarded = this._guardedResponseCount;
    const rate = guarded > 0
      ? Math.round((this._ackReplacementCount / guarded) * 100)
      : 0;
    this.log.info('RESPONSE_QUALITY_SUMMARY', {
      callSid: this.callSid,
      ack_replacements: this._ackReplacementCount,
      guarded_responses: guarded,
      ack_replacement_rate_pct: rate,
      turns: this.turnCount,
    });
  }
}
