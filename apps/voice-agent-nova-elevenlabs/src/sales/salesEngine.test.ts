import { describe, it, expect } from 'vitest';
import {
  detectObjection,
  handleObjection,
  getObjectionResponse,
  type ObjectionType,
} from './CommonObjections';
import { ConversationMemory } from './ConversationMemory';
import { getVisitPitch } from './VisitPitches';
import { Humanizer } from './Humanizer';

/**
 * Sales engine — the deterministic pieces wired into the Bedrock-Claude
 * CallOrchestrator: objection playbooks (Phase 4), interest-scored visit
 * invites (Phase 5), and humanization (Phase 6). These are pure modules with
 * no env/IO coupling, so they run standalone under vitest.
 */

describe('CommonObjections — detection', () => {
  const cases: Array<[string, ObjectionType]> = [
    ['ये तो bahut mehenga hai', 'PRICE_HIGH'],
    ['thoda discount kar do', 'PRICE_HIGH'],
    ['location bahut door hai', 'LOCATION_FAR'],
    ['builder pe bharosa nahi', 'BUILDER_TRUST'],
    ['possession late to nahi hoga', 'POSSESSION_DELAY'],
    ['resale ready possession better hai', 'RESALE_BETTER'],
    ['mujhe sochne ka time chahiye', 'NEED_TIME'],
    ['family se puch ke bataunga', 'NEED_TIME'],
    ['maine already booked kar liya', 'ALREADY_BOOKED'],
    ['doosre project se compare karna hai', 'COMPETITOR_COMPARISON'],
    ['koi hidden charge to nahi', 'HIDDEN_CHARGES'],
    ['flat thoda chhota lag raha hai', 'FLAT_SIZE_SMALL'],
  ];

  it.each(cases)('classifies %j as %s', (text, expected) => {
    expect(detectObjection(text)).toBe(expected);
  });

  it('returns null when no objection is present', () => {
    expect(detectObjection('amenities kya kya hain')).toBeNull();
    expect(detectObjection('2 bhk ka price batao')).toBeNull();
  });

  it('handleObjection returns a non-empty acknowledge-first response', () => {
    const result = handleObjection('price zyada lag raha hai');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('PRICE_HIGH');
    expect(result!.response.length).toBeGreaterThan(0);
  });

  it('every objection type has at least one response variant', () => {
    const types: ObjectionType[] = [
      'PRICE_HIGH', 'LOCATION_FAR', 'BUILDER_TRUST', 'POSSESSION_DELAY',
      'RESALE_BETTER', 'NEED_TIME', 'ALREADY_BOOKED', 'COMPETITOR_COMPARISON',
      'HIDDEN_CHARGES', 'FLAT_SIZE_SMALL',
    ];
    for (const t of types) {
      expect(getObjectionResponse(t).length).toBeGreaterThan(0);
    }
  });
});

describe('ConversationMemory — interest scoring & visit gating', () => {
  it('awards points on first occurrence only (deduped)', () => {
    const m = new ConversationMemory();
    m.recordQuestion('PRICE'); // +3
    m.recordQuestion('PRICE'); // no double count
    expect(m.interestScore).toBe(3);
  });

  it('does not suggest a visit below threshold', () => {
    const m = new ConversationMemory();
    m.recordQuestion('UNITS'); // +1
    expect(m.interestScore).toBe(1);
    expect(m.shouldSuggestVisit()).toBe(false);
  });

  it('suggests a visit once interest crosses the threshold', () => {
    const m = new ConversationMemory();
    m.recordQuestion('LOCATION');  // +2
    m.recordQuestion('AMENITIES'); // +2 → 4 ≥ 3
    expect(m.shouldSuggestVisit()).toBe(true);
  });

  it('caps visit invites at 3 (no endless re-asking)', () => {
    const m = new ConversationMemory();
    m.recordVisitInvite();
    m.recordVisitInvite();
    m.recordVisitInvite();
    expect(m.hasExhaustedVisitInvites()).toBe(true);
  });

  it('tracks raised objections', () => {
    const m = new ConversationMemory();
    m.recordObjection('PRICE_HIGH');
    expect(m.objectionsRaised.has('PRICE_HIGH')).toBe(true);
    expect(m.objectionsRaised.has('NEED_TIME')).toBe(false);
  });
});

describe('VisitPitches', () => {
  it('returns a non-empty pitch and personalizes with the caller name', () => {
    const pitch = getVisitPitch('Rahul');
    expect(pitch.length).toBeGreaterThan(0);
    expect(pitch).toContain('Rahul');
  });
});

describe('Humanizer — controlled fillers', () => {
  it('does not repeat the same filler consecutively', () => {
    const h = new Humanizer();
    let prev = '';
    for (let i = 0; i < 20; i++) {
      const f = h.getFiller();
      expect(f.length).toBeGreaterThan(0);
      expect(f).not.toBe(prev);
      prev = f;
    }
  });
});
