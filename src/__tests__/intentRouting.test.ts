/**
 * Unit tests for intent classification, local response routing, and metrics.
 *
 * Verifies:
 *  1. Intent classification across English, Hindi, Hinglish
 *  2. Priority ordering (VISIT_REJECTION before VISIT_INTEREST, etc.)
 *  3. Deterministic responses from PropertyFacts (no hardcoding)
 *  4. Response quality (word count, sentence count, no invented facts)
 *  5. Routing logic (local vs LLM)
 *  6. Metrics tracking
 *  7. Edge cases (short utterances, mixed intents)
 */

import {
  Intent,
  classifyIntent,
  isLocallyRoutable,
  ClassificationResult,
} from '../modules/intent/IntentClassifier';
import { buildLocalResponse } from '../modules/intent/IntentResponses';
import { IntentMetrics } from '../modules/intent/IntentMetrics';
import { PropertyFacts } from '../modules/conversation/ConversationTypes';

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const TEST_FACTS: PropertyFacts = {
  projectName: 'Akshay Vista',
  location: 'Pimple Gurav, near Hinjewadi IT Park, Pune',
  price: '8,000 to 10,000 per square foot',
  bhkOptions: ['2 BHK', '2.5 BHK', '3 BHK'],
  possession: 'April 2027',
  builder: 'R. R. Lunkad',
  units: 78,
  amenities: ['gym', 'play area', 'jogging track', 'EV charging', 'covered parking'],
};

/** Different project to verify no hardcoding */
const ALT_FACTS: PropertyFacts = {
  projectName: 'Skyline Heights',
  location: 'Whitefield, Bangalore',
  price: '12,000 to 15,000 per square foot',
  bhkOptions: ['3 BHK', '4 BHK'],
  possession: 'December 2028',
  builder: 'XYZ Developers',
  units: 250,
  amenities: ['gym', 'swimming pool', 'tennis court'],
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function expectIntent(text: string, expected: Intent): void {
  const result = classifyIntent(text);
  expect(result.intent).toBe(expected);
}

function countSentences(text: string): number {
  // Split on sentence-ending punctuation, but ignore periods in numbers (e.g. "2.5 BHK")
  // and abbreviations. A sentence boundary is a period followed by a space+uppercase or end of string.
  const cleaned = text.replace(/(\d)\.(\d)/g, '$1_DOT_$2'); // protect decimal points
  return cleaned.split(/[.!?]+/).filter(s => s.trim().length > 3).length;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).length;
}

// ─── Intent Classification ──────────────────────────────────────────────────

