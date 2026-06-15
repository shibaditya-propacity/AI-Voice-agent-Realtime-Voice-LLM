import { describe, it, expect, beforeEach } from 'vitest';
import { SessionState } from './SessionState';

// Mock logger — SessionState expects Logger.forCall() which needs Winston
// We bypass by creating with a dummy callSid and mocking the logger module.
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

  // ─── Name Extraction ─────────────────────────────────────────────────────

  describe('Name Extraction', () => {
    it('extracts name from "मेरा नाम शिवा है"', () => {
      session.extractFromUserTranscript('मेरा नाम शिवा है');
      expect(session.info.name).toBe('शिवा');
    });

    it('extracts name from "I am Rahul"', () => {
      session.extractFromUserTranscript('I am Rahul');
      expect(session.info.name).toBe('Rahul');
    });

    it('extracts name from "my name is Priya"', () => {
      session.extractFromUserTranscript('my name is Priya');
      expect(session.info.name).toBe('Priya');
    });

    it('extracts name from "मैं शिवा हूँ"', () => {
      session.extractFromUserTranscript('मैं शिवा हूँ');
      expect(session.info.name).toBe('शिवा');
    });

    it('extracts bare name "Shiva" when agent asked for name', () => {
      // lastAskedField defaults to 'name' (greeting asks for name)
      session.extractFromUserTranscript('Shiva');
      expect(session.info.name).toBe('Shiva');
    });

    it('extracts bare name "Rajesh Kumar" when agent asked for name', () => {
      session.extractFromUserTranscript('Rajesh Kumar');
      expect(session.info.name).toBe('Rajesh Kumar');
    });

    it('does NOT store "मेरा नाम" as name (trigger phrase only)', () => {
      session.extractFromUserTranscript('मेरा नाम');
      expect(session.info.name).toBeNull();
    });

    it('does NOT store "my name is" as name', () => {
      session.extractFromUserTranscript('my name is');
      expect(session.info.name).toBeNull();
    });

    it('does NOT store "I am" as name', () => {
      session.extractFromUserTranscript('I am');
      expect(session.info.name).toBeNull();
    });

    it('does NOT store "नाम है" as name', () => {
      session.extractFromUserTranscript('नाम है');
      expect(session.info.name).toBeNull();
    });

    it('does NOT store "मैं" as name', () => {
      session.extractFromUserTranscript('मैं');
      expect(session.info.name).toBeNull();
    });

    it('does NOT store common words as name: "yes", "ok", "hello"', () => {
      session.extractFromUserTranscript('yes');
      expect(session.info.name).toBeNull();
      session.extractFromUserTranscript('ok');
      expect(session.info.name).toBeNull();
      session.extractFromUserTranscript('hello');
      expect(session.info.name).toBeNull();
    });

    it('does NOT re-extract name if already collected', () => {
      session.extractFromUserTranscript('I am Rahul');
      expect(session.info.name).toBe('Rahul');
      session.extractFromUserTranscript('I am Priya');
      // Name should NOT change — already collected
      expect(session.info.name).toBe('Rahul');
    });

    it('extracts name from "मेरा नाम शिवा" (without है)', () => {
      session.extractFromUserTranscript('मेरा नाम शिवा');
      expect(session.info.name).toBe('शिवा');
    });

    it('extracts two-word Hindi name', () => {
      session.extractFromUserTranscript('मेरा नाम राम कुमार है');
      expect(session.info.name).toBe('राम कुमार');
    });

    it('extracts name from copula-first "मेरा नाम है शिव राय"', () => {
      // Deepgram word order "naam hai X" — name FOLLOWS है (regression: was lost)
      session.extractFromUserTranscript('मेरा नाम है शिव राय');
      expect(session.info.name).toBe('शिव राय');
    });

    it('extracts name from "नाम है शिवा" (no मेरा)', () => {
      session.extractFromUserTranscript('नाम है शिवा');
      expect(session.info.name).toBe('शिवा');
    });

    it('extracts name from romanized "mera naam hai Shiv"', () => {
      session.extractFromUserTranscript('mera naam hai Shiv');
      expect(session.info.name).toBe('Shiv');
    });
  });

  // ─── Speculation Safety ───────────────────────────────────────────────────

  describe('Speculation Safety', () => {
    it('blocks speculation during name collection', () => {
      // lastAskedField defaults to 'name', no name collected yet
      expect(session.shouldAllowSpeculation('मेरा नाम')).toBe(false);
      expect(session.shouldAllowSpeculation('Shiva')).toBe(false);
    });

    it('allows speculation after name is collected', () => {
      session.setName('Shiva');
      expect(session.shouldAllowSpeculation('what is the price')).toBe(true);
    });

    it('allows speculation for complete queries even without name', () => {
      // Query keywords bypass the name gate
      expect(session.shouldAllowSpeculation('what is the price of the project')).toBe(true);
      expect(session.shouldAllowSpeculation('what are the amenities')).toBe(true);
    });

    it('blocks speculation for short non-query text', () => {
      session.setName('Shiva'); // name collected, but text is short non-query
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

    it('transitions to CONFIRMATION_PENDING when both date and time are set', () => {
      session.setPreferredDate('Saturday');
      session.setPreferredTime('morning');
      expect(session.bookingStatus).toBe('CONFIRMATION_PENDING');
    });

    it('transitions CONFIRMATION_PENDING → BOOKED on confirmBooking()', () => {
      session.setPreferredDate('Saturday');
      session.setPreferredTime('morning');
      expect(session.bookingStatus).toBe('CONFIRMATION_PENDING');
      session.confirmBooking();
      expect(session.bookingStatus).toBe('BOOKED');
      expect(session.bookingSuccess).toBe(true);
      expect(session.shouldEndCall).toBe(true);
    });

    it('rejects confirmBooking() when not in CONFIRMATION_PENDING', () => {
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

  // ─── Repeated Name Prevention ─────────────────────────────────────────────

  describe('Repeated Name Prevention', () => {
    it('does not update name once already set', () => {
      session.setName('Rajesh');
      session.extractFromUserTranscript('my name is Priya');
      expect(session.info.name).toBe('Rajesh');
    });
  });

  // ─── Amenities Question Before Name Collection ────────────────────────────

  describe('Query Handling Priority', () => {
    it('toPromptBlock says to answer query first when name not collected', () => {
      const block = session.toPromptBlock();
      expect(block).toContain('Answer user query');
      expect(block).toContain('PRIORITY');
    });

    it('toPromptBlock says to answer query first during DATE_CAPTURED', () => {
      session.setPreferredDate('Saturday');
      const block = session.toPromptBlock();
      expect(block).toContain('Answer user query if any');
    });
  });

  // ─── Booking Completion Flow ──────────────────────────────────────────────

  describe('Booking Completion Flow', () => {
    it('full booking flow: date → time → confirm → BOOKED + shouldEndCall', () => {
      session.setName('Shiva');
      session.extractFromUserTranscript('Saturday morning');
      expect(session.info.preferredDate).toBe('Saturday');
      expect(session.info.preferredTime).toBe('morning');
      expect(session.bookingStatus).toBe('CONFIRMATION_PENDING');

      // Simulate LLM confirmation response
      session.extractFromAssistantResponse('Perfect, Saturday morning noted है। Thank you!');
      expect(session.bookingStatus).toBe('BOOKED');
      expect(session.bookingSuccess).toBe(true);
      expect(session.shouldEndCall).toBe(true);
    });

    it('LLM cannot trigger BOOKED without CONFIRMATION_PENDING', () => {
      session.setName('Shiva');
      session.setPreferredDate('Saturday');
      // Only DATE_CAPTURED — no time yet
      session.extractFromAssistantResponse('Visit booked for Saturday. Thank you!');
      expect(session.bookingStatus).toBe('DATE_CAPTURED');
      expect(session.bookingSuccess).toBe(false);
    });
  });

  // ─── Output Validation ────────────────────────────────────────────────────

  describe('Output Validation', () => {
    it('detects hallucinated booking when not CONFIRMATION_PENDING', () => {
      const issues = session.validateOutput('Your visit is booked for Saturday!');
      expect(issues.some(i => i.includes('HALLUCINATED_BOOKING'))).toBe(true);
    });

    it('no issues when CONFIRMATION_PENDING and LLM confirms', () => {
      session.setPreferredDate('Saturday');
      session.setPreferredTime('morning');
      const issues = session.validateOutput('Saturday morning noted है। Thank you!');
      expect(issues).toHaveLength(0);
    });

    it('detects re-asking for collected name', () => {
      session.setName('Rajesh');
      const issues = session.validateOutput('आपका नाम बता सकते हैं?');
      expect(issues.some(i => i.includes('RE_ASK_NAME'))).toBe(true);
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
    it('detects name question in assistant response', () => {
      session.updateLastAskedField('आपका नाम बता सकते हैं?');
      expect(session.lastAskedField).toBe('name');
    });

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
});
