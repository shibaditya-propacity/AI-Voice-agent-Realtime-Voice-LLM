/**
 * SessionState: structured per-call state that tracks collected user info
 * and booking progress.
 *
 * Solves three problems:
 *   1. LLM forgets info (name, date, time) due to sliding history window
 *   2. LLM hallucinates booking completion without actual confirmation
 *   3. Call continues after booking instead of ending gracefully
 *
 * The state is serialized and injected into the LLM system prompt on every
 * turn, so the model always knows what has been collected and what to ask next.
 */

import { Logger } from '../shared/logger';

// ─── Booking Status State Machine ──────────────────────────────────────────
//
//   NOT_STARTED → COLLECTING_DETAILS → SLOT_SELECTED → BOOKED
//                                                    ↘ FAILED
//
// Transitions:
//   NOT_STARTED → COLLECTING_DETAILS: user agrees to site visit
//   COLLECTING_DETAILS → SLOT_SELECTED: date AND time both collected
//   SLOT_SELECTED → BOOKED: LLM confirms the booking in its response
//   SLOT_SELECTED → FAILED: (future) booking API returns error

export type BookingStatus =
  | 'NOT_STARTED'
  | 'COLLECTING_DETAILS'
  | 'SLOT_SELECTED'
  | 'BOOKED'
  | 'FAILED';

export interface CollectedInfo {
  name: string | null;
  preferredDate: string | null;
  preferredTime: string | null;
  projectInterest: string | null;
  budgetMentioned: string | null;
}

export class SessionState {
  private readonly log: Logger;

  /** User information collected during the call. */
  readonly info: CollectedInfo = {
    name: null,
    preferredDate: null,
    preferredTime: null,
    projectInterest: null,
    budgetMentioned: null,
  };

  /** Current booking workflow status. */
  bookingStatus: BookingStatus = 'NOT_STARTED';

  /** Whether the call should end after current playback completes. */
  shouldEndCall = false;

  constructor(callSid: string) {
    this.log = Logger.forCall(callSid, 'SessionState');
  }

  // ─── Info Setters (idempotent — only update if not already set) ──────────

  setName(name: string): void {
    if (!name.trim()) return;
    const cleaned = name.trim();
    if (this.info.name !== cleaned) {
      this.info.name = cleaned;
      this.log.info('Name collected', { name: cleaned });
    }
  }

  setPreferredDate(date: string): void {
    if (!date.trim()) return;
    const cleaned = date.trim();
    if (this.info.preferredDate !== cleaned) {
      this.info.preferredDate = cleaned;
      this.log.info('Date collected', { date: cleaned });
      this.checkSlotComplete();
    }
  }