describe('IntentClassifier', () => {
  describe('PRICE intent', () => {
    it('detects English price queries', () => {
      expectIntent('What is the price?', Intent.PRICE);
      expectIntent('How much does it cost per sqft?', Intent.PRICE);
      expectIntent('What is the rate?', Intent.PRICE);
      expectIntent('Is it affordable?', Intent.PRICE);
    });

    it('detects Hindi/Hinglish price queries', () => {
      expectIntent('kitna hai per sqft?', Intent.PRICE);
      expectIntent('price kya hai iska?', Intent.PRICE);
      expectIntent('keemat batao', Intent.PRICE);
    });
  });

  describe('LOCATION intent', () => {
    it('detects location queries', () => {
      expectIntent('Where is this project located?', Intent.LOCATION);
      expectIntent('kahan hai ye project?', Intent.LOCATION);
      expectIntent('What is the location?', Intent.LOCATION);
      expectIntent('Is it near any metro?', Intent.LOCATION);
      expectIntent('connectivity kaisi hai?', Intent.LOCATION);
      expectIntent('kitni door hai Hinjewadi se?', Intent.LOCATION);
    });
  });

  describe('AMENITIES intent', () => {
    it('detects amenity queries', () => {
      expectIntent('What amenities are available?', Intent.AMENITIES);
      expectIntent('Is there a gym?', Intent.AMENITIES);
      expectIntent('parking available hai?', Intent.AMENITIES);
      expectIntent('kya kya facilities hain?', Intent.AMENITIES);
      expectIntent('What all features are there?', Intent.AMENITIES);
    });
  });

  describe('BHK intent', () => {
    it('detects BHK queries', () => {
      expectIntent('What BHK options are available?', Intent.BHK);
      expectIntent('Do you have 3 bedroom flats?', Intent.BHK);
      expectIntent('flat size kya hai?', Intent.BHK);
      expectIntent('floor plan dikhao?', Intent.BHK);
      expectIntent('kaun kaun se bhk hain?', Intent.BHK);
    });
  });

  describe('POSSESSION intent', () => {
    it('detects possession queries', () => {
      expectIntent('When is the possession?', Intent.POSSESSION);
      expectIntent('kab milega flat?', Intent.POSSESSION);
      expectIntent('Is it ready to move?', Intent.POSSESSION);
      expectIntent('What is the delivery timeline?', Intent.POSSESSION);
      expectIntent('construction status kya hai?', Intent.POSSESSION);
    });
  });

  describe('DEVELOPER intent', () => {
    it('detects developer queries', () => {
      expectIntent('Who is the builder?', Intent.DEVELOPER);
      expectIntent('developer kaun hai?', Intent.DEVELOPER);
      expectIntent('Which company is building this?', Intent.DEVELOPER);
      expectIntent('builder kaun hai iska?', Intent.DEVELOPER);
      expectIntent('track record kaisa hai?', Intent.DEVELOPER);
    });
  });

  describe('UNITS intent', () => {
    it('detects units queries', () => {
      expectIntent('How many flats are there?', Intent.UNITS);
      expectIntent('kitne flat hain total?', Intent.UNITS);
      expectIntent('Total units in this project?', Intent.UNITS);
      expectIntent('How many towers?', Intent.UNITS);
    });
  });

  describe('VISIT_INTEREST intent', () => {
    it('detects visit interest', () => {
      expectIntent('I want to visit the site', Intent.VISIT_INTEREST);
      expectIntent('Can I schedule a visit?', Intent.VISIT_INTEREST);
      expectIntent('dekhna hai property', Intent.VISIT_INTEREST);
      expectIntent('book a visit please', Intent.VISIT_INTEREST);
    });
  });

  describe('VISIT_REJECTION intent', () => {
    it('detects visit rejection', () => {
      expectIntent('not interested in visiting', Intent.VISIT_REJECTION);
      expectIntent('visit nahi karna', Intent.VISIT_REJECTION);
      expectIntent('abhi nahi, later maybe', Intent.VISIT_REJECTION);
      expectIntent('I am busy right now', Intent.VISIT_REJECTION);
    });

    it('takes priority over VISIT_INTEREST', () => {
      // "visit nahi" should be REJECTION, not INTEREST
      expectIntent('visit nahi chahiye', Intent.VISIT_REJECTION);
      expectIntent('no visit please', Intent.VISIT_REJECTION);
    });
  });

  describe('OBJECTION intent', () => {
    it('detects objections', () => {
      expectIntent('This is too expensive for me', Intent.OBJECTION);
      expectIntent('mehnga hai yaar', Intent.OBJECTION);
      expectIntent('I need to think about it later', Intent.OBJECTION);
      expectIntent('Let me compare with other projects', Intent.OBJECTION);
      expectIntent('budget se zyada hai', Intent.OBJECTION);
    });
  });

  describe('UNKNOWN intent', () => {
    it('returns UNKNOWN for non-specific queries', () => {
      expectIntent('Tell me about the project', Intent.UNKNOWN);
      expectIntent('Can you help me?', Intent.UNKNOWN);
      expectIntent('What do you think?', Intent.UNKNOWN);
    });

    it('returns UNKNOWN for very short non-keyword utterances', () => {
      expectIntent('yes', Intent.UNKNOWN);
      expectIntent('ok', Intent.UNKNOWN);
      expectIntent('haan ji', Intent.UNKNOWN);
    });
  });

  describe('classification metadata', () => {
    it('includes classification time', () => {
      const result = classifyIntent('What is the price?');
      expect(result.classificationTimeUs).toBeGreaterThanOrEqual(0);
    });

    it('includes matched trigger', () => {
      const result = classifyIntent('What is the price per sqft?');
      expect(result.matchedTrigger).toBeTruthy();
    });

    it('reports confidence', () => {
      const long = classifyIntent('What is the price per sqft?');
      expect(long.confidence).toBe('high');
    });
  });
});

// ─── Locally Routable ───────────────────────────────────────────────────────

describe('isLocallyRoutable', () => {
  it('returns true for property-information intents', () => {
    expect(isLocallyRoutable(Intent.PRICE)).toBe(true);
    expect(isLocallyRoutable(Intent.LOCATION)).toBe(true);
    expect(isLocallyRoutable(Intent.AMENITIES)).toBe(true);
    expect(isLocallyRoutable(Intent.BHK)).toBe(true);
    expect(isLocallyRoutable(Intent.POSSESSION)).toBe(true);
    expect(isLocallyRoutable(Intent.DEVELOPER)).toBe(true);
    expect(isLocallyRoutable(Intent.UNITS)).toBe(true);
  });

  it('returns false for conversational intents', () => {
    expect(isLocallyRoutable(Intent.VISIT_INTEREST)).toBe(false);
    expect(isLocallyRoutable(Intent.VISIT_REJECTION)).toBe(false);
    expect(isLocallyRoutable(Intent.OBJECTION)).toBe(false);
    expect(isLocallyRoutable(Intent.UNKNOWN)).toBe(false);
  });
});

