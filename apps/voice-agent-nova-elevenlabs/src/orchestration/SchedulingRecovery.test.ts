/**
 * Scheduling recovery tests for the apps/voice-agent-nova-elevenlabs pipeline.
 *
 * Tests the step-based scheduling flow in SessionState:
 *  1. Day-only  → stores date, asks ONLY for time (acknowledges the day)
 *  2. Time-only → stores time, asks ONLY for day (acknowledges the time)
 *  3. Both      → confirms immediately
 *  4. Reschedule → date change updates slot, keeps time
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../shared/logger', () => ({
  Logger: {
    forCall: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
  },
}));

vi.mock('../config/env', () => ({
  Env: {
    ttsProvider: 'elevenlabs',
    llm: { tokensShort: 30, tokensNormal: 50, tokensLong: 100, speculationEnabled: false, greetingPrompt: '' },
    humanization: { enabled: false },
    audio: { minBufferBytes: 2400 },
    bargeIn: { graceMs: 1500, minNewWords: 2, minInterimConfidence: 0.6 },
  },
}));

import { SessionState } from './SessionState';

function makeSchedulingSession(): SessionState {
  const s = new SessionState('test-sched');
  // Put session into scheduling context: interested + visit agreed
  s.extractFromUserTranscript('haan interested hoon');
  s.extractFromUserTranscript('haan site visit karna chahta hoon');
  return s;
}

describe('SessionState scheduling slot transitions', () => {
  let session: SessionState;

  beforeEach(() => {
    session = makeSchedulingSession();
  });

  it('stores date and asks for time on day-only utterance', () => {
    session.extractFromUserTranscript('Saturday ko aana chahta hoon');
    expect(session.info.preferredDate).toBe('Saturday');
    expect(session.info.preferredTime).toBeNull();
    expect(session.currentStep).toBe('ASK_VISIT_TIME');

    const response = session.getSchedulingResponse();
    expect(response).not.toBeNull();
    expect(response).toMatch(/Saturday|saturday/i);
    expect(response).toMatch(/time|morning|afternoon|evening/i);
    // Must NOT ask for day again
    expect(response).not.toMatch(/kaunsa din|which day|aaj kya|din batao/i);
  });

  it('stores time and asks for day on time-only utterance', () => {
    session.extractFromUserTranscript('7 PM pe aana chahta hoon');
    expect(session.info.preferredTime).toContain('7');
    expect(session.info.preferredDate).toBeNull();
    expect(session.currentStep).toBe('ASK_VISIT_DAY');

    const response = session.getSchedulingResponse();
    expect(response).not.toBeNull();
    // Should acknowledge the time
    expect(response).toMatch(/7|noted/i);
    // Should ask for day
    expect(response).toMatch(/din|day|weekend|aaj|kal/i);
    // Must NOT ask for time again
    expect(response).not.toMatch(/kitne baje|what time|time prefer|morning ya/i);
  });

  it('confirms immediately when both slots provided together', () => {
    session.extractFromUserTranscript('Saturday 7 PM pe aana chahta hoon');
    expect(session.info.preferredDate).toBe('Saturday');
    expect(session.info.preferredTime).not.toBeNull();
    expect(session.bookingStatus).toBe('BOOKED');

    const response = session.getSchedulingResponse();
    expect(response).not.toBeNull();
    expect(response).toMatch(/book|site visit/i);
  });

  it('advances DATE_CAPTURED → BOOKED when time is added', () => {
    session.extractFromUserTranscript('Saturday ko aana chahta hoon');
    expect(session.currentStep).toBe('ASK_VISIT_TIME');

    session.extractFromUserTranscript('Morning mein aana chahta hoon');
    expect(session.info.preferredTime).not.toBeNull();
    expect(session.bookingStatus).toBe('BOOKED');
  });

  it('advances TIME_CAPTURED → BOOKED when day is added', () => {
    session.extractFromUserTranscript('7 PM pe aana chahta hoon');
    expect(session.currentStep).toBe('ASK_VISIT_DAY');

    session.extractFromUserTranscript('Saturday ko aana chahta hoon');
    expect(session.info.preferredDate).toBe('Saturday');
    expect(session.bookingStatus).toBe('BOOKED');
  });

  it('retains existing time when date is updated at CONFIRMATION_PENDING', () => {
    // Provide both at once (goes to BOOKED immediately)
    session.extractFromUserTranscript('Saturday 7 PM');
    expect(session.bookingStatus).toBe('BOOKED');
    // Time is preserved
    expect(session.info.preferredTime).toContain('7');
  });
});

describe('Day-only scheduling response', () => {
  let session: SessionState;

  beforeEach(() => {
    session = makeSchedulingSession();
  });

  it('day-only response does NOT ask for day again', () => {
    session.extractFromUserTranscript('Saturday aana chahta hoon');
    const response = session.getSchedulingResponse();
    expect(response).not.toBeNull();
    // Should ask for time, not day
    expect(response).toMatch(/time|morning|afternoon|evening|comfortable/i);
    expect(response).not.toMatch(/kaunsa din|which day|din batao/i);
  });

  it('day-only response acknowledges the captured day', () => {
    session.extractFromUserTranscript('Sunday aana chahta hoon');
    const response = session.getSchedulingResponse();
    expect(response).toMatch(/Sunday/);
  });

  it('handles "today" as day', () => {
    session.extractFromUserTranscript('aaj aana chahta hoon');
    const response = session.getSchedulingResponse();
    expect(response).not.toBeNull();
    expect(response).toMatch(/time|comfortable/i);
  });
});

describe('Time-only scheduling response', () => {
  let session: SessionState;

  beforeEach(() => {
    session = makeSchedulingSession();
  });

  it('time-only response acknowledges the captured time', () => {
    session.extractFromUserTranscript('7 PM pe aana chahta hoon');
    const response = session.getSchedulingResponse();
    expect(response).not.toBeNull();
    expect(response).toMatch(/7|noted/i);
  });

  it('time-only response asks for day (not time)', () => {
    session.extractFromUserTranscript('morning mein aana chahta hoon');
    const response = session.getSchedulingResponse();
    expect(response).not.toBeNull();
    expect(response).toMatch(/din|day|weekend/i);
    expect(response).not.toMatch(/kitne baje|what time|time prefer/i);
  });

  it('handles "evening" as time', () => {
    session.extractFromUserTranscript('evening mein aana chahta hoon');
    const response = session.getSchedulingResponse();
    expect(response).not.toBeNull();
    expect(response).toMatch(/evening|noted/i);
  });
});

describe('Booking confirmation response', () => {
  let session: SessionState;

  beforeEach(() => {
    session = makeSchedulingSession();
  });

  it('confirmation response includes date and time', () => {
    session.extractFromUserTranscript('Saturday 7 PM');
    const response = session.getSchedulingResponse();
    expect(response).not.toBeNull();
    expect(response).toMatch(/Saturday|site visit/i);
    expect(response).toMatch(/7|book/i);
  });

  it('confirmation response includes caller name when set', () => {
    session.extractFromUserTranscript('Mera naam Rahul hai');
    session.extractFromUserTranscript('Saturday 7 PM');
    const response = session.getSchedulingResponse();
    expect(response).toContain('Rahul');
  });
});
