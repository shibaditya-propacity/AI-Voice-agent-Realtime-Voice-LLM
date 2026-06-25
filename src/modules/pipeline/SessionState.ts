/**
 * SessionState: structured per-call state that tracks collected user info
 * and booking progress. Solves hallucination problems.
 */

import { Logger } from '../../shared/Logger';
import { buildEnrichmentDirective } from '../conversation/ResponseEnrichment';
import { PROPERTY_FACTS } from '../conversation/PropertyFacts';
import { detectPreferenceChanges } from '../conversation/PreferenceChangeDetector';

export type BookingStatus =
  | 'NONE'
  | 'DATE_CAPTURED'
  | 'TIME_CAPTURED'
  | 'CONFIRMATION_PENDING'
  | 'BOOKED'
  | 'FAILED';

export type LastAskedField = 'name' | 'date' | 'time' | 'site_visit_interest' | null;

export interface CollectedInfo {
  name: string | null;
  preferredDate: string | null;
  preferredTime: string | null;
  projectInterest: string | null;
  budgetMentioned: string | null;
  bhkPreference: string | null;
}

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

  readonly info: CollectedInfo = {
    name: null,
    preferredDate: null,
    preferredTime: null,
    projectInterest: null,
    budgetMentioned: null,
    bhkPreference: null,
  };

  bookingStatus: BookingStatus = 'NONE';
  bookingSuccess = false;
  shouldEndCall = false;
  lastAskedField: LastAskedField = 'name';

  /** Last user utterance — used for intent-based response enrichment. */
  private lastUserText = '';
  private turnCount = 0;

  constructor(callSid: string) {
    this.callSid = callSid;
    this.log = Logger.forCall(callSid, 'SessionState');
  }

  advanceTurn(): void { this.turnCount++; }
  get currentTurn(): number { return this.turnCount; }

  setName(name: string): void {
    if (!name.trim()) return;
    const cleaned = name.trim();
    if (cleaned.length < 2) return;
    if (NAME_FALSE_POSITIVES.has(cleaned.toLowerCase())) return;
    if (NAME_TRIGGER_PHRASES.has(cleaned.toLowerCase())) return;
    const words = cleaned.toLowerCase().split(/\s+/);
    if (words.every(w => NAME_FALSE_POSITIVES.has(w) || NAME_TRIGGER_PHRASES.has(w))) return;
    if (this.info.name !== cleaned) {
      this.info.name = cleaned;
      this.log.info('slot_update', { field: 'name', value: cleaned, turn: this.turnCount });
    }
  }

  setPreferredDate(date: string): void {
    if (!date.trim()) return;
    const cleaned = date.trim();
    if (this.info.preferredDate !== cleaned) {
      this.info.preferredDate = cleaned;
      this.log.info('slot_update', { field: 'preferredDate', value: cleaned, turn: this.turnCount });
      this.advanceBookingState();
    }
  }

  setPreferredTime(time: string): void {
    if (!time.trim()) return;
    const cleaned = time.trim();
    if (this.info.preferredTime !== cleaned) {
      this.info.preferredTime = cleaned;
      this.log.info('slot_update', { field: 'preferredTime', value: cleaned, turn: this.turnCount });
      this.advanceBookingState();
    }
  }

  setProjectInterest(interest: string): void {
    if (!interest.trim()) return;
    this.info.projectInterest = interest.trim();
  }

  setBudgetMentioned(budget: string, isCorrection = false): void {
    if (!budget.trim()) return;
    const cleaned = budget.trim();
    if (this.info.budgetMentioned === cleaned) return;
    if (this.info.budgetMentioned && isCorrection) {
      this.log.info('SESSION_FIELD_UPDATED', {
        field: 'budget',
        oldValue: this.info.budgetMentioned,
        newValue: cleaned,
        turn: this.turnCount,
      });
    } else if (!this.info.budgetMentioned) {
      this.log.info('slot_update', { field: 'budgetMentioned', value: cleaned, turn: this.turnCount });
    }
    this.info.budgetMentioned = cleaned;
  }

  setBhkPreference(bhk: string, isCorrection = false): void {
    if (!bhk.trim()) return;
    const cleaned = bhk.trim();
    if (this.info.bhkPreference === cleaned) return;
    if (this.info.bhkPreference && isCorrection) {
      this.log.info('SESSION_FIELD_UPDATED', {
        field: 'bhk',
        oldValue: this.info.bhkPreference,
        newValue: cleaned,
        turn: this.turnCount,
      });
    } else if (!this.info.bhkPreference) {
      this.log.info('slot_update', { field: 'bhkPreference', value: cleaned, turn: this.turnCount });
    }
    this.info.bhkPreference = cleaned;
  }

  private advanceBookingState(): void {
    const hasDate = !!this.info.preferredDate;
    const hasTime = !!this.info.preferredTime;

    if (hasDate && hasTime) {
      if (this.bookingStatus !== 'CONFIRMATION_PENDING' && this.bookingStatus !== 'BOOKED') {
        this.bookingStatus = 'CONFIRMATION_PENDING';
        this.log.info('booking_state', { status: 'CONFIRMATION_PENDING', date: this.info.preferredDate, time: this.info.preferredTime });
      }
    } else if (hasDate && !hasTime) {
      if (this.bookingStatus === 'NONE') {
        this.bookingStatus = 'DATE_CAPTURED';
        this.log.info('booking_state', { status: 'DATE_CAPTURED', date: this.info.preferredDate });
      }
    } else if (hasTime && !hasDate) {
      if (this.bookingStatus === 'NONE') {
        this.bookingStatus = 'TIME_CAPTURED';
        this.log.info('booking_state', { status: 'TIME_CAPTURED', time: this.info.preferredTime });
      }
    }
  }

  confirmBooking(): void {
    if (this.bookingStatus !== 'CONFIRMATION_PENDING') return;
    if (!this.info.preferredDate || !this.info.preferredTime) return;

    this.bookingStatus = 'BOOKED';
    this.bookingSuccess = true;
    this.shouldEndCall = true;
    this.log.info('booking_success', {
      name: this.info.name, date: this.info.preferredDate, time: this.info.preferredTime,
    });
  }

  failBooking(reason: string): void {
    this.bookingStatus = 'FAILED';
    this.log.warn('booking_failed', { reason });
  }

  updateLastAskedField(text: string): void {
    const lower = text.toLowerCase();
    if (/\b(naam|name|नाम)\b/i.test(lower)) this.lastAskedField = 'name';
    else if (/\b(day|date|din|दिन|weekday|weekend|कब|कौनसा)\b/i.test(lower)) this.lastAskedField = 'date';
    else if (/\b(time|samay|समय|morning|afternoon|evening|बजे|सुबह|दोपहर|शाम)\b/i.test(lower)) this.lastAskedField = 'time';
    else if (/\b(visit|देखना|देखेंगे|चाहेंगे|schedule|book)\b/i.test(lower)) this.lastAskedField = 'site_visit_interest';
  }

  shouldAllowSpeculation(text: string): boolean {
    const trimmed = text.trim();
    const queryKeywords = /\b(what|how|price|budget|amenities|location|bhk|possession|visit|schedule|book|कब|कहाँ|कितना|क्या)\b/i;
    const isQuery = queryKeywords.test(trimmed);
    if (isQuery && trimmed.length >= 15) return true;
    if (!this.info.name && this.lastAskedField === 'name') return false;
    if (trimmed.length < 15) return isQuery;
    return true;
  }

  toPromptBlock(): string {
    const lines: string[] = ['[SESSION STATE — GROUND TRUTH — DO NOT CONTRADICT]'];
    lines.push('');
    lines.push('COLLECTED INFO:');
    lines.push(this.info.name ? `  Caller name: ${this.info.name} ✓` : '  Caller name: ❌ NOT COLLECTED');
    lines.push(this.info.preferredDate ? `  Preferred date: ${this.info.preferredDate} ✓` : '  Preferred date: ❌ NOT COLLECTED');
    lines.push(this.info.preferredTime ? `  Preferred time: ${this.info.preferredTime} ✓` : '  Preferred time: ❌ NOT COLLECTED');
    lines.push(this.info.bhkPreference ? `  BHK preference: ${this.info.bhkPreference} ✓` : '  BHK preference: not specified');
    lines.push(this.info.budgetMentioned ? `  Budget: ${this.info.budgetMentioned} ✓` : '  Budget: not specified');
    lines.push(`  Booking status: ${this.bookingStatus}`);
    lines.push('');
    lines.push('PRIORITY: Always answer the user\'s question FIRST. Slot collection is secondary.');
    lines.push('');

    switch (this.bookingStatus) {
      case 'NONE':
        if (!this.info.name) {
          lines.push('YOUR NEXT ACTION: Answer the caller\'s question naturally if they asked one, then ask for their name in a warm, professional way.');
        } else {
          lines.push('YOUR NEXT ACTION: Answer the caller\'s question conversationally. Add a brief, natural follow-up that keeps the conversation flowing.');
          lines.push('  Do NOT push for a site visit — let the conversation lead there naturally.');
        }
        break;
      case 'DATE_CAPTURED':
        lines.push('YOUR NEXT ACTION: Answer the caller\'s question if they asked one. Scheduling is handled by the system — do NOT ask about time or date yourself.');
        lines.push('  DO NOT ask for date — already collected.');
        break;
      case 'TIME_CAPTURED':
        lines.push('YOUR NEXT ACTION: Answer the caller\'s question if they asked one. Scheduling is handled by the system — do NOT ask about day or time yourself.');
        lines.push('  DO NOT ask for time — already collected.');
        break;
      case 'CONFIRMATION_PENDING':
        lines.push('YOUR NEXT ACTION: Booking confirmation is handled by the system. Do NOT confirm or say "booked" yourself. Just answer any pending question briefly.');
        break;
      case 'BOOKED':
        lines.push('BOOKING COMPLETE. Say nothing. Call is ending.');
        break;
      case 'FAILED':
        lines.push('YOUR NEXT ACTION: Briefly apologize that something went wrong with the booking, and offer to try scheduling again.');
        break;
    }

    // ── Response enrichment: inject contextual insight for the current question ──
    const isSchedulingStep = ['DATE_CAPTURED', 'TIME_CAPTURED', 'CONFIRMATION_PENDING', 'BOOKED'].includes(this.bookingStatus);
    const enrichment = buildEnrichmentDirective(
      this.lastUserText,
      PROPERTY_FACTS,
      this.turnCount,
      isSchedulingStep,
    );
    if (enrichment) {
      lines.push(enrichment);
    }

    lines.push('');
    lines.push('RESPONSE STYLE REMINDER:');
    lines.push('- Sound like a helpful consultant, not a database. State fact + contextual insight.');
    lines.push('- Facts: 10–20 words. If a [RESPONSE INSIGHT] is provided, weave it in naturally.');
    lines.push('- Max 2 sentences. No sales pitches. No auto site-visit suggestions.');
    lines.push('');
    lines.push('FORBIDDEN:');
    lines.push('- Do NOT ask for name/date/time if marked ✓ above.');
    lines.push('- Do NOT say "booked"/"confirmed"/"noted"/"scheduled" — the system handles booking confirmation.');
    lines.push('- Do NOT ask about scheduling (day, time, visit) — the system handles all scheduling prompts.');
    lines.push('- Do NOT invent dates, times, prices, or availability not in FACTS.');
    lines.push('- Do NOT continue conversation if status is BOOKED.');
    if (this.info.name) {
      lines.push(`- Use "${this.info.name}" once max. Do NOT ask their name again.`);
    }

    return lines.join('\n');
  }

  validateOutput(text: string): string[] {
    const issues: string[] = [];

    if (this.bookingStatus !== 'CONFIRMATION_PENDING' && this.bookingStatus !== 'BOOKED') {
      const confirmPattern = /\b(booked|confirmed|scheduled|noted|पक्का|book हो गया|done है)\b/i;
      const bookingContext = /\b(visit|appointment|booking|site|schedule)\b/i;
      if (confirmPattern.test(text) && bookingContext.test(text)) {
        issues.push('HALLUCINATED_BOOKING: status is ' + this.bookingStatus);
      }
    }

    if (this.info.name && /(?:your name|naam|नाम|what.*call you|आपका\s*नाम)/i.test(text)) {
      issues.push('RE_ASK_NAME: already collected: ' + this.info.name);
    }
    if (this.info.preferredDate && /\b(which day|कौनसा day|कब आ|when.*come|date prefer|day prefer)\b/i.test(text)) {
      issues.push('RE_ASK_DATE: already collected: ' + this.info.preferredDate);
    }
    if (this.info.preferredTime && /\b(what time|time prefer|morning या afternoon|सुबह या|कितने बजे)\b/i.test(text)) {
      issues.push('RE_ASK_TIME: already collected: ' + this.info.preferredTime);
    }

    if (this.bookingStatus === 'BOOKED' && text.trim().length > 0) {
      issues.push('POST_BOOKING_SPEECH');
    }

    if (issues.length > 0) {
      this.log.warn('output_validation_issues', { issues, text: text.substring(0, 100) });
    }
    return issues;
  }

  hasHallucinatedBooking(text: string): boolean {
    if (this.bookingStatus === 'CONFIRMATION_PENDING' || this.bookingStatus === 'BOOKED') return false;
    const confirmPattern = /\b(booked|confirmed|scheduled|noted|पक्का|book हो गया|done है)\b/i;
    const bookingContext = /\b(visit|appointment|booking|site|schedule|दौरा)\b/i;
    return confirmPattern.test(text) && bookingContext.test(text);
  }

  extractFromUserTranscript(text: string): void {
    const lower = text.toLowerCase().trim();
    const trimmed = text.trim();
    this.lastUserText = trimmed;

    if (!this.info.name) this.extractName(trimmed);
    this.extractDate(lower, trimmed);
    this.extractTime(text, trimmed);
    this.extractPreferences(trimmed);

    if (this.bookingStatus === 'NONE') {
      const visitContext = /\b(visit|schedule|book|देखना|देखेंगे|site|हाँ|sure|ok)\b/i;
      if (visitContext.test(lower)) {
        this.log.info('site_visit_interest_detected', { text: trimmed.substring(0, 50) });
      }
      if (this.lastAskedField === 'site_visit_interest') {
        const bareYes = /^(yes|yeah|sure|ok|okay|haan|हाँ|हां|जी|जी हाँ|ज़रूर|bilkul|बिल्कुल)\s*$/i;
        if (bareYes.test(trimmed)) {
          this.log.info('site_visit_agreed', { response: trimmed });
        }
      }
    }

    this.log.info('session_state', this.getStateSnapshot());
  }

  private extractName(text: string): void {
    const namePatterns = [
      /(?:मेरा\s+नाम|mera\s+naam|mera\s+name|नाम\s+है)\s+(.+?)\s*(?:है|हूँ|हूं)\s*$/i,
      /(?:मेरा\s+)?नाम\s+है\s+([a-zA-Zऀ-ॿ]{2,}(?:\s+[a-zA-Zऀ-ॿ]{2,})?)\s*$/i,
      /(?:mera\s+)?naam\s+hai\s+([a-zA-Z]{2,}(?:\s+[a-zA-Z]{2,})?)\s*$/i,
      /(?:मेरा\s+नाम|mera\s+naam|mera\s+name)\s+([a-zA-Zऀ-ॿ]{2,}(?:\s+[a-zA-Zऀ-ॿ]{2,})?)\s*$/i,
      /(?:my\s+name\s+is|i\s+am|i'm|this\s+is)\s+([a-zA-Z]{2,}(?:\s+[a-zA-Z]{2,})?)\s*$/i,
      /^([a-zA-Zऀ-ॿ]{2,}(?:\s+[a-zA-Zऀ-ॿ]{2,})?)\s+(?:speaking|here|bol\s+raha|bol\s+rahi|बोल\s+रहा|बोल\s+रही)/i,
      /^(?:मैं|main|mai)\s+([a-zA-Zऀ-ॿ]{2,}(?:\s+[a-zA-Zऀ-ॿ]{2,})?)\s*(?:हूँ|हूं|hoon|hu|hun)\s*$/i,
    ];

    for (const pat of namePatterns) {
      const m = text.match(pat);
      if (m?.[1]) {
        const candidate = m[1].trim();
        if (!NAME_TRIGGER_PHRASES.has(candidate.toLowerCase()) &&
            !NAME_FALSE_POSITIVES.has(candidate.toLowerCase())) {
          this.setName(candidate);
          return;
        }
      }
    }

    if (this.lastAskedField === 'name') {
      const words = text.split(/\s+/);
      if (words.length >= 1 && words.length <= 3 && !text.includes('?')) {
        const allLikeName = words.every(w => {
          const wLower = w.toLowerCase();
          return /^[a-zA-Z\u0900-\u097F]{2,}$/.test(w) &&
            !NAME_FALSE_POSITIVES.has(wLower) &&
            !NAME_TRIGGER_PHRASES.has(wLower);
        });
        if (allLikeName) this.setName(text.trim());
      }
    }
  }

  private extractDate(lower: string, trimmed: string): void {
    const datePatterns: Array<[RegExp, string]> = [
      [/\b(today|aaj|आज)\b/i, 'today'],
      [/\b(tomorrow|kal|कल)\b/i, 'tomorrow'],
      [/\b(day after tomorrow|parson|परसों)\b/i, 'day after tomorrow'],
      [/(सोमवार)/, 'Monday'], [/(मंगलवार)/, 'Tuesday'], [/(बुधवार)/, 'Wednesday'],
      [/(गुरुवार)/, 'Thursday'], [/(शुक्रवार)/, 'Friday'], [/(शनिवार)/, 'Saturday'], [/(रविवार)/, 'Sunday'],
      [/\b(monday)\b/i, 'Monday'], [/\b(tuesday)\b/i, 'Tuesday'], [/\b(wednesday)\b/i, 'Wednesday'],
      [/\b(thursday)\b/i, 'Thursday'], [/\b(friday)\b/i, 'Friday'], [/\b(saturday)\b/i, 'Saturday'],
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
    if (!this.info.preferredTime && this.lastAskedField === 'time') {
      const bareTime = /^(morning|afternoon|evening|सुबह|दोपहर|शाम|(\d{1,2})\s*(am|pm|बजे))\s*$/i;
      const m = trimmed.match(bareTime);
      if (m) this.setPreferredTime(m[1]);
    }
  }

  private extractPreferences(text: string): void {
    const detection = detectPreferenceChanges(
      text,
      this.info.bhkPreference,
      this.info.budgetMentioned,
    );

    // BHK: set on first mention; update only on explicit correction
    if (detection.newBhk) {
      if (!this.info.bhkPreference) {
        this.setBhkPreference(detection.newBhk, false);
      } else if (detection.changes.some(c => c.field === 'bhk')) {
        this.setBhkPreference(detection.newBhk, true);
      }
    }

    // Budget: set on first mention; update only on explicit correction
    if (detection.newBudget) {
      if (!this.info.budgetMentioned) {
        this.setBudgetMentioned(detection.newBudget, false);
      } else if (detection.changes.some(c => c.field === 'budget')) {
        this.setBudgetMentioned(detection.newBudget, true);
      }
    }
  }

  extractFromAssistantResponse(text: string): void {
    this.updateLastAskedField(text);
    if (this.bookingStatus !== 'CONFIRMATION_PENDING') return;
    if (!this.info.preferredDate || !this.info.preferredTime) return;
    const confirmPattern = /\b(noted|booked|scheduled|confirm|confirmed|done|पक्का|book\b)/i;
    if (confirmPattern.test(text)) this.confirmBooking();
  }

  getStateSnapshot(): Record<string, unknown> {
    return {
      name: this.info.name, preferredDate: this.info.preferredDate,
      preferredTime: this.info.preferredTime, bookingStatus: this.bookingStatus,
      bookingSuccess: this.bookingSuccess, lastAskedField: this.lastAskedField,
      bhkPreference: this.info.bhkPreference, budgetMentioned: this.info.budgetMentioned,
      turn: this.turnCount, shouldEndCall: this.shouldEndCall,
    };
  }
}