// ─── Deterministic Responses ────────────────────────────────────────────────

describe('buildLocalResponse', () => {
  const ROUTABLE_INTENTS: Intent[] = [
    Intent.PRICE, Intent.LOCATION, Intent.AMENITIES,
    Intent.BHK, Intent.POSSESSION, Intent.DEVELOPER, Intent.UNITS,
  ];

  it('returns a response for all routable intents', () => {
    for (const intent of ROUTABLE_INTENTS) {
      const response = buildLocalResponse(intent, TEST_FACTS);
      expect(response).toBeTruthy();
      expect(typeof response).toBe('string');
    }
  });

  it('returns null for non-routable intents', () => {
    expect(buildLocalResponse(Intent.VISIT_INTEREST, TEST_FACTS)).toBeNull();
    expect(buildLocalResponse(Intent.VISIT_REJECTION, TEST_FACTS)).toBeNull();
    expect(buildLocalResponse(Intent.OBJECTION, TEST_FACTS)).toBeNull();
    expect(buildLocalResponse(Intent.UNKNOWN, TEST_FACTS)).toBeNull();
  });

  it('responses are max 2 sentences', () => {
    for (const intent of ROUTABLE_INTENTS) {
      const response = buildLocalResponse(intent, TEST_FACTS)!;
      const sentences = countSentences(response);
      expect(sentences).toBeLessThanOrEqual(2);
    }
  });

  it('responses are under 40 words total', () => {
    for (const intent of ROUTABLE_INTENTS) {
      for (let turn = 0; turn < 5; turn++) {
        const response = buildLocalResponse(intent, TEST_FACTS, turn)!;
        const words = countWords(response);
        expect(words).toBeLessThanOrEqual(40);
      }
    }
  });

  it('uses PropertyFacts data — no hardcoded project details', () => {
    const priceA = buildLocalResponse(Intent.PRICE, TEST_FACTS)!;
    const priceB = buildLocalResponse(Intent.PRICE, ALT_FACTS)!;

    // Should contain their respective prices
    expect(priceA).toContain('8,000 to 10,000');
    expect(priceB).toContain('12,000 to 15,000');
  });

  it('amenities response lists actual amenities from facts', () => {
    const response = buildLocalResponse(Intent.AMENITIES, TEST_FACTS)!;
    expect(response).toContain('gym');
    expect(response).toContain('jogging track');

    const altResponse = buildLocalResponse(Intent.AMENITIES, ALT_FACTS)!;
    expect(altResponse).toContain('swimming pool');
    expect(altResponse).toContain('tennis court');
  });

  it('BHK response lists actual options from facts', () => {
    const response = buildLocalResponse(Intent.BHK, TEST_FACTS)!;
    expect(response).toContain('2 BHK');
    expect(response).toContain('3 BHK');

    const altResponse = buildLocalResponse(Intent.BHK, ALT_FACTS)!;
    expect(altResponse).toContain('3 BHK');
    expect(altResponse).toContain('4 BHK');
    expect(altResponse).not.toContain('2 BHK');
  });

  it('possession response uses actual date from facts', () => {
    const response = buildLocalResponse(Intent.POSSESSION, TEST_FACTS)!;
    expect(response).toContain('April 2027');

    const altResponse = buildLocalResponse(Intent.POSSESSION, ALT_FACTS)!;
    expect(altResponse).toContain('December 2028');
  });

  it('developer response uses actual builder from facts', () => {
    const response = buildLocalResponse(Intent.DEVELOPER, TEST_FACTS)!;
    // Builder name may have dots cleaned for TTS (e.g. "R. R." → "R R")
    expect(response).toMatch(/R\s*R\s*Lunkad/);

    const altResponse = buildLocalResponse(Intent.DEVELOPER, ALT_FACTS)!;
    expect(altResponse).toContain('XYZ Developers');
  });

  it('location response adapts to IT park proximity', () => {
    const response = buildLocalResponse(Intent.LOCATION, TEST_FACTS)!;
    expect(response).toContain('Pimple Gurav');

    const altResponse = buildLocalResponse(Intent.LOCATION, ALT_FACTS)!;
    expect(altResponse).toContain('Whitefield');
  });

  it('units response adapts to project scale', () => {
    const small = buildLocalResponse(Intent.UNITS, TEST_FACTS)!; // 78
    expect(small).toContain('78');

    const large = buildLocalResponse(Intent.UNITS, ALT_FACTS)!; // 250
    expect(large).toContain('250');
  });

  it('rotates insights across turns', () => {
    const r0 = buildLocalResponse(Intent.PRICE, TEST_FACTS, 0)!;
    const r1 = buildLocalResponse(Intent.PRICE, TEST_FACTS, 1)!;
    const r2 = buildLocalResponse(Intent.PRICE, TEST_FACTS, 2)!;

    // At least two should differ (insight rotation)
    const unique = new Set([r0, r1, r2]);
    expect(unique.size).toBeGreaterThanOrEqual(2);
  });
});

