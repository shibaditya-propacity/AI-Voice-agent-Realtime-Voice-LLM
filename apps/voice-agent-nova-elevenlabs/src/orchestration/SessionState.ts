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
  | 'name'
  | 'date'
  | 'time'
  | 'site_visit_interest'
  | null;

export interface CollectedInfo {
  name: string | null;
  preferredDate: string | null;
  preferredTime: string | null;
  projectInterest: string | null;
  budgetMentioned: string | null;
  bhkPreference: string | null;
}

// ─── Application State Machine (outbound sales flow) ────────────────────────
//
//   INTRODUCTION → INTEREST_CHECK → GET_NAME → QUESTION_HANDLING
//                       │                            │
//                       │                            ├→ ASK_VISIT_DAY → ASK_VISIT_TIME
//                       │                            │        → CONFIRM_VISIT → BOOKED
//                       └→ NOT_INTERESTED            └ (answer Qs, steer to visit)
//
// The APPLICATION owns every transition (derived from collected slots + user
// interest/affirmation). The LLM NEVER controls business state — it only renders
// the [NEXT_ACTION] line the application computes. This is the single biggest
// anti-hallucination guarantee: the model cannot "book" anything by saying so,
// and it cannot decide the customer is interested or skip the name step.

export type ConversationStep =
  | 'INTRODUCTION'      // opener (intro + interest question) is playing
  | 'INTEREST_CHECK'    // waiting to learn if the caller is interested
  | 'GET_NAME'          // interested; collect the caller's name
  | 'QUESTION_HANDLING' // name known; answer questions, steer toward a visit
  | 'ASK_VISIT_DAY'     // caller agreed to visit; collect preferred day
  | 'ASK_VISIT_TIME'    // day captured; collect preferred time
  | 'CONFIRM_VISIT'     // day + time captured; one-line confirmation pending
  | 'BOOKED'            // caller confirmed; visit booked, call ending
  | 'NOT_INTERESTED';   // caller declined; close politely, call ending

const AFFIRMATIVE = /^(yes|yeah|yep|sure|ok|okay|haan|हाँ|हां|जी|जी हाँ|ज़रूर|बिल्कुल|bilkul|perfect|theek|ठीक|done|book|interested|chahta|चाहता|चाहूँगा)\b/i;

