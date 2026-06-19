import { describe, it, expect, beforeEach } from 'vitest';
import { SessionState } from './SessionState';

// Mock logger — SessionState expects Logger.forCall() which needs Winston.
// Capture info-level log messages so tests can assert on emitted tags.
import { vi } from 'vitest';
const { logMessages } = vi.hoisted(() => ({ logMessages: [] as string[] }));
vi.mock('../shared/logger', () => ({
  Logger: {
    forCall: () => ({
      info: (msg: string) => { logMessages.push(msg); },
      warn: (msg: string) => { logMessages.push(msg); },
      debug: () => {},
      error: () => {},
    }),
  },
}));

describe('SessionState', () => {
  let session: SessionState;

  beforeEach(() => {
    logMessages.length = 0;
    session = new SessionState('test-call-123');
  });

  // ─── Speculation Safety ───────────────────────────────────────────────────

  describe('Speculation Safety', () => {
    it('allows speculation for complete queries', () => {
      expect(session.shouldAllowSpeculation('what is the price of the project')).toBe(true);
      expect(session.shouldAllowSpeculation('what are the amenities')).toBe(true);
    });

    it('blocks speculation for short non-query text', () => {
      expect(session.shouldAllowSpeculation('haan')).toBe(false);
      expect(session.shouldAllowSpeculation('ok sure')).toBe(false);
    });
  });

  // ─── Booking State Machine ────────────────────────────────────────────────

  describe('Booking State Machine', () => {
    it('starts in NONE state', () => {
      expect(session.bookingStatus).toBe('NONE');
    });

    it('transitions NONE → DATE_CAPTURED when date is set', () => {
      session.setPreferredDate('Saturday');
      expect(session.bookingStatus).toBe('DATE_CAPTURED');
    });

    it('transitions NONE → TIME_CAPTURED when time is set first', () => {
      session.setPreferredTime('morning');
      expect(session.bookingStatus).toBe('TIME_CAPTURED');
    });

    it('auto-confirms to BOOKED when both date and time are set', () => {
      // advanceBookingState auto-calls confirmBooking when both slots are present
      session.setPreferredDate('Saturday');
      session.setPreferredTime('morning');
      expect(session.bookingStatus).toBe('BOOKED');
      expect(session.bookingSuccess).toBe(true);
      expect(session.shouldEndCall).toBe(true);
    });

    it('rejects confirmBooking() when only date captured', () => {
      session.setPreferredDate('Saturday');
      // Only DATE_CAPTURED — not CONFIRMATION_PENDING
      session.confirmBooking();
      expect(session.bookingStatus).toBe('DATE_CAPTURED');
      expect(session.bookingSuccess).toBe(false);
    });

    it('rejects confirmBooking() from NONE state', () => {
      session.confirmBooking();
      expect(session.bookingStatus).toBe('NONE');
      expect(session.bookingSuccess).toBe(false);
    });
  });

  // ─── Query Handling Priority ──────────────────────────────────────────────

  describe('Query Handling Priority', () => {
    it('fresh session starts in INTRODUCTION', () => {
      expect(session.currentStep).toBe('INTRODUCTION');
    });

    it('interested user without visit → VISIT_OFFER', () => {
      session.interested = true;
      expect(session.currentStep).toBe('VISIT_OFFER');
    });

    it('visit agreed → ASK_VISIT_DAY', () => {
      session.interested = true;
      session.visitAgreed = true;
      expect(session.currentStep).toBe('ASK_VISIT_DAY');
    });

    it('date captured → ASK_VISIT_TIME', () => {
      session.interested = true;
      session.visitAgreed = true;
      session.setPreferredDate('Saturday');
      expect(session.currentStep).toBe('ASK_VISIT_TIME');
    });
  });

  // ─── Booking Completion Flow ──────────────────────────────────────────────

  describe('Booking Completion Flow', () => {
    it('auto-books when date + time extracted from user transcript', () => {
      session.interested = true;
      session.visitAgreed = true;
      session.extractFromUserTranscript('Saturday morning');
      expect(session.info.preferredDate).toBe('Saturday');
      expect(session.info.preferredTime).toBe('morning');
      expect(session.bookingStatus).toBe('BOOKED');
      expect(session.visitBooked).toBe(true);
      expect(session.shouldEndCall).toBe(true);
      expect(session.currentStep).toBe('BOOKED');
    });

    it('LLM saying "booked" never advances business state', () => {
      session.interested = true;
      session.visitAgreed = true;
      session.setPreferredDate('Saturday');
      // Only DATE_CAPTURED — LLM output must not advance state
      session.extractFromAssistantResponse('Perfect, Saturday morning booked! Thank you!');
      expect(session.bookingStatus).toBe('DATE_CAPTURED');
      expect(session.visitBooked).toBe(false);
    });

    it('user "yes" cannot book before both slots are captured', () => {
      session.interested = true;
      session.visitAgreed = true;
      session.setPreferredDate('Saturday'); // only DATE_CAPTURED
      session.extractFromUserTranscript('yes please');
      expect(session.bookingStatus).toBe('DATE_CAPTURED');
      expect(session.visitBooked).toBe(false);
    });
  });

  // ─── Output Validation ────────────────────────────────────────────────────

  describe('Output Validation', () => {
    it('detects hallucinated booking when not BOOKED', () => {
      const issues = session.validateOutput('Your visit is booked for Saturday!');
      expect(issues.some(i => i.includes('HALLUCINATED_BOOKING'))).toBe(true);
    });

    it('detects re-asking for collected date', () => {
      session.setPreferredDate('Saturday');
      const issues = session.validateOutput('कौनसा day prefer करेंगे?');
      expect(issues.some(i => i.includes('RE_ASK_DATE'))).toBe(true);
    });
  });

  // ─── Date and Time Extraction ─────────────────────────────────────────────

  describe('Date and Time Extraction', () => {
    it('extracts "Saturday morning" as both date and time', () => {
      session.extractFromUserTranscript('Saturday morning');
      expect(session.info.preferredDate).toBe('Saturday');
      expect(session.info.preferredTime).toBe('morning');
    });

    it('extracts "tomorrow" as date', () => {
      session.extractFromUserTranscript('tomorrow would be good');
      expect(session.info.preferredDate).toBe('tomorrow');
    });

    it('extracts "शनिवार" as Saturday', () => {
      session.extractFromUserTranscript('शनिवार को आ सकता हूँ');
      expect(session.info.preferredDate).toBe('Saturday');
    });

    it('extracts "सुबह" as morning', () => {
      session.extractFromUserTranscript('सुबह अच्छा रहेगा');
      expect(session.info.preferredTime).toBe('morning');
    });

    it('extracts "3 PM" as time', () => {
      session.extractFromUserTranscript('3 PM works');
      expect(session.info.preferredTime).toBe('3 PM');
    });
  });

  // ─── Last-Asked-Field Tracking ────────────────────────────────────────────

  describe('Last-Asked-Field Tracking', () => {
    it('detects date question in assistant response', () => {
      session.updateLastAskedField('कौनसा day prefer करेंगे?');
      expect(session.lastAskedField).toBe('date');
    });

    it('detects time question in assistant response', () => {
      session.updateLastAskedField('Morning या afternoon?');
      expect(session.lastAskedField).toBe('time');
    });

    it('detects visit interest question', () => {
      session.updateLastAskedField('क्या आप visit करना चाहेंगे?');
      expect(session.lastAskedField).toBe('site_visit_interest');
    });
  });

  // ─── Outbound Sales Flow (state machine) ──────────────────────────────────

  describe('Outbound Sales Flow', () => {
    it('starts in INTRODUCTION', () => {
      expect(session.currentStep).toBe('INTRODUCTION');
    });

    it('"haan" to opener (lastAskedField=site_visit_interest) → interested + visitAgreed → ASK_VISIT_DAY', () => {
      // Default lastAskedField is 'site_visit_interest', so "haan" is classified
      // as VISIT_INTENT by IntentClassifier → sets both interested and visitAgreed
      session.extractFromUserTranscript('haan');
      expect(session.interested).toBe(true);
      expect(session.visitAgreed).toBe(true);
      expect(session.currentStep).toBe('ASK_VISIT_DAY');
    });

    it('a question signals interest', () => {
      session.extractFromUserTranscript('what is the price?');
      expect(session.interested).toBe(true);
    });

    // ── Entity priority over leading affirmatives ──────────────────────────
    // Leading "haan" must NOT hijack a budget/BHK answer into visit scheduling.
    it('"haan, budget 10 lakh" → captures budget, does NOT trigger visit', () => {
      session.extractFromUserTranscript('haan, budget 10 lakh');
      expect(session.budget).toBe('10 lakh');
      expect(session.interested).toBe(true);
      expect(session.visitAgreed).toBe(false);
      expect(session.currentStep).not.toBe('ASK_VISIT_DAY');
    });

    it('"haan, 2 BHK dekh raha hoon" → captures BHK, does NOT trigger visit', () => {
      session.extractFromUserTranscript('haan, 2 BHK dekh raha hoon');
      expect(session.bhkPreference).toBe('2 BHK');
      expect(session.interested).toBe(true);
      expect(session.visitAgreed).toBe(false);
      expect(session.currentStep).not.toBe('ASK_VISIT_DAY');
    });

    it('bare "haan" (no entity) still triggers visit intent', () => {
      session.extractFromUserTranscript('haan');
      expect(session.visitAgreed).toBe(true);
      expect(session.currentStep).toBe('ASK_VISIT_DAY');
    });

    it('explicit "not interested" with word boundary → NOT_INTERESTED', () => {
      // "nahi chahiye" is explicit rejection via IntentClassifier
      session.extractFromUserTranscript('nahi chahiye');
      expect(session.notInterested).toBe(true);
      expect(session.shouldEndCall).toBe(true);
      expect(session.currentStep).toBe('NOT_INTERESTED');
    });

    it('full conversion: interest → visit → day → time → BOOKED (auto-confirmed)', () => {
      // "haan" with site_visit_interest context → VISIT_INTENT → visitAgreed
      session.extractFromUserTranscript('haan interested');
      expect(session.interested).toBe(true);
      expect(session.visitAgreed).toBe(true);
      expect(session.currentStep).toBe('ASK_VISIT_DAY');

      session.updateLastAskedField('कौनसा day?');
      session.extractFromUserTranscript('Saturday');
      expect(session.currentStep).toBe('ASK_VISIT_TIME');

      session.updateLastAskedField('morning या afternoon?');
      session.extractFromUserTranscript('morning');
      // Auto-confirms: date + time → BOOKED
      expect(session.currentStep).toBe('BOOKED');
      expect(session.visitBooked).toBe(true);
    });
  });

  // ─── Last-Asked-Field Synchronization ─────────────────────────────────────

  describe('Last-Asked-Field Tracking (budget/BHK)', () => {
    it('budget question sets lastAskedField=budget and logs LAST_ASKED_FIELD_SET', () => {
      session.extractFromAssistantResponse('आप किस budget range में देख रहे हैं?');
      expect(session.lastAskedField).toBe('budget');
      expect(logMessages).toContain('LAST_ASKED_FIELD_SET');
    });

    it('BHK question sets lastAskedField=bhk', () => {
      session.extractFromAssistantResponse('कितने BHK चाहिए आपको?');
      expect(session.lastAskedField).toBe('bhk');
    });

    it('date question still sets lastAskedField=date', () => {
      session.extractFromAssistantResponse('कौन सा दिन convenient रहेगा?');
      expect(session.lastAskedField).toBe('date');
    });

    it('a non-question mentioning budget does NOT set the field', () => {
      session.extractFromAssistantResponse('Akshay Vista में price 8 to 10 thousand per sq ft है।');
      expect(session.lastAskedField).not.toBe('budget');
    });

    it('req #4: budget question + bare "haan" → no visit intent (VISIT_OFFER step)', () => {
      session.interested = true; // → VISIT_OFFER step, inVisitScheduling=true
      session.extractFromAssistantResponse('आपका budget कितना है?');
      expect(session.lastAskedField).toBe('budget');
      expect(session.currentStep).toBe('VISIT_OFFER');

      session.extractFromUserTranscript('haan');
      expect(session.visitAgreed).toBe(false);
      expect(session.currentStep).not.toBe('ASK_VISIT_DAY');
    });

    it('MATCH: budget asked, budget answered → LAST_ASKED_FIELD_MATCH', () => {
      session.extractFromAssistantResponse('आपका budget कितना है?');
      logMessages.length = 0;
      session.extractFromUserTranscript('mera budget 50 lakh hai');
      expect(session.budget).toBe('50 lakh');
      expect(logMessages).toContain('LAST_ASKED_FIELD_MATCH');
    });

    it('MISMATCH: budget asked, a day volunteered → LAST_ASKED_FIELD_MISMATCH', () => {
      session.interested = true;
      session.visitAgreed = true; // scheduling context so date extraction is allowed
      session.lastAskedField = 'budget';
      logMessages.length = 0;
      session.extractFromUserTranscript('Saturday');
      expect(logMessages).toContain('LAST_ASKED_FIELD_MISMATCH');
    });
  });

  // ─── Acknowledgement-Only Guard ───────────────────────────────────────────

  describe('Acknowledgement-Only Guard', () => {
    it('detects pure acknowledgements as acknowledgement-only', () => {
      for (const t of ['I understand.', 'Got it.', 'Okay.', 'Sure.', 'ठीक है।', 'अच्छा।',
        'I understand you want to share your budget',
        'मैं समझता हूँ कि आप अपना बजट बताना चाहते हैं।']) {
        expect(session.isAcknowledgementOnly(t)).toBe(true);
      }
    });

    it('does NOT flag substantive answers or clarifying questions', () => {
      for (const t of ['Price 8 से 10 thousand per square feet है।',
        'I understand the price is 80 lakh.',
        'Gym और clubhouse दोनों available हैं।',
        'आप किस budget range में देख रहे हैं?']) {
        expect(session.isAcknowledgementOnly(t)).toBe(false);
      }
    });

    it('replaces an ack-only head with a budget-specific clarifying question', () => {
      session.lastAskedField = 'budget';
      const out = session.sanitizeStreamingHead('मैं समझता हूँ कि आप अपना बजट बताना चाहते हैं।');
      expect(out).toBe('आपका budget कितना है?');
      expect(logMessages).toContain('ACK_ONLY_REJECTED');
    });

    it('replaces a generic ack-only head with a generic clarifying question', () => {
      session.lastAskedField = null;
      const out = session.sanitizeStreamingHead('I understand.');
      expect(out).toContain('जानना चाहते हैं');
    });

    it('leaves substantive responses untouched', () => {
      const text = 'Gym और clubhouse दोनों available हैं।';
      expect(session.sanitizeStreamingHead(text)).toBe(text);
    });

    it('flags ACKNOWLEDGEMENT_ONLY in validateOutput', () => {
      expect(session.validateOutput('Got it.')).toContain('ACKNOWLEDGEMENT_ONLY');
      expect(session.validateOutput('Price 8 thousand है।')).not.toContain('ACKNOWLEDGEMENT_ONLY');
    });
  });

  // ─── Deterministic Scheduling Responses ───────────────────────────────────

  describe('Deterministic Scheduling Responses', () => {
    it('returns day request for ASK_VISIT_DAY step', () => {
      session.interested = true;
      session.visitAgreed = true;
      expect(session.currentStep).toBe('ASK_VISIT_DAY');
      const response = session.getSchedulingResponse();
      expect(response).not.toBeNull();
      expect(response).toContain('दिन');
    });

    it('returns time request for ASK_VISIT_TIME step', () => {
      session.interested = true;
      session.visitAgreed = true;
      session.setPreferredDate('Saturday');
      expect(session.currentStep).toBe('ASK_VISIT_TIME');
      const response = session.getSchedulingResponse();
      expect(response).not.toBeNull();
      expect(response).toContain('Saturday');
    });

    it('returns null for non-scheduling steps', () => {
      expect(session.getSchedulingResponse()).toBeNull(); // INTRODUCTION
      session.interested = true;
      expect(session.getSchedulingResponse()).toBeNull(); // VISIT_OFFER
    });

    it('returns farewell for NOT_INTERESTED step', () => {
      session.notInterested = true;
      expect(session.currentStep).toBe('NOT_INTERESTED');
      const response = session.getSchedulingResponse();
      expect(response).not.toBeNull();
      expect(response).toContain('धन्यवाद');
    });
  });
});