  setPreferredTime(time: string): void {
    if (!time.trim()) return;
    const cleaned = time.trim();
    if (this.info.preferredTime !== cleaned) {
      this.info.preferredTime = cleaned;
      this.log.info('Time collected', { time: cleaned });
      this.checkSlotComplete();
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

  /** User agreed to a site visit — start collecting date/time. */
  startCollecting(): void {
    if (this.bookingStatus === 'NOT_STARTED') {
      this.bookingStatus = 'COLLECTING_DETAILS';
      this.log.info('Booking status → COLLECTING_DETAILS');
    }
  }

  /** Check if both date and time are collected → SLOT_SELECTED. */
  private checkSlotComplete(): void {
    if (this.bookingStatus === 'NOT_STARTED') {
      this.bookingStatus = 'COLLECTING_DETAILS';
    }
    if (
      this.bookingStatus === 'COLLECTING_DETAILS' &&
      this.info.preferredDate &&
      this.info.preferredTime
    ) {
      this.bookingStatus = 'SLOT_SELECTED';
      this.log.info('Booking status → SLOT_SELECTED', {
        date: this.info.preferredDate,
        time: this.info.preferredTime,
      });
    }
  }

  /** LLM confirmed the booking — mark as BOOKED and schedule call end. */
  confirmBooking(): void {
    if (this.bookingStatus === 'SLOT_SELECTED' || this.bookingStatus === 'COLLECTING_DETAILS') {
      this.bookingStatus = 'BOOKED';
      this.shouldEndCall = true;
      this.log.info('Booking status → BOOKED — call will end after playback', {
        name: this.info.name,
        date: this.info.preferredDate,
        time: this.info.preferredTime,
      });
    }
  }

  // ─── State Serialization for System Prompt ───────────────────────────────

  /**
   * Returns a concise state block to inject into the LLM system prompt.
   * This ensures the LLM always knows what info has been collected, what
   * to ask next, and whether it can confirm a booking.
   */
  toPromptBlock(): string {
    const lines: string[] = ['[SESSION STATE — DO NOT ASK FOR INFO ALREADY COLLECTED]'];

    // Collected info
    if (this.info.name) {
      lines.push(`Caller name: ${this.info.name}`);
    } else {
      lines.push('Caller name: NOT YET COLLECTED');
    }

    lines.push(`Booking status: ${this.bookingStatus}`);

    if (this.info.preferredDate) {
      lines.push(`Preferred date: ${this.info.preferredDate}`);
    }
    if (this.info.preferredTime) {
      lines.push(`Preferred time: ${this.info.preferredTime}`);
    }

    // What to do next
    switch (this.bookingStatus) {
      case 'NOT_STARTED':
        lines.push('NEXT: Collect name if missing. Guide toward site visit.');
        break;
      case 'COLLECTING_DETAILS':
        if (!this.info.preferredDate) {
          lines.push('NEXT: Ask preferred day (weekday or weekend).');
        } else if (!this.info.preferredTime) {
          lines.push('NEXT: Ask preferred time (morning or afternoon).');
        }
        break;
      case 'SLOT_SELECTED':
        lines.push(`NEXT: Confirm booking for ${this.info.preferredDate} ${this.info.preferredTime}. Say "noted" or "booked" and Thank you. Then STOP.`);
        lines.push('CRITICAL: This is the FINAL response. Say one short confirmation + Thank you. Nothing else.');
        break;
      case 'BOOKED':
        lines.push('BOOKING COMPLETE. Do not continue conversation. Say nothing.');
        break;
      case 'FAILED':
        lines.push('Booking failed. Apologize and offer to try again.');
        break;
    }

    // Anti-hallucination rules
    lines.push('');
    lines.push('RULES:');
    lines.push('- NEVER re-ask for information shown above as collected.');
    lines.push('- NEVER say booking is done unless status is BOOKED.');
    lines.push('- NEVER fabricate availability or booking success.');
    if (this.info.name) {
      lines.push(`- Address caller as "${this.info.name}" naturally (max once per response).`);
    }

    return lines.join('\n');
  }

  // ─── Extraction from Transcripts ─────────────────────────────────────────

  /**
   * Extract user info from a transcript. Called on every user turn.
   * Uses simple patterns — fast and reliable for phone conversations.
   */
  extractFromUserTranscript(text: string): void {
    const lower = text.toLowerCase().trim();

    // ── Name extraction ──────────────────────────────────────────────────
    // Patterns: "my name is X", "I am X", "mera naam X", "X speaking"
    if (!this.info.name) {
      const namePatterns = [
        /(?:my name is|i am|i'm|this is|mera naam|mera name|naam)\s+([a-zA-Z\u0900-\u097F]{2,}(?:\s+[a-zA-Z\u0900-\u097F]{2,})?)/i,
        /^([a-zA-Z\u0900-\u097F]{2,}(?:\s+[a-zA-Z\u0900-\u097F]{2,})?)\s+(?:speaking|here|bol raha|bol rahi)/i,
      ];
      for (const pat of namePatterns) {
        const m = text.match(pat);
        if (m?.[1]) {
          // Filter out common false positives
          const candidate = m[1].trim();
          const falsePositives = ['yes', 'no', 'ok', 'okay', 'hello', 'hi', 'sure', 'fine', 'good'];
          if (!falsePositives.includes(candidate.toLowerCase())) {
            this.setName(candidate);
            break;
          }
        }
      }
    }

    // ── Date extraction ──────────────────────────────────────────────────
    const datePatterns: Array<[RegExp, string]> = [
      [/\b(today|aaj)\b/i, 'today'],
      [/\b(tomorrow|kal)\b/i, 'tomorrow'],
      [/\b(day after tomorrow|parson)\b/i, 'day after tomorrow'],
      [/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, '$1'],
      [/\b(this|next)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, '$1 $2'],
      [/\b(weekday)\b/i, 'weekday'],
      [/\b(weekend)\b/i, 'weekend'],
      [/\b(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i, '$1 $2'],
    ];
    for (const [pat, replacement] of datePatterns) {
      const m = lower.match(pat);
      if (m) {
        const date = replacement.replace(/\$(\d)/g, (_, i) => m[parseInt(i)] || '');
        this.setPreferredDate(date);
        // If we also extracted a time from the same utterance, the date
        // change already triggered checkSlotComplete.
        break;
      }
    }

    // ── Time extraction ──────────────────────────────────────────────────
    const timePatterns: Array<[RegExp, string]> = [
      [/\b(\d{1,2})\s*(am|pm|AM|PM)\b/, '$1 $2'],
      [/\b(\d{1,2})\s*o'?\s*clock\b/i, '$1 o\'clock'],
      [/\b(\d{1,2})\s*(बजे)\b/, '$1 बजे'],
      [/\b(morning|subah|सुबह)\b/i, 'morning'],
      [/\b(afternoon|dopahar|दोपहर)\b/i, 'afternoon'],
      [/\b(evening|shaam|शाम)\b/i, 'evening'],
    ];
    for (const [pat, replacement] of timePatterns) {
      const m = text.match(pat);
      if (m) {
        const time = replacement.replace(/\$(\d)/g, (_, i) => m[parseInt(i)] || '');
        this.setPreferredTime(time);
        break;
      }
    }

    // ── Site visit agreement detection ────────────────────────────────────
    if (this.bookingStatus === 'NOT_STARTED') {
      const agreePatterns = /\b(yes|yeah|sure|ok|okay|haan|हाँ|हां|चाहिए|चाहेंगे|schedule|book|visit|देखना|देखेंगे)\b/i;
      // Only trigger if this looks like an agreement to visit
      // (not just answering a question with "yes")
      if (agreePatterns.test(lower) && /\b(visit|schedule|book|देखना|देखेंगे|site|हाँ|sure|ok)\b/i.test(lower)) {
        this.startCollecting();
      }
    }
  }

  /**
   * Extract info from the LLM's response. Detects booking confirmation
   * patterns to transition to BOOKED state.
   */
  extractFromAssistantResponse(text: string): void {
    // Only check for booking confirmation if slot is selected or collecting
    if (this.bookingStatus !== 'SLOT_SELECTED' && this.bookingStatus !== 'COLLECTING_DETAILS') {
      return;
    }

    // If both date and time exist and LLM uses confirmation language → BOOKED
    if (this.info.preferredDate && this.info.preferredTime) {
      const confirmPattern = /\b(noted|booked|scheduled|confirm|confirmed|done|पक्का|book\b)/i;
      const thankPattern = /\b(thank|धन्यवाद|शुक्रिया)\b/i;

      if (confirmPattern.test(text) && thankPattern.test(text)) {
        this.confirmBooking();
      } else if (confirmPattern.test(text)) {
        // Confirmation without thank you — still mark as booked
        this.confirmBooking();
      }
    }
  }
}
