import { describe, it, expect, beforeEach } from 'vitest';
import { SessionState } from './SessionState';

// Mock logger — SessionState expects Logger.forCall() which needs Winston
import { vi } from 'vitest';
vi.mock('../shared/logger', () => ({
  Logger: {
    forCall: () => ({
      info: () => {},
      warn: () => {},
      debug: () => {},
      error: () => {},
    }),
  },
}));

describe('SessionState', () => {
  let session: SessionState;

  beforeEach(() => {
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
