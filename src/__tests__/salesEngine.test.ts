/**
 * Tests for the sales context engine: objection handling, visit invitation
 * strategy, conversation memory, humanization, and property advantages.
 */

import { handleObjection, detectObjection, getObjectionResponse } from '../modules/sales/CommonObjections';
import type { ObjectionType } from '../modules/sales/CommonObjections';
import { ConversationMemory } from '../modules/sales/ConversationMemory';
import { Humanizer } from '../modules/sales/Humanizer';
import { getVisitPitch } from '../modules/sales/VisitPitches';
import { deriveAdvantages, pickAdvantage } from '../modules/sales/PropertyAdvantages';
import { Intent } from '../modules/intent/IntentClassifier';
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

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 3 — PROPERTY ADVANTAGES
// ═══════════════════════════════════════════════════════════════════════════

describe('PropertyAdvantages', () => {
  it('derives advantages from PropertyFacts', () => {
    const advantages = deriveAdvantages(TEST_FACTS);
    expect(advantages.length).toBeGreaterThan(0);
  });

  it('includes connectivity advantage for IT park proximity', () => {
    const advantages = deriveAdvantages(TEST_FACTS);
    const connectivity = advantages.filter(a => a.category === 'connectivity');
    expect(connectivity.some(a => a.text.includes('IT'))).toBe(true);
  });

  it('derives IT advantage for known IT hub locations', () => {
    // Whitefield is a known IT hub — should get IT advantage
    const advantages = deriveAdvantages(ALT_FACTS);
    const connectivity = advantages.filter(a => a.category === 'connectivity');
    const hasIT = connectivity.some(a => a.text.includes('IT'));
    expect(hasIT).toBe(true);

    // A non-IT location should NOT get IT advantage
    const nonIT: PropertyFacts = { ...ALT_FACTS, location: 'Aundh, Pune' };
    const nonITAdvantages = deriveAdvantages(nonIT);
    const nonITConn = nonITAdvantages.filter(a => a.category === 'connectivity');
    const nonITHasIT = nonITConn.some(a => a.text.includes('IT'));
    expect(nonITHasIT).toBe(false);
  });

  it('includes limited inventory for small projects', () => {
    const advantages = deriveAdvantages(TEST_FACTS); // 78 units
    const inventory = advantages.filter(a => a.category === 'inventory');
    expect(inventory.length).toBeGreaterThan(0);
  });

  it('pickAdvantage returns category-specific text', () => {
    const text = pickAdvantage(TEST_FACTS, 'developer_trust');
    expect(text).toBeTruthy();
    expect(text).toContain('Pune');
  });

  it('adapts to different PropertyFacts', () => {
    const pune = pickAdvantage(TEST_FACTS, 'developer_trust');
    const blr = pickAdvantage(ALT_FACTS, 'developer_trust');
    expect(pune).toContain('Pune');
    expect(blr).toContain('Bangalore');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 4 — OBJECTION PLAYBOOKS
// ═══════════════════════════════════════════════════════════════════════════

describe('CommonObjections', () => {
  describe('detectObjection', () => {
    it('detects expensive objection', () => {
      expect(detectObjection('Price zyada lag raha hai')).toBe('expensive');
      expect(detectObjection('bahut mehnga hai')).toBe('expensive');
      expect(detectObjection('This is too expensive')).toBe('expensive');
      expect(detectObjection('budget se zyada hai')).toBe('expensive');
    });

    it('detects not interested', () => {
      expect(detectObjection('I am not interested')).toBe('not_interested');
      expect(detectObjection('interested nahi hoon')).toBe('not_interested');
    });

    it('detects exploring other projects', () => {
      expect(detectObjection('I am comparing other options')).toBe('exploring_others');
      expect(detectObjection('aur bhi dekh raha hoon')).toBe('exploring_others');
      expect(detectObjection('other projects bhi explore kar raha')).toBe('exploring_others');
    });

    it('detects family approval needed', () => {
      expect(detectObjection('Family se discuss karna hai')).toBe('family_approval');
      expect(detectObjection('wife se baat karni hai')).toBe('family_approval');
      expect(detectObjection('parents se poochna padega')).toBe('family_approval');
    });

    it('detects need for more info', () => {
      expect(detectObjection('Can you send more details?')).toBe('need_info');
      expect(detectObjection('brochure bhejo')).toBe('need_info');
      expect(detectObjection('aur batao iske baare mein')).toBe('need_info');
    });

    it('detects busy now', () => {
      expect(detectObjection('I am busy right now')).toBe('busy_now');
      expect(detectObjection('abhi nahi baat ho sakti')).toBe('busy_now');
      expect(detectObjection("can't talk now")).toBe('busy_now');
    });

    it('detects call later', () => {
      expect(detectObjection('call me later')).toBe('call_later');
      expect(detectObjection('baad mein call karo')).toBe('call_later');
    });

    it('returns null for non-objection text', () => {
      expect(detectObjection('What is the price?')).toBeNull();
      expect(detectObjection('Tell me about amenities')).toBeNull();
    });
  });

  describe('handleObjection', () => {
    const OBJECTION_TYPES: ObjectionType[] = [
      'expensive', 'not_interested', 'exploring_others',
      'family_approval', 'need_info', 'busy_now', 'call_later',
    ];

    it('returns a response for all objection types', () => {
      for (const type of OBJECTION_TYPES) {
        const response = getObjectionResponse(type, 0);
        expect(response).toBeTruthy();
      }
    });

    it('responses are max 2 sentences', () => {
      for (const type of OBJECTION_TYPES) {
        for (let turn = 0; turn < 5; turn++) {
          const response = getObjectionResponse(type, turn);
          const sentences = response.split(/[.!?]+/).filter(s => s.trim().length > 3).length;
          expect(sentences).toBeLessThanOrEqual(2);
        }
      }
    });

    it('responses rotate across turns', () => {
      const r0 = getObjectionResponse('expensive', 0);
      const r1 = getObjectionResponse('expensive', 1);
      expect(r0).not.toBe(r1);
    });

    it('handleObjection returns response for recognized objections', () => {
      const response = handleObjection('bahut mehnga hai', 0);
      expect(response).toBeTruthy();
      expect(response).toContain('Samajh');
    });

    it('handleObjection returns null for non-objections', () => {
      expect(handleObjection('What is the price?')).toBeNull();
    });

    it('never pushes for immediate site visit', () => {
      for (const type of OBJECTION_TYPES) {
        for (let turn = 0; turn < 5; turn++) {
          const response = getObjectionResponse(type, turn).toLowerCase();
          // Should not contain aggressive visit pushes
          expect(response).not.toMatch(/\bvisit\s*kariye\b/);
          expect(response).not.toMatch(/\bsite\s*visit\s*book\b/);
        }
      }
    });

    it('always acknowledges first (starts with empathy)', () => {
      // Expensive objection responses should start with acknowledgement
      const response = getObjectionResponse('expensive', 0);
      const startsWithAck = /^(Samajh|Bilkul|Budget|Haan|Theek|Zaroor|Koi)/i.test(response);
      expect(startsWithAck).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 5 — VISIT INVITATION STRATEGY
// ═══════════════════════════════════════════════════════════════════════════

describe('VisitPitches', () => {
  it('generates a visit pitch from PropertyFacts', () => {
    const pitch = getVisitPitch(TEST_FACTS, 0, 'Rahul');
    expect(pitch).toBeTruthy();
    expect(pitch).toContain('Rahul');
  });

  it('works without caller name', () => {
    const pitch = getVisitPitch(TEST_FACTS, 0);
    expect(pitch).toBeTruthy();
    expect(pitch).not.toContain('undefined');
  });

  it('rotates pitches', () => {
    const p0 = getVisitPitch(TEST_FACTS, 0, 'Rahul');
    const p1 = getVisitPitch(TEST_FACTS, 1, 'Rahul');
    expect(p0).not.toBe(p1);
  });

  it('pitch is under 20 words', () => {
    for (let i = 0; i < 5; i++) {
      const pitch = getVisitPitch(TEST_FACTS, i, 'Rahul');
      const words = pitch.split(/\s+/).length;
      expect(words).toBeLessThanOrEqual(20);
    }
  });

  it('uses project name from facts', () => {
    const pitch = getVisitPitch(TEST_FACTS, 2); // Third variant uses project name
    expect(pitch).toContain('Akshay Vista');
  });
});

describe('Visit invitation gating (ConversationMemory)', () => {
  it('does not allow visit invite before threshold', () => {
    const mem = new ConversationMemory();
    mem.recordQuestion(Intent.PRICE);
    mem.recordQuestion(Intent.LOCATION);
    // Only 2 unique questions — below threshold of 3
    expect(mem.isReadyForVisitInvite()).toBe(false);
  });

  it('allows visit invite after threshold', () => {
    const mem = new ConversationMemory();
    mem.recordQuestion(Intent.PRICE);
    mem.recordQuestion(Intent.LOCATION);
    mem.recordQuestion(Intent.AMENITIES);
    // 3 unique questions — at threshold
    expect(mem.isReadyForVisitInvite()).toBe(true);
  });

  it('does not allow second visit invite', () => {
    const mem = new ConversationMemory();
    mem.recordQuestion(Intent.PRICE);
    mem.recordQuestion(Intent.LOCATION);
    mem.recordQuestion(Intent.AMENITIES);
    expect(mem.isReadyForVisitInvite()).toBe(true);

    mem.recordVisitInvite();
    expect(mem.isReadyForVisitInvite()).toBe(false);
    expect(mem.hasShownVisitInvite()).toBe(true);
  });

  it('duplicate questions do not increase score', () => {
    const mem = new ConversationMemory();
    mem.recordQuestion(Intent.PRICE);
    mem.recordQuestion(Intent.PRICE);
    mem.recordQuestion(Intent.PRICE);
    expect(mem.interestScore).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 6 — HUMANIZATION
// ═══════════════════════════════════════════════════════════════════════════

describe('Humanizer', () => {
  it('never acknowledges on first turn', () => {
    const h = new Humanizer();
    const ack = h.maybeAcknowledgeDeterministic('yes okay');
    expect(ack).toBe('');
  });

  it('acknowledges on eligible turns after cooldown', () => {
    const h = new Humanizer();
    // Turn 1 — first turn, never acks (turnCount=1)
    expect(h.maybeAcknowledgeDeterministic('my name is Rahul')).toBe('');

    // Turn 2 — eligible (turnCount=2, lastAckTurn=-10, gap=12 >= 5)
    // Info input "haan okay" matches INFO_CONFIRM_PATTERN
    const ack2 = h.maybeAcknowledgeDeterministic('haan okay');
    expect(ack2).not.toBe('');
    expect(ack2).toMatch(/^(Ji|Bilkul|Samajh gaya|Haan|Achha)\.\s$/);

    // Turns 3-6 — within cooldown (lastAckTurn=2, gap < 5)
    for (let i = 0; i < 4; i++) {
      expect(h.maybeAcknowledgeDeterministic('haan sure')).toBe('');
    }

    // Turn 7 — cooldown expired (turnCount=7, lastAckTurn=2, gap=5 >= 5)
    const ack7 = h.maybeAcknowledgeDeterministic('bilkul theek hai');
    expect(ack7).not.toBe('');
    expect(ack7).toMatch(/^(Ji|Bilkul|Samajh gaya|Haan|Achha)\.\s$/);
  });

  it('never acknowledges questions', () => {
    const h = new Humanizer();
    // Exhaust cooldown
    for (let i = 0; i < 7; i++) {
      h.maybeAcknowledgeDeterministic('haan');
    }
    const ack = h.maybeAcknowledgeDeterministic('What is the price?');
    expect(ack).toBe('');
  });

  it('respects cooldown between acknowledgements', () => {
    const h = new Humanizer();
    // Turn 1: first turn — never acks
    h.maybeAcknowledgeDeterministic('okay');

    // Turn 2: eligible (gap from -10 = 12 >= 5) — acks
    const ack1 = h.maybeAcknowledgeDeterministic('sure okay');
    expect(ack1).not.toBe('');

    // Turn 3: just ack'd, cooldown (gap=1 < 5)
    const ack2 = h.maybeAcknowledgeDeterministic('haan');
    expect(ack2).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 7 — CONVERSATION MEMORY
// ═══════════════════════════════════════════════════════════════════════════

describe('ConversationMemory', () => {
  it('tracks unique questions asked', () => {
    const mem = new ConversationMemory();
    mem.recordQuestion(Intent.PRICE);
    mem.recordQuestion(Intent.LOCATION);
    mem.recordQuestion(Intent.PRICE); // duplicate
    expect(mem.uniqueQuestionsCount).toBe(2);
  });

  it('tracks interest score correctly', () => {
    const mem = new ConversationMemory();
    mem.recordQuestion(Intent.PRICE);      // +1
    mem.recordQuestion(Intent.AMENITIES);  // +1
    mem.recordQuestion(Intent.LOCATION);   // +1
    expect(mem.interestScore).toBe(3);
  });

  it('does not award points for UNKNOWN intent', () => {
    const mem = new ConversationMemory();
    mem.recordQuestion(Intent.UNKNOWN);
    expect(mem.interestScore).toBe(0);
  });

  it('tracks objections raised', () => {
    const mem = new ConversationMemory();
    mem.recordObjection('expensive');
    mem.recordObjection('family_approval');
    expect(mem.uniqueObjectionsCount).toBe(2);
    expect(mem.hasHandledObjection('expensive')).toBe(true);
    expect(mem.hasHandledObjection('busy_now')).toBe(false);
  });

  it('detects repeated objections', () => {
    const mem = new ConversationMemory();
    expect(mem.hasHandledObjection('expensive')).toBe(false);
    mem.recordObjection('expensive');
    expect(mem.hasHandledObjection('expensive')).toBe(true);
  });

  it('tracks last answered topic for dedup', () => {
    const mem = new ConversationMemory();
    mem.recordAnswered(Intent.PRICE);
    expect(mem.isRepeatQuestion(Intent.PRICE)).toBe(true);
    expect(mem.isRepeatQuestion(Intent.LOCATION)).toBe(false);
  });

  it('tracks last intent', () => {
    const mem = new ConversationMemory();
    mem.recordQuestion(Intent.PRICE);
    expect(mem.lastIntent).toBe(Intent.PRICE);
    mem.recordQuestion(Intent.LOCATION);
    expect(mem.lastIntent).toBe(Intent.LOCATION);
  });

  it('produces a complete snapshot', () => {
    const mem = new ConversationMemory();
    mem.recordQuestion(Intent.PRICE);
    mem.recordObjection('expensive');
    mem.recordVisitInvite();

    const snap = mem.getSnapshot();
    expect(snap.questionsAsked).toContain(Intent.PRICE);
    expect(snap.objectionsRaised).toContain('expensive');
    expect(snap.visitInvitesShown).toBe(1);
    expect(snap.interestScore).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 8 — LLM REDUCTION (END-TO-END)
// ═══════════════════════════════════════════════════════════════════════════

describe('LLM reduction: end-to-end routing', () => {
  it('all property intents bypass LLM', () => {
    const { classifyIntent, isLocallyRoutable, buildLocalResponse } = require('../modules/intent');

    const queries = [
      'What is the price?',
      'Where is the project?',
      'What amenities are there?',
      'What BHK options?',
      'When is possession?',
      'Who is the developer?',
      'How many units?',
    ];

    for (const q of queries) {
      const result = classifyIntent(q);
      expect(isLocallyRoutable(result.intent)).toBe(true);
      const response = buildLocalResponse(result.intent, TEST_FACTS);
      expect(response).toBeTruthy();
    }
  });

  it('objections bypass LLM with playbooks', () => {
    const objectionQueries = [
      'bahut mehnga hai',
      'I am not interested',
      'other projects dekh raha hoon',
      'family se discuss karna hai',
      'aur details chahiye',
      'abhi busy hoon',
      'baad mein call karo',
    ];

    for (const q of objectionQueries) {
      const response = handleObjection(q, 0);
      expect(response).toBeTruthy();
    }
  });

  it('unknown queries fall through to LLM', () => {
    const { classifyIntent, isLocallyRoutable } = require('../modules/intent');

    const unknowns = [
      'Tell me about the project',
      'Can you help me?',
      'What do you think?',
    ];

    for (const q of unknowns) {
      const result = classifyIntent(q);
      expect(isLocallyRoutable(result.intent)).toBe(false);
      expect(handleObjection(q)).toBeNull();
    }
  });

  it('visit invite only triggers after interest threshold', () => {
    const mem = new ConversationMemory();

    // Ask 2 questions — below threshold
    mem.recordQuestion(Intent.PRICE);
    mem.recordQuestion(Intent.LOCATION);
    expect(mem.isReadyForVisitInvite()).toBe(false);

    // Ask 3rd question — at threshold
    mem.recordQuestion(Intent.AMENITIES);
    expect(mem.isReadyForVisitInvite()).toBe(true);

    // Show invite
    mem.recordVisitInvite();
    expect(mem.isReadyForVisitInvite()).toBe(false);

    // Even with more questions, no second invite
    mem.recordQuestion(Intent.POSSESSION);
    mem.recordQuestion(Intent.DEVELOPER);
    expect(mem.isReadyForVisitInvite()).toBe(false);
  });
});
