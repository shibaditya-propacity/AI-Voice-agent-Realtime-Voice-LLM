/**
 * Unit tests for ResponseEnrichment and InsightLibrary.
 *
 * Verifies:
 *  1. Intent detection from user utterances (English, Hindi, Hinglish)
 *  2. Insight generation from PropertyFacts (no hardcoded project details)
 *  3. Enrichment directive formatting
 *  4. Edge cases: short utterances, scheduling steps, unknown intents
 *  5. Insight word count limits
 */

import { detectIntent, buildEnrichmentDirective } from '../modules/conversation/ResponseEnrichment';
import { getInsight, getAvailableIntents, QuestionIntent } from '../modules/conversation/InsightLibrary';
import { PropertyFacts } from '../modules/conversation/ConversationTypes';

// ─── Test fixtures ──────────────────────────────────────────────────────────

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

/** A different project to verify no hardcoding */
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

// ─── Intent Detection ───────────────────────────────────────────────────────

describe('detectIntent', () => {
  it('detects PRICE intent from English queries', () => {
    expect(detectIntent('What is the price?')).toBe('PRICE');
    expect(detectIntent('How much does it cost per sqft?')).toBe('PRICE');
    expect(detectIntent('What is the rate?')).toBe('PRICE');
    expect(detectIntent('Is it affordable?')).toBe('PRICE');
  });

  it('detects PRICE intent from Hindi/Hinglish queries', () => {
    expect(detectIntent('kitna per sqft hai?')).toBe('PRICE');
    expect(detectIntent('kya budget chahiye?')).toBe('PRICE');
    expect(detectIntent('price kya hai iska?')).toBe('PRICE');
  });

  it('detects LOCATION intent', () => {
    expect(detectIntent('Where is this project located?')).toBe('LOCATION');
    expect(detectIntent('kahan hai ye project?')).toBe('LOCATION');
    expect(detectIntent('What is the location?')).toBe('LOCATION');
    expect(detectIntent('Is it near any metro station?')).toBe('LOCATION');
    expect(detectIntent('connectivity kaisi hai?')).toBe('LOCATION');
  });

  it('detects AMENITIES intent', () => {
    expect(detectIntent('What amenities are available?')).toBe('AMENITIES');
    expect(detectIntent('Is there a gym?')).toBe('AMENITIES');
    expect(detectIntent('parking available hai?')).toBe('AMENITIES');
    expect(detectIntent('kya facilities hain?')).toBe('AMENITIES');
  });

  it('detects DEVELOPER intent', () => {
    expect(detectIntent('Who is the builder?')).toBe('DEVELOPER');
    expect(detectIntent('developer kaun hai?')).toBe('DEVELOPER');
    expect(detectIntent('Which company is building this?')).toBe('DEVELOPER');
    expect(detectIntent('Lunkad group ka hai kya?')).toBe('DEVELOPER');
  });

  it('detects POSSESSION intent', () => {
    expect(detectIntent('When is the possession?')).toBe('POSSESSION');
    expect(detectIntent('kab milega flat?')).toBe('POSSESSION');
    expect(detectIntent('Is it ready to move?')).toBe('POSSESSION');
    expect(detectIntent('What is the delivery timeline?')).toBe('POSSESSION');
  });

  it('detects BHK intent', () => {
    expect(detectIntent('What BHK options are available?')).toBe('BHK');
    expect(detectIntent('Do you have 3 bedroom flats?')).toBe('BHK');
    expect(detectIntent('flat size kya hai?')).toBe('BHK');
    expect(detectIntent('floor plan dikhao?')).toBe('BHK');
  });

  it('detects UNITS intent', () => {
    expect(detectIntent('How many flats are there?')).toBe('UNITS');
    expect(detectIntent('kitne flat hain total?')).toBe('UNITS');
    expect(detectIntent('How many units in this project?')).toBe('UNITS');
  });

  it('returns GENERAL for non-specific queries', () => {
    expect(detectIntent('Tell me about the project')).toBe('GENERAL');
    expect(detectIntent('I am interested')).toBe('GENERAL');
  });

  it('returns GENERAL for very short utterances (greetings/confirmations)', () => {
    expect(detectIntent('yes')).toBe('GENERAL');
    expect(detectIntent('ok')).toBe('GENERAL');
    expect(detectIntent('haan')).toBe('GENERAL');
  });
});

// ─── Insight Generation ─────────────────────────────────────────────────────

