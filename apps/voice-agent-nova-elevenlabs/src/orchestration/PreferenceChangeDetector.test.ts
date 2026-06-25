/**
 * Tests for preference change detection (BHK, budget).
 *
 * Covers:
 *  1. First-mention capture (no existing value)
 *  2. Correction with explicit signal → value updates + SESSION_FIELD_UPDATED
 *  3. New value without correction signal → value does NOT change (could be a question)
 *  4. Same value re-stated → no update
 *  5. Latest value reflected in preferences getter
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

import { detectPreferenceChanges } from './PreferenceChangeDetector';
import { SessionState } from './SessionState';

// ─── PreferenceChangeDetector unit tests ─────────────────────────────────────

describe('detectPreferenceChanges', () => {
  describe('BHK detection', () => {
    it('extracts BHK on first mention (no existing)', () => {
      const result = detectPreferenceChanges('2 BHK chahiye', null, null);
      expect(result.newBhk).toBe('2 BHK');
      expect(result.changes).toHaveLength(0);
    });

    it('detects BHK correction with "actually"', () => {
      const result = detectPreferenceChanges(
        'Actually 2 BHK nahi, 3 BHK dekh raha hoon.',
        '2 BHK',
        null,
      );
      expect(result.newBhk).toBe('3 BHK');
      expect(result.hasCorrection).toBe(true);
      const change = result.changes.find(c => c.field === 'bhk');
      expect(change).toBeDefined();
      expect(change!.oldValue).toBe('2 BHK');
      expect(change!.newValue).toBe('3 BHK');
    });

    it('detects BHK correction with "nahi" signal', () => {
      const result = detectPreferenceChanges('2 BHK nahi chahiye, 3 BHK chahiye', '2 BHK', null);
      expect(result.newBhk).toBe('3 BHK');
      expect(result.hasCorrection).toBe(true);
      expect(result.changes.some(c => c.field === 'bhk')).toBe(true);
    });

    it('does NOT create a change when BHK mentioned in question (no correction signal)', () => {
      const result = detectPreferenceChanges('3 BHK mein kitna price hai?', '2 BHK', null);
      expect(result.newBhk).toBe('3 BHK');
      expect(result.hasCorrection).toBe(false);
      expect(result.changes).toHaveLength(0);
    });

    it('does NOT create a change when new BHK equals existing BHK', () => {
      const result = detectPreferenceChanges('Actually 2 BHK hi chahiye', '2 BHK', null);
      expect(result.changes).toHaveLength(0);
    });

    it('supports 2.5 BHK', () => {
      const result = detectPreferenceChanges('Actually 2.5 BHK better rahega', '2 BHK', null);
      expect(result.newBhk).toBe('2.5 BHK');
      expect(result.changes.some(c => c.field === 'bhk')).toBe(true);
    });
  });

  describe('Budget detection', () => {
    it('extracts budget on first mention (no existing)', () => {
      const result = detectPreferenceChanges('Mera budget 80 lakh hai', null, null);
      expect(result.newBudget).not.toBeNull();
      expect(result.newBudget).toContain('80');
      expect(result.changes).toHaveLength(0);
    });

    it('detects budget correction with "nahi"', () => {
      const result = detectPreferenceChanges(
        'Budget 80 lakh nahi, 1 crore tak hai.',
        null,
        '80 lakh',
      );
      expect(result.newBudget).toContain('1');
      expect(result.hasCorrection).toBe(true);
      const change = result.changes.find(c => c.field === 'budget');
      expect(change).toBeDefined();
      expect(change!.oldValue).toBe('80 lakh');
    });

    it('does NOT change budget when mentioned in question (no correction signal)', () => {
      const result = detectPreferenceChanges('1 crore mein kya milega?', null, '80 lakh');
      expect(result.hasCorrection).toBe(false);
      expect(result.changes).toHaveLength(0);
    });
  });

  describe('correction signal detection', () => {
    const CORRECTION_PHRASES = [
      'actually nahi',
      'instead of 2 BHK',
      'change karna hai',
      'rather 3 BHK',
      'updated budget hai',
      'nahi chahiye 2 BHK',
      'badal gaya plan',
      'correction karna tha',
      'alag BHK chahiye',
    ];

    it.each(CORRECTION_PHRASES)('detects correction in: "%s"', (phrase) => {
      const result = detectPreferenceChanges(phrase, null, null);
      expect(result.hasCorrection).toBe(true);
    });

    it('does NOT detect correction in plain question', () => {
      const result = detectPreferenceChanges('3 BHK mein kya facilities hain?', null, null);
      expect(result.hasCorrection).toBe(false);
    });
  });
});

// ─── SessionState integration tests ──────────────────────────────────────────

describe('SessionState preference correction', () => {
  let session: SessionState;

  beforeEach(() => {
    session = new SessionState('test-call-prefs');
  });

  describe('BHK preference', () => {
    it('captures BHK on first mention', () => {
      session.extractFromUserTranscript('Mujhe 2 BHK chahiye');
      expect(session.info.bhkPreference).toBe('2 BHK');
    });

    it('updates BHK when corrected with explicit signal', () => {
      session.extractFromUserTranscript('Mujhe 2 BHK chahiye');
      session.extractFromUserTranscript('Actually 2 BHK nahi, 3 BHK dekh raha hoon.');
      expect(session.info.bhkPreference).toBe('3 BHK');
    });

    it('does NOT update BHK when asked about a different BHK without correction', () => {
      session.extractFromUserTranscript('Mujhe 2 BHK chahiye');
      session.extractFromUserTranscript('3 BHK mein price kya hai?');
      expect(session.info.bhkPreference).toBe('2 BHK');
    });

    it('does not change BHK when same value re-stated with correction', () => {
      session.extractFromUserTranscript('2 BHK chahiye mujhe');
      session.extractFromUserTranscript('Actually 2 BHK hi theek hai');
      expect(session.info.bhkPreference).toBe('2 BHK');
    });

    it('reflects latest BHK in preferences getter', () => {
      session.extractFromUserTranscript('2 BHK chahiye');
      session.extractFromUserTranscript('Actually 3 BHK better hai, change karna hai');
      expect(session.preferences.bhk).toBe('3 BHK');
    });
  });

  describe('Budget preference', () => {
    it('captures budget on first mention', () => {
      session.extractFromUserTranscript('Mera budget 80 lakh hai');
      expect(session.info.budgetMentioned).toContain('80');
    });

    it('updates budget when corrected with explicit signal', () => {
      session.extractFromUserTranscript('Budget 80 lakh hai');
      session.extractFromUserTranscript('Budget 80 lakh nahi, 1 crore tak hai');
      expect(session.info.budgetMentioned).toContain('1');
    });

    it('does NOT update budget when mentioned in a question without correction', () => {
      session.extractFromUserTranscript('Mera budget 80 lakh hai');
      session.extractFromUserTranscript('1 crore mein kya options hain?');
      expect(session.info.budgetMentioned).toContain('80');
    });

    it('reflects latest budget in preferences getter', () => {
      session.extractFromUserTranscript('Budget 80 lakh hai');
      session.extractFromUserTranscript('Actually budget 1 crore hai mera');
      expect(session.preferences.budget).toContain('1');
    });
  });
});
