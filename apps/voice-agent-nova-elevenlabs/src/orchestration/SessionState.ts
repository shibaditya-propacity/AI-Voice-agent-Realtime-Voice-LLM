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
}

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
  };

  /** Current booking workflow status. */
  bookingStatus: BookingStatus = 'NONE';

  /** Whether booking was confirmed by backend/API. */
  bookingSuccess = false;

  /** Whether the call should end after current playback completes. */
  shouldEndCall = false;

  /** What the agent last asked the user — helps interpret bare responses. */
  lastAskedField: LastAskedField = 'name'; // greeting asks for name

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
    this.info.budgetMentioned = budget.trim();
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

    if (/\b(naam|name|नाम)\b/i.test(lower)) {
      this.lastAskedField = 'name';
    } else if (/\b(day|date|din|दिन|weekday|weekend|कब|कौनसा)\b/i.test(lower)) {
      this.lastAskedField = 'date';
    } else if (/\b(time|samay|समय|morning|afternoon|evening|बजे|सुबह|दोपहर|शाम)\b/i.test(lower)) {
      this.lastAskedField = 'time';
    } else if (/\b(visit|देखना|देखेंगे|चाहेंगे|schedule|book)\b/i.test(lower)) {
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
    const lines: string[] = ['[SESSION STATE — GROUND TRUTH — DO NOT CONTRADICT]'];

    lines.push('');
    lines.push('COLLECTED INFO:');
    if (this.info.name) {
      lines.push(`  Caller name: ${this.info.name} ✓`);
    } else {
      lines.push('  Caller name: ❌ NOT COLLECTED');
    }

    if (this.info.preferredDate) {
      lines.push(`  Preferred date: ${this.info.preferredDate} ✓`);
    } else {
      lines.push('  Preferred date: ❌ NOT COLLECTED');
    }

    if (this.info.preferredTime) {
      lines.push(`  Preferred time: ${this.info.preferredTime} ✓`);
    } else {
      lines.push('  Preferred time: ❌ NOT COLLECTED');
    }

    lines.push(`  Booking status: ${this.bookingStatus}`);

    // What to do next
    lines.push('');
    lines.push('PRIORITY: Always answer the user\'s question FIRST. Slot collection is secondary.');
    lines.push('');
    switch (this.bookingStatus) {
      case 'NONE':
        if (!this.info.name) {
          lines.push('YOUR NEXT ACTION: Answer user query if any, then ask name.');
        } else {
          lines.push('YOUR NEXT ACTION: Answer user query if any, then guide toward site visit.');
        }
        break;
      case 'DATE_CAPTURED':
        lines.push('YOUR NEXT ACTION: Answer user query if any, then ask preferred time (morning or afternoon).');
        lines.push('  DO NOT ask for date — already collected.');
        break;
      case 'TIME_CAPTURED':
        lines.push('YOUR NEXT ACTION: Answer user query if any, then ask preferred day (weekday or weekend).');
        lines.push('  DO NOT ask for time — already collected.');
        break;
      case 'CONFIRMATION_PENDING':
        lines.push(`YOUR NEXT ACTION: Confirm booking for ${this.info.preferredDate} ${this.info.preferredTime}.`);
        lines.push('  Say "noted" or "booked" + Thank you. Then STOP.');
        lines.push('  This is your FINAL response. One short confirmation only.');
        break;
      case 'BOOKED':
        lines.push('BOOKING COMPLETE. Say nothing. Call is ending.');
        break;
      case 'FAILED':
        lines.push('Booking failed. Apologize and offer to try again.');
        break;
    }

    lines.push('');
    lines.push('FORBIDDEN (violation = system failure):');
    lines.push('- ❌ Do NOT ask for name/date/time if marked ✓ above.');
    lines.push('- ❌ Do NOT say "booked"/"confirmed"/"noted" unless status is CONFIRMATION_PENDING.');
    lines.push('- ❌ Do NOT invent dates, times, prices, or availability not in FACTS.');
    lines.push('- ❌ Do NOT continue conversation if status is BOOKED.');
    lines.push('- ❌ Do NOT ignore user questions to collect slots. Answer first, then collect.');
    if (this.info.name) {
      lines.push(`- Use "${this.info.name}" once max. Do NOT ask their name again.`);
    }

    return lines.join('\n');
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

    // ── Site visit agreement detection ────────────────────────────────────
    if (this.bookingStatus === 'NONE') {
      const visitContext = /\b(visit|schedule|book|देखना|देखेंगे|site|हाँ|sure|ok)\b/i;
      if (visitContext.test(lower)) {
        // Don't auto-transition — just let the LLM guide the conversation
        this.log.info('site_visit_interest_detected', { text: trimmed.substring(0, 50) });
      }

      // Accept bare "yes"/"haan" if agent just asked about site visit
      if (this.lastAskedField === 'site_visit_interest') {
        const bareYes = /^(yes|yeah|sure|ok|okay|haan|हाँ|हां|जी|जी हाँ|ज़रूर|bilkul|बिल्कुल)\s*$/i;
        if (bareYes.test(trimmed)) {
          this.log.info('site_visit_agreed', { response: trimmed });
        }
      }
    }

    // Log session state after extraction
    this.log.info('session_state', this.getStateSnapshot());
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
      // "my name is Rahul" / "I am Rahul" → "Rahul"
      /(?:my\s+name\s+is|i\s+am|i'm|this\s+is)\s+([a-zA-Z]{2,}(?:\s+[a-zA-Z]{2,})?)\s*$/i,
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
    this.updateLastAskedField(text);

    // Only allow CONFIRMATION_PENDING → BOOKED
    if (this.bookingStatus !== 'CONFIRMATION_PENDING') return;
    if (!this.info.preferredDate || !this.info.preferredTime) return;

    const confirmPattern = /\b(noted|booked|scheduled|confirm|confirmed|done|पक्का|book\b)/i;
    if (confirmPattern.test(text)) {
      this.confirmBooking();
    }
  }

  // ─── State Snapshot (for logging) ────────────────────────────────────────

  getStateSnapshot(): Record<string, unknown> {
    return {
      name: this.info.name,
      preferredDate: this.info.preferredDate,
      preferredTime: this.info.preferredTime,
      bookingStatus: this.bookingStatus,
      bookingSuccess: this.bookingSuccess,
      lastAskedField: this.lastAskedField,
      turn: this.turnCount,
      shouldEndCall: this.shouldEndCall,
    };
  }
}