describe('getInsight', () => {
  it('generates insights for all intents', () => {
    const intents = getAvailableIntents();
    for (const intent of intents) {
      const insight = getInsight(intent, TEST_FACTS, 0);
      expect(insight).toBeTruthy();
      expect(typeof insight).toBe('string');
    }
  });

  it('uses PropertyFacts data — no hardcoded project names', () => {
    const insightA = getInsight('PRICE', TEST_FACTS, 0);
    const insightB = getInsight('PRICE', ALT_FACTS, 0);

    // Insights should reference their respective project names
    expect(insightA).toContain('Akshay Vista');
    expect(insightB).toContain('Skyline Heights');
  });

  it('adapts developer insights to the project location', () => {
    const insight = getInsight('DEVELOPER', TEST_FACTS, 0);
    // Should reference the city from the location field
    expect(insight).toContain('Pune');

    const altInsight = getInsight('DEVELOPER', ALT_FACTS, 0);
    expect(altInsight).toContain('Bangalore');
  });

  it('adapts location insights based on IT park proximity', () => {
    const insight = getInsight('LOCATION', TEST_FACTS, 0);
    expect(insight).toContain('IT professionals');

    // Alt facts don't have IT park in location
    const altInsight = getInsight('LOCATION', ALT_FACTS, 0);
    expect(altInsight).not.toContain('IT professionals');
  });

  it('adapts unit insights based on project size', () => {
    const smallInsight = getInsight('UNITS', TEST_FACTS, 0); // 78 units
    expect(smallInsight).toContain('Limited units');

    const largeInsight = getInsight('UNITS', ALT_FACTS, 0); // 250 units
    expect(largeInsight).toContain('Mid-size');
  });

  it('rotates insights across turns', () => {
    const insight0 = getInsight('PRICE', TEST_FACTS, 0);
    const insight1 = getInsight('PRICE', TEST_FACTS, 1);
    const insight2 = getInsight('PRICE', TEST_FACTS, 2);

    // Should cycle through different templates
    expect(insight0).not.toBe(insight1);
    expect(insight1).not.toBe(insight2);

    // Should wrap around
    const insight3 = getInsight('PRICE', TEST_FACTS, 3);
    expect(insight3).toBe(insight0);
  });

  it('keeps insights under 20 words each', () => {
    const intents = getAvailableIntents();
    for (const intent of intents) {
      for (let turn = 0; turn < 5; turn++) {
        const insight = getInsight(intent, TEST_FACTS, turn);
        const wordCount = insight.split(/\s+/).length;
        expect(wordCount).toBeLessThanOrEqual(20);
      }
    }
  });
});

// ─── Enrichment Directive ───────────────────────────────────────────────────

describe('buildEnrichmentDirective', () => {
  it('returns enrichment block for price questions', () => {
    const directive = buildEnrichmentDirective('What is the price?', TEST_FACTS, 0);
    expect(directive).toContain('[RESPONSE INSIGHT]');
    expect(directive).toContain('2 sentences');
  });

  it('returns empty string for GENERAL intent', () => {
    const directive = buildEnrichmentDirective('Tell me about the project', TEST_FACTS, 0);
    expect(directive).toBe('');
  });

  it('returns empty string during scheduling steps', () => {
    const directive = buildEnrichmentDirective('What is the price?', TEST_FACTS, 0, true);
    expect(directive).toBe('');
  });

  it('returns empty string for very short utterances', () => {
    const directive = buildEnrichmentDirective('yes', TEST_FACTS, 0);
    expect(directive).toBe('');
  });

  it('includes the actual insight text in the directive', () => {
    const directive = buildEnrichmentDirective('What amenities are available?', TEST_FACTS, 0);
    expect(directive).toContain('insight');
    // Should contain insight content referencing amenity count
    expect(directive).toMatch(/\d+\s+key\s+amenities/);
  });

  it('works with different PropertyFacts (no hardcoding)', () => {
    const directiveA = buildEnrichmentDirective('Who is the builder?', TEST_FACTS, 0);
    const directiveB = buildEnrichmentDirective('Who is the builder?', ALT_FACTS, 0);

    // Both should have insights but with different content
    expect(directiveA).toContain('[RESPONSE INSIGHT]');
    expect(directiveB).toContain('[RESPONSE INSIGHT]');
    expect(directiveA).not.toBe(directiveB);
  });
});

// ─── Integration: insight never invents facts ───────────────────────────────

describe('insight safety', () => {
  it('never mentions amenities not in PropertyFacts', () => {
    const intents = getAvailableIntents();
    // Use word-boundary regex to avoid false positives (e.g. "spa" in "transparent")
    const inventedAmenities = [/\bswimming pool\b/, /\bclubhouse\b/, /\btennis\b/, /\bspa\b/, /\bsauna\b/];

    for (const intent of intents) {
      for (let turn = 0; turn < 5; turn++) {
        const insight = getInsight(intent, TEST_FACTS, turn).toLowerCase();
        for (const pattern of inventedAmenities) {
          expect(insight).not.toMatch(pattern);
        }
      }
    }
  });

  it('never invents prices or specific numbers not in facts', () => {
    const intents = getAvailableIntents();
    for (const intent of intents) {
      for (let turn = 0; turn < 5; turn++) {
        const insight = getInsight(intent, TEST_FACTS, turn);
        // Should not contain specific rupee amounts
        expect(insight).not.toMatch(/₹\d/);
        expect(insight).not.toMatch(/\d+\s*lakh/i);
        expect(insight).not.toMatch(/\d+\s*crore/i);
      }
    }
  });
});
