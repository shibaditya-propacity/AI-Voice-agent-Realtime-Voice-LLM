import { describe, it, expect } from 'vitest';
import {
  evaluateInterimBargeIn,
  computeTranscriptDelta,
  type InterimBargeInConfig,
} from './interimBargeInDecision';

const CONFIG: InterimBargeInConfig = {
  minWords: 2,
  minNewWords: 2,
  minConfidence: 0.5,
  minTtsPlayMs: 800,
  minInterimAgeMs: 1000,
  echoFillerPattern: /^(mhmm|hmm|haan|okay|ok|uh|um)(\s+(mhmm|hmm|haan|okay|ok|uh|um))*$/i,
};

// Defaults representing a healthy, confirmable barge-in; override per test.
function input(over: Partial<Parameters<typeof evaluateInterimBargeIn>[0]> = {}) {
  return evaluateInterimBargeIn({
    trimmed: 'wait stop please',
    previousText: '',
    confidence: 0.9,
    msSinceTTSStart: 1500,
    interimAnchorAge: 1200,
    config: CONFIG,
    ...over,
  });
}

describe('computeTranscriptDelta', () => {
  it('counts only genuinely new words (case-insensitive)', () => {
    const d = computeTranscriptDelta('Wait stop right there', 'wait stop');
    expect(d.wordCount).toBe(4);
    expect(d.newWords).toEqual(['right', 'there']);
    expect(d.newWordCount).toBe(2);
  });

  it('reports zero new words for a reworded duplicate', () => {
    const d = computeTranscriptDelta('stop wait', 'wait stop');
    expect(d.newWordCount).toBe(0);
  });
});

describe('evaluateInterimBargeIn — rejects false positives', () => {
  it('rejects an exact duplicate interim (echo)', () => {
    const r = input({ trimmed: 'wait stop', previousText: 'wait stop' });
    expect(r).toMatchObject({ decision: 'reject', reason: 'duplicate_interim_echo' });
  });

  it('rejects filler/echo-only words', () => {
    const r = input({ trimmed: 'haan okay' });
    expect(r).toMatchObject({ decision: 'reject', reason: 'echo_filler' });
  });

  it('rejects too-few-word interims', () => {
    const r = input({ trimmed: 'stop' });
    expect(r).toMatchObject({ decision: 'reject', reason: 'too_few_words' });
  });

  it('rejects low-confidence interims (likely TTS echo)', () => {
    const r = input({ confidence: 0.4 });
    expect(r).toMatchObject({ decision: 'reject', reason: 'low_confidence' });
  });

  it('rejects interims inside the post-TTS echo-burst window', () => {
    const r = input({ msSinceTTSStart: 300 });
    expect(r).toMatchObject({ decision: 'reject', reason: 'too_early_after_tts' });
  });

  it('rejects a reworded interim with no real growth (the core echo case)', () => {
    // Same words reordered — Deepgram refined the echo, not new speech.
    const r = input({ trimmed: 'stop wait please', previousText: 'wait stop please' });
    expect(r).toMatchObject({ decision: 'reject', reason: 'insufficient_new_words' });
  });

  it('rejects when only one new word was added', () => {
    const r = input({ trimmed: 'wait stop now', previousText: 'wait stop' });
    expect(r).toMatchObject({ decision: 'reject', reason: 'insufficient_new_words' });
  });
});

describe('evaluateInterimBargeIn — defers unconfirmed speech', () => {
  it('defers (sets anchor) on the first meaningful interim', () => {
    const r = input({ interimAnchorAge: null });
    expect(r).toMatchObject({ decision: 'defer', reason: 'anchor_set_awaiting_sustained_speech' });
  });

  it('defers while the interim is not yet sustained', () => {
    const r = input({ interimAnchorAge: 400 });
    expect(r).toMatchObject({ decision: 'defer', reason: 'interim_too_young' });
  });
});

describe('evaluateInterimBargeIn — accepts real speech', () => {
  it('accepts sustained, growing, confident new speech', () => {
    const r = input();
    expect(r).toMatchObject({ decision: 'accept', reason: 'sustained_new_speech' });
    expect(r.delta.newWordCount).toBeGreaterThanOrEqual(2);
  });

  it('treats confidence=0 (unknown) as passing the confidence gate', () => {
    const r = input({ confidence: 0 });
    expect(r.decision).toBe('accept');
  });

  it('accepts once a deferred interim becomes sustained', () => {
    // Same growing speech, now past the sustained-age threshold.
    const r = input({ interimAnchorAge: 1100 });
    expect(r.decision).toBe('accept');
  });
});
