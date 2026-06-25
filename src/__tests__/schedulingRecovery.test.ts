/**
 * Scheduling recovery tests.
 *
 * Tests the pure SchedulingResponder function (no orchestrator dependency)
 * and SessionState slot transitions for all scheduling paths:
 *
 *  1. Day-only flow  → stores day, asks ONLY for time
 *  2. Time-only flow → stores time, asks ONLY for day
 *  3. Complete flow  → both provided, confirms immediately
 *  4. Reschedule     → changes date or time, re-confirms without restart
 */

import { buildSchedulingResponse, SchedulingSlots } from '../modules/pipeline/SchedulingResponder';

// Mock Logger to avoid real Env/Winston at test time
const mockLog = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
jest.mock('../shared/Logger', () => ({
  Logger: { forCall: () => mockLog, forSession: () => mockLog, root: () => mockLog },
  closeCallLogger: jest.fn(),
  rootLogger: mockLog,
}));

import { SessionState } from '../modules/pipeline/SessionState';

// ─── Helpers ────────────────────────────────────────────────────────────────

function slots(
  preferredDate: string | null,
  preferredTime: string | null,
  bookingStatus: SchedulingSlots['bookingStatus'] = 'NONE',
  name: string | null = 'Rahul',
): SchedulingSlots {
  return { preferredDate, preferredTime, bookingStatus, name };
}

// ─── SchedulingResponder unit tests ─────────────────────────────────────────