// Clear rejection of the offer (not just "no" to one question). Drives NOT_INTERESTED.
const REJECTION = /\b(not interested|no thanks|no thank you|don'?t call|stop calling|busy|interested नहीं|नहीं चाहिए|mat karo|मत करो|नहीं चाहता|remove my number)\b/i;

// ─── Name Extraction Safety ────────────────────────────────────────────────
// These phrases are TRIGGERS, not names. If the transcript matches one of
// these WITHOUT a following name, the name slot must NOT be filled.

const NAME_TRIGGER_PHRASES = new Set([
  'मेरा नाम', 'mera naam', 'mera name', 'my name', 'my name is',
  'i am', "i'm", 'this is', 'main', 'मैं', 'mai', 'naam', 'नाम',
  'naam hai', 'नाम है', 'मेरा नाम है',
]);

const NAME_FALSE_POSITIVES = new Set([
  'yes', 'no', 'ok', 'okay', 'hello', 'hi', 'sure', 'fine', 'good',
  'bye', 'thanks', 'thank', 'hmm', 'haan', 'nahi', 'nah', 'ji',
  'sir', 'madam', 'please', 'sorry', 'what', 'how', 'when', 'where',
  'who', 'why', 'which', 'the', 'and', 'but', 'not', 'you', 'your',
  'main', 'mai', 'मैं', 'naam', 'नाम', 'mera', 'मेरा', 'hai', 'है',
  'hoon', 'hu', 'hun', 'हूँ', 'हूं', 'speaking', 'here', 'bol',
  'बोल', 'raha', 'rahi', 'रहा', 'रही',
]);

export class SessionState {
  private readonly log: Logger;
  private readonly callSid: string;

  /** User information collected during the call. */
  readonly info: CollectedInfo = {
    name: null,
    preferredDate: null,
    preferredTime: null,
    projectInterest: null,
    budgetMentioned: null,
    bhkPreference: null,
  };

  /** Caller engaged positively with the offer (drives INTEREST_CHECK → GET_NAME). */
  interested = false;

  /** Caller clearly declined the offer (drives NOT_INTERESTED → end call). */
  notInterested = false;

  /** Caller agreed to actually schedule a visit (drives QUESTION_HANDLING → ASK_VISIT_DAY). */
  visitAgreed = false;

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

  constructor(callSid: string) {
    this.callSid = callSid;
    this.log = Logger.forCall(callSid, 'SessionState');
  }

  // ─── Turn Tracking ──────────────────────────────────────────────────────

  advanceTurn(): void {
    this.turnCount++;
  }

  get currentTurn(): number {
    return this.turnCount;
  }

  // ─── Spec-named field accessors ─────────────────────────────────────────
  // Stable public names for the slots, mapped onto the internal store.

  get customerName(): string | null { return this.info.name; }
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
    if (!this.info.name) return 'GET_NAME';
    return 'QUESTION_HANDLING';
  }

  /** One-line natural-language summary of progress (spec field). */
  get summary(): string {
    const parts: string[] = [];
    if (this.info.name) parts.push(`name=${this.info.name}`);
    if (this.info.bhkPreference) parts.push(`bhk=${this.info.bhkPreference}`);
    if (this.info.budgetMentioned) parts.push(`budget=${this.info.budgetMentioned}`);
    if (this.info.preferredDate) parts.push(`day=${this.info.preferredDate}`);
    if (this.info.preferredTime) parts.push(`time=${this.info.preferredTime}`);
    parts.push(this.visitBooked ? 'visit=BOOKED' : `step=${this.currentStep}`);
    return parts.join(', ');
  }

  // ─── Info Setters ───────────────────────────────────────────────────────

  setName(name: string): void {
    if (!name.trim()) return;
    const cleaned = name.trim();
    if (cleaned.length < 2) return;

    // Reject if the "name" is actually a trigger phrase or false positive
    if (NAME_FALSE_POSITIVES.has(cleaned.toLowerCase())) return;
    if (NAME_TRIGGER_PHRASES.has(cleaned.toLowerCase())) return;

    // Reject if it contains only trigger words (multi-word check)
    const words = cleaned.toLowerCase().split(/\s+/);
    if (words.every(w => NAME_FALSE_POSITIVES.has(w) || NAME_TRIGGER_PHRASES.has(w))) return;

    if (this.info.name !== cleaned) {
      this.info.name = cleaned;
      this.log.info('slot_update', {
        field: 'name',
        value: cleaned,
        turn: this.turnCount,
        extracted_name: cleaned,
      });
    }
  }

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
      // Both captured → ready for confirmation
      if (this.bookingStatus !== 'CONFIRMATION_PENDING' &&
          this.bookingStatus !== 'BOOKED') {
        this.bookingStatus = 'CONFIRMATION_PENDING';
        this.log.info('booking_state', {
          status: 'CONFIRMATION_PENDING',
          date: this.info.preferredDate,
          time: this.info.preferredTime,
          session_state: this.getStateSnapshot(),
        });
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
      name: this.info.name,
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

    // NOTE: \b word boundaries do NOT work around Devanagari (नाम is non-\w),
    // so ASCII keywords use \b while Devanagari keywords are matched directly.
    if (/\b(naam|name)\b/i.test(lower) || /नाम/.test(lower)) {
      this.lastAskedField = 'name';
    } else if (/\b(day|date|din|weekday|weekend)\b/i.test(lower) || /दिन|कब|कौनसा/.test(lower)) {
      this.lastAskedField = 'date';
    } else if (/\b(time|samay|morning|afternoon|evening)\b/i.test(lower) || /समय|बजे|सुबह|दोपहर|शाम/.test(lower)) {
      this.lastAskedField = 'time';
    } else if (/\b(visit|schedule|book)\b/i.test(lower) || /देखना|देखेंगे|चाहेंगे/.test(lower)) {
      this.lastAskedField = 'site_visit_interest';
    }
  }

  // ─── Speculation Safety ─────────────────────────────────────────────────

  /**
   * Whether speculative generation should be allowed for this transcript.
   * Blocks speculation when:
   *   - We're waiting for a name (short/incomplete utterances are common)
   *   - The transcript is too short to be a complete query
   */
  shouldAllowSpeculation(text: string): boolean {
    const trimmed = text.trim();

    // Check if this looks like a complete query (contains query keywords)
    const queryKeywords = /\b(what|how|price|budget|amenities|location|bhk|possession|visit|schedule|book|कब|कहाँ|कितना|क्या)\b/i;
    const isQuery = queryKeywords.test(trimmed);

    // Allow speculation for explicit queries regardless of name collection state
    if (isQuery && trimmed.length >= 15) {
      return true;
    }

    // Never speculate during name collection — names arrive in fragments
    // ("मेरा" → "मेरा नाम" → "मेरा नाम शिवा") and speculating on partial
    // name triggers would store trigger phrases as names.
    if (!this.info.name && this.lastAskedField === 'name') {
      return false;
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
      `Name: ${f(this.info.name)} | BHK: ${f(this.info.bhkPreference)} | Budget: ${f(this.info.budgetMentioned)}`,
      `Visit day: ${f(this.info.preferredDate)} | Visit time: ${f(this.info.preferredTime)} | Booked: ${this.visitBooked ? 'yes' : 'no'}`,
      `[NEXT_ACTION] ${this.nextAction()}`,
    ].join('\n');
  }

  /**
   * The single instruction line for this turn, computed from the application
   * state machine. The LLM renders this; it never decides the step itself.
   */
  private nextAction(): string {
    const name = this.info.name ? `${this.info.name} जी` : '';
    switch (this.currentStep) {
      case 'INTRODUCTION':
      case 'INTEREST_CHECK':
        return 'Answer any question briefly, then warmly ask if they\'d like to see the project on a site visit. Gauge interest.';
      case 'GET_NAME':
        return 'They are interested. Answer any question first, then politely ask their name (e.g. "May I know your name?").';
      case 'QUESTION_HANDLING':
        return `Answer their question fully from PROPERTY_FACTS${name ? `, address them as "${name}"` : ''}. Then, as a natural next step, suggest a site visit ("project देखकर clarity बेहतर आएगी" / "actual layout देखने से decision आसान होगा"). Do NOT pitch the visit every single turn.`;
      case 'ASK_VISIT_DAY':
        return `They want to visit. Answer any pending question, then ask ${name ? name + ', ' : ''}which day suits them — weekday or weekend.`;
      case 'ASK_VISIT_TIME':
        return 'Day is set. Ask morning or afternoon. Do NOT ask the day again.';
      case 'CONFIRM_VISIT':
        return `Confirm the visit for ${this.info.preferredDate} ${this.info.preferredTime} in one short line${name ? ` (use "${name}")` : ''}, then thank them. Ask nothing else.`;
      case 'BOOKED':
        return 'Visit is booked. Say a brief warm thank-you only; the call is ending.';
      case 'NOT_INTERESTED':
        return 'They are not interested. Thank them politely in one short line and close warmly. Do NOT pitch the visit.';
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
    if (this.info.name) {
      if (/(?:your name|naam|नाम|what.*call you|आपका\s*नाम)/i.test(text)) {
        issues.push('RE_ASK_NAME: already collected: ' + this.info.name);
      }
    }
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

  // ─── Extraction from Transcripts ─────────────────────────────────────────

  /**
   * Extract user info from a transcript. Called on every user turn.
   *
   * NAME SAFETY: Only extracts the actual person name, never the trigger
   * phrase. If the transcript is "मेरा नाम" without a name following,
   * the name slot stays empty.
   */
  extractFromUserTranscript(text: string): void {
    const lower = text.toLowerCase().trim();
    const trimmed = text.trim();

    // ── Name extraction ──────────────────────────────────────────────────
    if (!this.info.name) {
      this.extractName(trimmed);
    }

    // ── Date extraction ──────────────────────────────────────────────────
    this.extractDate(lower, trimmed);

    // ── Time extraction ──────────────────────────────────────────────────
    this.extractTime(text, trimmed);

    // ── BHK + budget extraction (regex/rules only — never the LLM) ────────
    this.extractBhk(lower);
    this.extractBudget(lower);

    // ── Interest / rejection detection (drives discovery funnel) ──────────
    this.detectInterest(lower, trimmed);

    // ── Visit-agreement detection → drives QUESTION_HANDLING → ASK_VISIT_DAY
    // Explicit visit language, OR a bare yes/haan right after the agent invited
    // a visit, OR the caller volunteering a day/time, all mean "let's schedule".
    // GATED ON NAME: per the flow, we always collect the name before scheduling,
    // so "yes" to the opener marks interest (→ GET_NAME), not agreement to book.
    const visitContext = /\b(visit|schedule|book|appointment|देखना|देखेंगे|देखने|dekhna|dekhenge|chalenge|चलेंगे)\b/i;
    const affirmedVisit = this.lastAskedField === 'site_visit_interest' && AFFIRMATIVE.test(trimmed);
    const wantsVisit = visitContext.test(lower) || affirmedVisit ||
      !!this.info.preferredDate || !!this.info.preferredTime;
    if (wantsVisit && !this.notInterested) {
      this.interested = true;
      if (this.info.name) {
        this.visitAgreed = true;
        this.log.info('site_visit_agreed', { text: trimmed.substring(0, 50) });
      }
    }

    // ── APPLICATION-CONTROLLED booking confirmation ───────────────────────
    // The ONLY path to BOOKED: both slots captured (status CONFIRMATION_PENDING)
    // AND the user affirms. Driven by USER input + state, never by LLM output.
    if (this.bookingStatus === 'CONFIRMATION_PENDING' && AFFIRMATIVE.test(trimmed)) {
      this.confirmBooking();
    }

    // Log session state after extraction
    this.log.info('session_state', this.getStateSnapshot());
  }

  /**
   * Classify the caller's interest from their utterance — drives the discovery
   * funnel (INTRODUCTION/INTEREST_CHECK → GET_NAME, or → NOT_INTERESTED).
   * Application-owned: the LLM never decides whether the caller is interested.
   */
  private detectInterest(lower: string, trimmed: string): void {
    if (this.bookingStatus === 'BOOKED' || this.visitAgreed || this.notInterested) return;

    // Clear rejection → NOT_INTERESTED → close politely + end the call.
    const bareNo = this.lastAskedField === 'site_visit_interest' &&
      /^(no|nope|nah|nahi|नहीं|ना)\b/i.test(trimmed);
    if (REJECTION.test(lower) || bareNo) {
      this.notInterested = true;
      this.shouldEndCall = true;
      this.log.info('not_interested', { text: trimmed.substring(0, 50) });
      return;
    }

    // Any positive engagement → interested. Affirmative to the offer, a real
    // question, or a provided name/BHK/budget all signal genuine interest.
    const queryKeywords = /\b(what|how|price|budget|cost|amenities|location|bhk|possession|floor|plan|kitna|kitne|kahan|kya|क्या|कितना|कहाँ|कीमत|दाम)\b/i;
    if (AFFIRMATIVE.test(trimmed) || queryKeywords.test(lower) ||
        this.info.name || this.info.bhkPreference || this.info.budgetMentioned) {
      if (!this.interested) {
        this.interested = true;
        this.log.info('interest_detected', { text: trimmed.substring(0, 50) });
      }
    }
  }

  /** Extract BHK preference: "2 bhk", "2.5 BHK", "3bhk", "two bhk". */
  private extractBhk(lower: string): void {
    const m = lower.match(/\b(2\.5|2|3)\s*bhk\b/);
    if (m) { this.setBhkPreference(`${m[1]} BHK`); return; }
    const words: Record<string, string> = { two: '2', 'two and half': '2.5', three: '3' };
    const w = lower.match(/\b(two and half|two|three)\s*bhk\b/);
    if (w && words[w[1]]) this.setBhkPreference(`${words[w[1]]} BHK`);
  }

  /** Extract a mentioned budget: "50 lakh", "1 crore", "80 lakhs", "1.2 cr". */
  private extractBudget(lower: string): void {
    const m = lower.match(/\b(\d{1,3}(?:\.\d{1,2})?)\s*(lakh|lakhs|lac|crore|cr|करोड़|लाख)\b/);
    if (m) {
      const unit = /cr|crore|करोड़/.test(m[2]) ? 'crore' : 'lakh';
      this.setBudgetMentioned(`${m[1]} ${unit}`);
    }
  }

  /**
   * Extract the actual person name from text.
   * NEVER stores trigger phrases like "मेरा नाम", "my name is", etc.
   */
  private extractName(text: string): void {
    // Pattern 1: "my name is X", "मेरा नाम X है", "I am X", etc.
    // The captured group is ONLY the name part — never the trigger phrase.
    const namePatterns = [
      // "मेरा नाम शिवा है" → "शिवा"  (name is before है/हूँ)
      // "मेरा नाम शिवा" → "शिवा"
      // "मेरा नाम राम कुमार है" → "राम कुमार"
      // Use non-greedy match + explicit है/हूँ anchor to avoid capturing "है" as part of name
      /(?:मेरा\s+नाम|mera\s+naam|mera\s+name|नाम\s+है)\s+(.+?)\s*(?:है|हूँ|हूं)\s*$/i,
      // Name AFTER the copula है: "मेरा नाम है शिव राय" / "नाम है शिव" → "शिव राय".
      // Deepgram commonly transcribes the "naam hai X" word order. Tried BEFORE the
      // "name before है" patterns so the greedy one below does not capture "है X".
      /(?:मेरा\s+)?नाम\s+है\s+([a-zA-Zऀ-ॿ]{2,}(?:\s+[a-zA-Zऀ-ॿ]{2,})?)\s*$/i,
      // Romanized copula-first: "mera naam hai Shiv Rai" / "naam hai Shiv"
      /(?:mera\s+)?naam\s+hai\s+([a-zA-Z]{2,}(?:\s+[a-zA-Z]{2,})?)\s*$/i,
      // Without trailing है: "मेरा नाम शिवा"
      /(?:मेरा\s+नाम|mera\s+naam|mera\s+name)\s+([a-zA-Zऀ-ॿ]{2,}(?:\s+[a-zA-Zऀ-ॿ]{2,})?)\s*$/i,
      // "my name is Rahul" / "I am Rahul" / "my name is शिवा" → name (English OR Devanagari)
      /(?:my\s+name\s+is|i\s+am|i'm|this\s+is)\s+([a-zA-Zऀ-ॿ]{2,}(?:\s+[a-zA-Zऀ-ॿ]{2,})?)\s*$/i,
      // "Rajesh speaking" / "Rajesh here"
      /^([a-zA-Zऀ-ॿ]{2,}(?:\s+[a-zA-Zऀ-ॿ]{2,})?)\s+(?:speaking|here|bol\s+raha|bol\s+rahi|बोल\s+रहा|बोल\s+रही)/i,
      // "मैं शिवा हूँ" → "शिवा" (Hindi "I am X")
      /^(?:मैं|main|mai)\s+([a-zA-Zऀ-ॿ]{2,}(?:\s+[a-zA-Zऀ-ॿ]{2,})?)\s*(?:हूँ|हूं|hoon|hu|hun)\s*$/i,
    ];

    for (const pat of namePatterns) {
      const m = text.match(pat);
      if (m?.[1]) {
        const candidate = m[1].trim();
        // Validate the extracted name isn't a trigger phrase
        if (!NAME_TRIGGER_PHRASES.has(candidate.toLowerCase()) &&
            !NAME_FALSE_POSITIVES.has(candidate.toLowerCase())) {
          this.setName(candidate);
          return;
        }
      }
    }

    // BARE NAME RESPONSE: If agent just asked for name and user gives
    // a short response (1-3 words), treat it as the name.
    if (this.lastAskedField === 'name') {
      const words = text.split(/\s+/);
      if (words.length >= 1 && words.length <= 3 && !text.includes('?')) {
        // Every word must look like a name part (alphabetic, not a trigger/false positive)
        const allLikeName = words.every(w => {
          const wLower = w.toLowerCase();
          return /^[a-zA-Z\u0900-\u097F]{2,}$/.test(w) &&
            !NAME_FALSE_POSITIVES.has(wLower) &&
            !NAME_TRIGGER_PHRASES.has(wLower);
        });

        if (allLikeName) {
          this.setName(text.trim());
        }
      }
    }
  }

  private extractDate(lower: string, trimmed: string): void {
    // Use original text for matching to preserve case and Devanagari
    const datePatterns: Array<[RegExp, string]> = [
      [/\b(today|aaj|आज)\b/i, 'today'],
      [/\b(tomorrow|kal|कल)\b/i, 'tomorrow'],
      [/\b(day after tomorrow|parson|परसों)\b/i, 'day after tomorrow'],
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
        this.setPreferredDate(date);
        return;
      }
    }

    // Bare date response
    if (!this.info.preferredDate && this.lastAskedField === 'date') {
      const bareDate = /^(weekday|weekend|this week|next week|इस हफ्ते|अगले हफ्ते)\s*$/i;
      const m = trimmed.match(bareDate);
      if (m) this.setPreferredDate(m[1]);
    }
  }

  private extractTime(text: string, trimmed: string): void {
    const timePatterns: Array<[RegExp, string]> = [
      [/\b(\d{1,2})\s*(am|pm|AM|PM)\b/, '$1 $2'],
      [/\b(\d{1,2})\s*o'?\s*clock\b/i, '$1 o\'clock'],
      [/(\d{1,2})\s*(बजे)/, '$1 बजे'],
      [/\b(morning|subah)\b|(?:^|\s)(सुबह)(?:\s|$)/i, 'morning'],
      [/\b(afternoon|dopahar)\b|(?:^|\s)(दोपहर)(?:\s|$)/i, 'afternoon'],
      [/\b(evening|shaam)\b|(?:^|\s)(शाम)(?:\s|$)/i, 'evening'],
    ];
    for (const [pat, replacement] of timePatterns) {
      const m = trimmed.match(pat);
      if (m) {
        const time = replacement.replace(/\$(\d)/g, (_, i) => m[parseInt(i)] || '');
        this.setPreferredTime(time);
        return;
      }
    }

    // Bare time response
    if (!this.info.preferredTime && this.lastAskedField === 'time') {
      const bareTime = /^(morning|afternoon|evening|सुबह|दोपहर|शाम|(\d{1,2})\s*(am|pm|बजे))\s*$/i;
      const m = trimmed.match(bareTime);
      if (m) this.setPreferredTime(m[1]);
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
      name: this.info.name,
      bhkPreference: this.info.bhkPreference,
      budget: this.info.budgetMentioned,
      siteVisitDay: this.info.preferredDate,
      siteVisitTime: this.info.preferredTime,
      interested: this.interested,
      notInterested: this.notInterested,
      visitAgreed: this.visitAgreed,
      bookingStatus: this.bookingStatus,
      visitBooked: this.visitBooked,
      lastAskedField: this.lastAskedField,
      turn: this.turnCount,
      shouldEndCall: this.shouldEndCall,
    };
  }
}
