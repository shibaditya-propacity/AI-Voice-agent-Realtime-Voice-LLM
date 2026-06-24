import { describe, it, expect } from 'vitest';
import {
  detectRecallQuery,
  buildRecallResponse,
  factFollowUp,
  buildSchedulingRecap,
  parseBudget,
  type PreferenceValues,
} from './PreferenceRecall';

/**
 * Preference memory — deterministic recall + missing-field logic.
 * Pure module (no env/SessionState/LLM), so it runs standalone under vitest.
 * Covers the requirements: captured fields are never re-asked, recall queries
 * return stored values, empty fields are never hallucinated, and the scheduling
 * recap uses stored preferences.
 */

const EMPTY: PreferenceValues = { name: null, budget: null, bhk: null, day: null, time: null };
const FULL: PreferenceValues = {
  name: 'Rahul', budget: '80 lakh', bhk: '3 BHK', day: 'Saturday', time: 'morning',
};

// ─── Requirement 2/5: captured fields never re-asked ──────────────────────────

describe('factFollowUp — never re-ask a captured field', () => {
  it('does NOT ask BHK once bhkPreference is captured', () => {
    const r = factFollowUp('BHK', { budget: null, bhk: '3 BHK' });
    expect(r.clause).toBe('');
    expect(r.reused).toBe(true);
    expect(r.field).toBe('bhk');
  });

  it('asks BHK when not captured', () => {
    const r = factFollowUp('BHK', { budget: null, bhk: null });
    expect(r.clause).toMatch(/configuration/);
    expect(r.reused).toBe(false);
  });

  it('does NOT ask budget once budget is captured', () => {
    const r = factFollowUp('PRICE', { budget: '80 lakh', bhk: null });
    expect(r.clause).toBe('');
    expect(r.reused).toBe(true);
    expect(r.field).toBe('budget');
  });

  it('asks budget when not captured', () => {
    const r = factFollowUp('PRICE', { budget: null, bhk: null });
    expect(r.clause).toMatch(/budget range/);
    expect(r.reused).toBe(false);
  });

  it('adds no follow-up for non-slot intents', () => {
    expect(factFollowUp('LOCATION', { budget: null, bhk: null }).clause).toBe('');
    expect(factFollowUp('AMENITIES', { budget: '80 lakh', bhk: '3 BHK' }).clause).toBe('');
  });
});

// ─── Requirement 3: recall detection ──────────────────────────────────────────

describe('detectRecallQuery', () => {
  it.each([
    ['what was my budget?', 'budget'],
    ['mera budget kya bola tha', 'budget'],
    ['what BHK did I tell you', 'bhk'],
    ['maine kaunsa bhk bataya tha', 'bhk'],
    ['what is my name', 'name'],
    ['can you tell me my requirement again', 'all'],
    ['what did I mention earlier', 'all'],
  ] as const)('detects %j → %s', (text, target) => {
    expect(detectRecallQuery(text)).toBe(target);
  });

  it('does NOT treat a fresh question as recall', () => {
    expect(detectRecallQuery('what is the price')).toBeNull();
    expect(detectRecallQuery('kitne ka 3 bhk hai')).toBeNull();
    expect(detectRecallQuery('amenities kya hain')).toBeNull();
  });
});

// ─── Requirement 3: recall returns stored values ──────────────────────────────

describe('buildRecallResponse — returns stored values', () => {
  it('recalls budget from storage', () => {
    const r = buildRecallResponse('budget', FULL);
    expect(r.used).toBe(true);
    expect(r.response).toContain('80 lakh');
  });

  it('recalls BHK from storage', () => {
    const r = buildRecallResponse('bhk', FULL);
    expect(r.used).toBe(true);
    expect(r.response).toContain('3 BHK');
  });

  it('recalls visit day from storage', () => {
    const r = buildRecallResponse('day', FULL);
    expect(r.used).toBe(true);
    expect(r.response).toContain('Saturday');
  });

  it('summarises all captured preferences', () => {
    const r = buildRecallResponse('all', FULL);
    expect(r.used).toBe(true);
    expect(r.response).toContain('3 BHK');
    expect(r.response).toContain('80 lakh');
    expect(r.response).toContain('Rahul');
  });
});

// ─── Requirement (empty fields never hallucinated) ────────────────────────────

describe('buildRecallResponse — never hallucinate empty fields', () => {
  it('budget not captured → honest "not mentioned", no fabricated value', () => {
    const r = buildRecallResponse('budget', EMPTY);
    expect(r.used).toBe(false);
    expect(r.response).toMatch(/नहीं किया|mention नहीं/);
    expect(r.response).not.toMatch(/lakh|crore|\d/);
  });

  it('bhk not captured → honest "not told" (no claimed preference)', () => {
    const r = buildRecallResponse('bhk', EMPTY);
    expect(r.used).toBe(false);
    expect(r.response).toMatch(/नहीं बताया/);
  });

  it('all empty → asks rather than inventing', () => {
    const r = buildRecallResponse('all', EMPTY);
    expect(r.used).toBe(false);
    expect(r.response).not.toMatch(/Rahul|80 lakh|3 BHK/);
  });
});

// ─── Budget extraction: digits AND number words (the re-ask bug) ──────────────

describe('parseBudget', () => {
  it('parses the Hindi number-word budget that was being missed', () => {
    // Real transcript that the bot kept re-asking on:
    expect(parseBudget('मैं पचास लाख से budget में देख रहा हूं')).toBe('50 lakh');
  });

  it.each([
    ['50 lakh', '50 lakh'],
    ['budget around 80 lakh', '80 lakh'],
    ['1.5 crore', '1.5 crore'],
    ['fifty lakh', '50 lakh'],
    ['eighty lakh tak', '80 lakh'],
    ['अस्सी लाख', '80 lakh'],
    ['एक करोड़', '1 crore'],
    ['डेढ़ करोड़ tak', '1.5 crore'],
  ])('parses %j → %s', (text, expected) => {
    expect(parseBudget(text.toLowerCase())).toBe(expected);
  });

  it('returns null when no budget is present', () => {
    expect(parseBudget('property में क्या क्या facility')).toBeNull();
    expect(parseBudget('what amenities do you have')).toBeNull();
  });
});

// ─── Requirement 4: scheduling uses stored preferences ────────────────────────

describe('buildSchedulingRecap', () => {
  it('weaves in captured BHK + budget', () => {
    const recap = buildSchedulingRecap({ bhk: '3 BHK', budget: '80 lakh' });
    expect(recap).toContain('3 BHK');
    expect(recap).toContain('80 lakh');
  });

  it('uses only what is captured (BHK only)', () => {
    const recap = buildSchedulingRecap({ bhk: '2 BHK', budget: null });
    expect(recap).toContain('2 BHK');
    expect(recap).not.toMatch(/budget/);
  });

  it('returns empty string when nothing captured (no hallucination)', () => {
    expect(buildSchedulingRecap({ bhk: null, budget: null })).toBe('');
  });
});