describe('buildSchedulingResponse', () => {
  describe('day-only flow', () => {
    it('returns time-ask when day is newly provided', () => {
      const response = buildSchedulingResponse(
        slots('Saturday', null, 'DATE_CAPTURED'),
        null, null,
      );
      expect(response).not.toBeNull();
      expect(response).toContain('Saturday');
      expect(response).toContain('time');
    });

    it('does NOT ask for day again (only asks for missing slot)', () => {
      const response = buildSchedulingResponse(
        slots('Saturday', null, 'DATE_CAPTURED'),
        null, null,
      );
      expect(response).not.toMatch(/\b(day|din|weekday|weekend|kaunsa day)\b/i);
    });

    it('captures "Next week" as day', () => {
      const response = buildSchedulingResponse(
        slots('next week', null, 'DATE_CAPTURED'),
        null, null,
      );
      expect(response).toContain('next week');
    });
  });

  describe('time-only flow', () => {
    it('returns day-ask when time is newly provided', () => {
      const response = buildSchedulingResponse(
        slots(null, '7 PM', 'TIME_CAPTURED'),
        null, null,
      );
      expect(response).not.toBeNull();
      expect(response).toContain('7 PM');
      expect(response).toMatch(/day|weekday|weekend/i);
    });

    it('does NOT ask for time again (only asks for missing slot)', () => {
      const response = buildSchedulingResponse(
        slots(null, 'morning', 'TIME_CAPTURED'),
        null, null,
      );
      expect(response).not.toMatch(/\b(time|samay|kaunsa time)\b/i);
    });

    it('handles "evening" as time', () => {
      const response = buildSchedulingResponse(
        slots(null, 'evening', 'TIME_CAPTURED'),
        null, null,
      );
      expect(response).toContain('evening');
    });
  });

  describe('complete scheduling flow', () => {
    it('confirms immediately when both slots provided together', () => {
      const response = buildSchedulingResponse(
        slots('Saturday', '7 PM', 'CONFIRMATION_PENDING'),
        null, null,
      );
      expect(response).not.toBeNull();
      expect(response).toContain('Saturday');
      expect(response).toContain('7 PM');
      expect(response).toMatch(/book|scheduled/i);
    });

    it('includes caller name in confirmation', () => {
      const response = buildSchedulingResponse(
        slots('Saturday', '7 PM', 'CONFIRMATION_PENDING', 'Priya'),
        null, null,
      );
      expect(response).toContain('Priya ji');
    });

    it('confirmation works without a name', () => {
      const response = buildSchedulingResponse(
        slots('Saturday', '7 PM', 'CONFIRMATION_PENDING', null),
        null, null,
      );
      expect(response).not.toBeNull();
      expect(response).not.toContain('null');
    });
  });

  describe('reschedule flow', () => {
    it('re-confirms when date is changed while time already exists', () => {
      const response = buildSchedulingResponse(
        slots('Sunday', '7 PM', 'CONFIRMATION_PENDING'),
        'Saturday',  // prevDate changed
        '7 PM',
      );
      expect(response).not.toBeNull();
      expect(response).toContain('Sunday');
      expect(response).toContain('7 PM');
    });

    it('re-confirms when time is changed while date already exists', () => {
      const response = buildSchedulingResponse(
        slots('Saturday', '8 PM', 'CONFIRMATION_PENDING'),
        'Saturday',
        '7 PM',  // prevTime changed
      );
      expect(response).not.toBeNull();
      expect(response).toContain('8 PM');
      expect(response).toContain('Saturday');
    });

    it('re-confirms when both date and time are changed', () => {
      const response = buildSchedulingResponse(
        slots('Sunday', '8 PM', 'CONFIRMATION_PENDING'),
        'Saturday',
        '7 PM',
      );
      expect(response).not.toBeNull();
      expect(response).toContain('Sunday');
      expect(response).toContain('8 PM');
    });

    it('uses reschedule phrasing (not initial booking phrasing)', () => {
      const initial = buildSchedulingResponse(
        slots('Saturday', '7 PM', 'CONFIRMATION_PENDING'),
        null, null,
      );
      const reschedule = buildSchedulingResponse(
        slots('Sunday', '7 PM', 'CONFIRMATION_PENDING'),
        'Saturday', '7 PM',
      );
      expect(initial).not.toBe(reschedule);
      expect(reschedule).toMatch(/updated|reschedule/i);
    });

    it('asks for time when date is rescheduled but time still missing', () => {
      // At DATE_CAPTURED, user changes the day
      const response = buildSchedulingResponse(
        slots('Sunday', null, 'DATE_CAPTURED'),
        'Saturday',  // prevDate was Saturday
        null,
      );
      expect(response).not.toBeNull();
      expect(response).toContain('Sunday');
      expect(response).toContain('time');
    });

    it('asks for day when time is rescheduled but day still missing', () => {
      const response = buildSchedulingResponse(
        slots(null, '8 PM', 'TIME_CAPTURED'),
        null,
        '7 PM',  // prevTime was 7PM
      );
      expect(response).not.toBeNull();
      expect(response).toContain('8 PM');
      expect(response).toMatch(/day|weekday|weekend/i);
    });

    it('returns null when nothing changed', () => {
      // Same values as before → no response needed
      const response = buildSchedulingResponse(
        slots('Saturday', null, 'DATE_CAPTURED'),
        'Saturday', null,
      );
      expect(response).toBeNull();
    });
  });

  describe('no restart guarantee', () => {
    it('never asks for day when day is already captured', () => {
      // Day captured, time changed → should not re-ask for day
      const response = buildSchedulingResponse(
        slots('Saturday', '8 PM', 'CONFIRMATION_PENDING'),
        'Saturday',
        '7 PM',
      );
      // Should confirm, not ask for day
      expect(response).toMatch(/scheduled|book/i);
      // Should not be a "which day" prompt
      expect(response).not.toMatch(/kaunsa day|which day/i);
    });

    it('never asks for time when time is already captured', () => {
      const response = buildSchedulingResponse(
        slots('Sunday', '7 PM', 'CONFIRMATION_PENDING'),
        'Saturday',
        '7 PM',
      );
      expect(response).not.toMatch(/kaunsa time|which time|morning ya afternoon/i);
    });
  });
});

// ─── SessionState slot-transition integration tests ──────────────────────────

