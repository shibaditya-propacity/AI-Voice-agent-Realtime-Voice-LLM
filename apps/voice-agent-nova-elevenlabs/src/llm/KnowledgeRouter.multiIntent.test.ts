/**
 * Multi-intent query handling tests for KnowledgeRouter.
 *
 * Verifies that routeMultiQuery() detects 2+ fact intents in one utterance
 * and returns a combined compact response without an LLM call.
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

import { routeMultiQuery, routeQuery, resetLastRouterIntent } from './KnowledgeRouter';
import type { SessionState } from '../orchestration/SessionState';
import type { Logger } from '../shared/logger';

function makeSession(step = 'QUESTION_HANDLING'): SessionState {
  return {
    currentStep: step,
    budget: null,
    bhkPreference: null,
    shouldSuggestVisit: () => false,
    markVisitSuggested: vi.fn(),
    recordQuestion: vi.fn(),
    info: { preferredDate: null, preferredTime: null },
  } as unknown as SessionState;
}

const mockLog = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger;

describe('routeMultiQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module-level router state so repeat-guard doesn't affect tests
    resetLastRouterIntent();
  });

  describe('detection', () => {
    it('detects PRICE + POSSESSION query', () => {
      const result = routeMultiQuery('Price kya hai aur possession kab hai?', makeSession(), mockLog);
      expect(result).not.toBeNull();
      expect(result!.handled).toBe(true);
      expect(result!.reason).toContain('multi_intent');
    });

    it('detects LOCATION + AMENITIES query', () => {
      const result = routeMultiQuery('Location kahan hai aur amenities kya hain?', makeSession(), mockLog);
      expect(result).not.toBeNull();
      expect(result!.handled).toBe(true);
    });

    it('detects PRICE + LOCATION in Hinglish', () => {
      const result = routeMultiQuery('price kya hai aur location kahan hai', makeSession(), mockLog);
      expect(result).not.toBeNull();
      expect(result!.handled).toBe(true);
    });

    it('returns null for single-intent queries', () => {
      const result = routeMultiQuery('Price kya hai?', makeSession(), mockLog);
      expect(result).toBeNull();
    });

    it('returns null for queries with no fact intent', () => {
      const result = routeMultiQuery('site visit karna hai', makeSession(), mockLog);
      expect(result).toBeNull();
    });
  });

  describe('response format', () => {
    it('combines two compact sentences', () => {
      const result = routeMultiQuery('price aur possession kya hai', makeSession(), mockLog);
      expect(result).not.toBeNull();
      const sentences = result!.response.split('।').filter(s => s.trim().length > 0);
      expect(sentences.length).toBeGreaterThanOrEqual(2);
    });

    it('includes relevant facts in response', () => {
      const result = routeMultiQuery('price kya hai aur location kahan hai', makeSession(), mockLog);
      expect(result).not.toBeNull();
      // Should mention price range or location
      expect(result!.response).toMatch(/lakh|crore|Pimple Gurav|metro/i);
    });

    it('limits to 2 intents even when 3+ match', () => {
      // price + location + possession
      const result = routeMultiQuery('price, location, aur possession kab hai', makeSession(), mockLog);
      expect(result).not.toBeNull();
      // Response should not be excessively long (2 sentences max)
      const sentences = result!.response.split('।').filter(s => s.trim().length > 0);
      expect(sentences.length).toBeLessThanOrEqual(3); // 2 sentences + possible trailing
    });
  });

  describe('exclusion gates', () => {
    it('returns null for comparison queries', () => {
      const result = routeMultiQuery('2 BHK vs 3 BHK price compare karo', makeSession(), mockLog);
      expect(result).toBeNull();
    });

    it('returns null during terminal steps', () => {
      const result = routeMultiQuery('price aur location kya hai', makeSession('BOOKED'), mockLog);
      expect(result).toBeNull();
    });

    it('returns null for visit scheduling queries', () => {
      const result = routeMultiQuery('price kya hai aur visit schedule karna hai', makeSession(), mockLog);
      expect(result).toBeNull();
    });
  });

  describe('single-intent fallback (routeQuery still works)', () => {
    it('routeQuery handles single PRICE intent after multiQuery returns null', () => {
      const session = makeSession();
      const multiResult = routeMultiQuery('Price kya hai?', session, mockLog);
      expect(multiResult).toBeNull();

      const singleResult = routeQuery('Price kya hai?', session, mockLog);
      expect(singleResult.handled).toBe(true);
      expect(singleResult.intent).toBe('PRICE');
    });
  });
});