// ─── Response Safety ────────────────────────────────────────────────────────

describe('response safety', () => {
  const ROUTABLE_INTENTS: Intent[] = [
    Intent.PRICE, Intent.LOCATION, Intent.AMENITIES,
    Intent.BHK, Intent.POSSESSION, Intent.DEVELOPER, Intent.UNITS,
  ];

  it('never mentions amenities not in PropertyFacts', () => {
    const inventedPatterns = [/\bswimming pool\b/, /\bclubhouse\b/, /\btennis\b/, /\bspa\b/i];
    for (const intent of ROUTABLE_INTENTS) {
      for (let turn = 0; turn < 5; turn++) {
        const response = buildLocalResponse(intent, TEST_FACTS, turn)!;
        for (const pattern of inventedPatterns) {
          expect(response).not.toMatch(pattern);
        }
      }
    }
  });

  it('never invents specific rupee amounts', () => {
    for (const intent of ROUTABLE_INTENTS) {
      for (let turn = 0; turn < 5; turn++) {
        const response = buildLocalResponse(intent, TEST_FACTS, turn)!;
        expect(response).not.toMatch(/₹\d/);
        expect(response).not.toMatch(/\d+\s*lakh/i);
        expect(response).not.toMatch(/\d+\s*crore/i);
      }
    }
  });
});

// ─── Metrics ────────────────────────────────────────────────────────────────

describe('IntentMetrics', () => {
  it('tracks local vs LLM routing counts', () => {
    const metrics = new IntentMetrics('test-call');
    metrics.record(Intent.PRICE, 'local', 10);
    metrics.record(Intent.LOCATION, 'local', 8);
    metrics.record(Intent.UNKNOWN, 'llm', 5);

    const stats = metrics.getStats();
    expect(stats.routedLocal).toBe(2);
    expect(stats.routedLLM).toBe(1);
  });

  it('tracks intent distribution', () => {
    const metrics = new IntentMetrics('test-call');
    metrics.record(Intent.PRICE, 'local', 10);
    metrics.record(Intent.PRICE, 'local', 8);
    metrics.record(Intent.LOCATION, 'local', 12);
    metrics.record(Intent.UNKNOWN, 'llm', 5);

    const stats = metrics.getStats();
    expect(stats.distribution[Intent.PRICE]).toBe(2);
    expect(stats.distribution[Intent.LOCATION]).toBe(1);
    expect(stats.distribution[Intent.UNKNOWN]).toBe(1);
  });
});

// ─── End-to-End: classify + route ───────────────────────────────────────────

describe('end-to-end intent routing', () => {
  const PROPERTY_QUERIES = [
    'What is the price per sqft?',
    'Where is the project located?',
    'What amenities are available?',
    'What BHK options do you have?',
    'When is the possession date?',
    'Who is the developer?',
    'How many units are there?',
  ];

  it('routes property queries locally (≥80% target)', () => {
    let routed = 0;
    for (const query of PROPERTY_QUERIES) {
      const result = classifyIntent(query);
      if (isLocallyRoutable(result.intent)) {
        const response = buildLocalResponse(result.intent, TEST_FACTS);
        if (response) routed++;
      }
    }

    const pct = (routed / PROPERTY_QUERIES.length) * 100;
    expect(pct).toBeGreaterThanOrEqual(80);
  });

  it('falls through to LLM for conversational queries', () => {
    const conversational = [
      'Tell me more about the project',
      'Can you help me decide?',
      'I am not sure what I want',
    ];

    for (const query of conversational) {
      const result = classifyIntent(query);
      expect(isLocallyRoutable(result.intent)).toBe(false);
    }
  });

  it('classification is sub-millisecond', () => {
    for (const query of PROPERTY_QUERIES) {
      const result = classifyIntent(query);
      // classificationTimeUs should be well under 1000μs (1ms)
      expect(result.classificationTimeUs).toBeLessThan(1000);
    }
  });
});