describe('SessionState scheduling slot transitions', () => {
  let session: SessionState;

  beforeEach(() => {
    session = new SessionState('test-scheduling');
  });

  it('stores date and enters DATE_CAPTURED on day-only utterance', () => {
    session.extractFromUserTranscript('Saturday aana chahta hoon');
    expect(session.info.preferredDate).toBe('Saturday');
    expect(session.info.preferredTime).toBeNull();
    expect(session.bookingStatus).toBe('DATE_CAPTURED');
  });

  it('stores time and enters TIME_CAPTURED on time-only utterance', () => {
    session.extractFromUserTranscript('7 PM pe aana chahta hoon');
    expect(session.info.preferredTime).toContain('7');
    expect(session.info.preferredDate).toBeNull();
    expect(session.bookingStatus).toBe('TIME_CAPTURED');
  });

  it('enters CONFIRMATION_PENDING when both slots provided together', () => {
    session.extractFromUserTranscript('Saturday 7 PM pe aana chahta hoon');
    expect(session.info.preferredDate).toBe('Saturday');
    expect(session.info.preferredTime).not.toBeNull();
    expect(session.bookingStatus).toBe('CONFIRMATION_PENDING');
  });

  it('advances DATE_CAPTURED → CONFIRMATION_PENDING when time is added', () => {
    session.extractFromUserTranscript('Saturday aana chahta hoon');
    expect(session.bookingStatus).toBe('DATE_CAPTURED');

    session.extractFromUserTranscript('Morning me aana chahta hoon');
    expect(session.info.preferredTime).not.toBeNull();
    expect(session.bookingStatus).toBe('CONFIRMATION_PENDING');
  });

  it('advances TIME_CAPTURED → CONFIRMATION_PENDING when day is added', () => {
    session.extractFromUserTranscript('7 PM pe aana chahta hoon');
    expect(session.bookingStatus).toBe('TIME_CAPTURED');

    session.extractFromUserTranscript('Saturday ko aana chahta hoon');
    expect(session.info.preferredDate).toBe('Saturday');
    expect(session.bookingStatus).toBe('CONFIRMATION_PENDING');
  });

  it('stays CONFIRMATION_PENDING when date is updated at CONFIRMATION_PENDING', () => {
    session.extractFromUserTranscript('Saturday 7 PM');
    expect(session.bookingStatus).toBe('CONFIRMATION_PENDING');

    session.extractFromUserTranscript('Sunday ko karte hain');
    expect(session.info.preferredDate).toBe('Sunday');
    expect(session.bookingStatus).toBe('CONFIRMATION_PENDING');
  });

  it('stays DATE_CAPTURED when date is changed while time still missing', () => {
    session.extractFromUserTranscript('Saturday aana chahta hoon');
    expect(session.bookingStatus).toBe('DATE_CAPTURED');

    session.extractFromUserTranscript('Sunday better rahega');
    // Status should stay DATE_CAPTURED — time still missing
    expect(session.bookingStatus).toBe('DATE_CAPTURED');
    expect(session.info.preferredDate).toBe('Sunday');
  });

  it('retains existing time when only date is updated at CONFIRMATION_PENDING', () => {
    session.extractFromUserTranscript('Saturday 7 PM');
    const oldTime = session.info.preferredTime;

    session.extractFromUserTranscript('Sunday ko karte hain');
    expect(session.info.preferredTime).toBe(oldTime);
    expect(session.info.preferredDate).toBe('Sunday');
  });

  it('retains existing date when only time is updated at CONFIRMATION_PENDING', () => {
    session.extractFromUserTranscript('Saturday 7 PM');
    const oldDate = session.info.preferredDate;

    session.extractFromUserTranscript('8 PM better rahega');
    expect(session.info.preferredDate).toBe(oldDate);
  });
});

// ─── Reschedule response triggers confirmBooking ─────────────────────────────

describe('reschedule confirmation text triggers confirmBooking', () => {
  it('reschedule response contains "scheduled" keyword', () => {
    const response = buildSchedulingResponse(
      slots('Sunday', '7 PM', 'CONFIRMATION_PENDING'),
      'Saturday', '7 PM',
    );
    // extractFromAssistantResponse looks for "scheduled" to call confirmBooking()
    expect(response).toMatch(/\bscheduled\b/i);
  });

  it('initial confirmation response contains booking keyword', () => {
    const response = buildSchedulingResponse(
      slots('Saturday', '7 PM', 'CONFIRMATION_PENDING'),
      null, null,
    );
    expect(response).toMatch(/\b(book|scheduled)\b/i);
  });
});
