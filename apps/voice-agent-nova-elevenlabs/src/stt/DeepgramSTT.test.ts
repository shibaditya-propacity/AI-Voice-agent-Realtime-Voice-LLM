import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock logger
vi.mock('../shared/logger', () => ({
  Logger: {
    forCall: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

// Mock env with test defaults
vi.mock('../config/env', () => ({
  Env: {
    deepgram: {
      apiKey: 'test-key',
      model: 'nova-3',
      language: 'en-IN',
      multilingual: true,
      endpointingMs: 150,
      utteranceEndMs: 1000,
      minConfidence: 0.4,
      stableInterimBaseMs: 120,
      stableInterimShortMs: 300,
      stableShortCharThreshold: 8,
      minTranscriptLength: 2,
      minSpeechDurationMs: 200,
      highConfidenceBypass: 0.85,
      confidenceShort: 0.7,
      confidenceMedium: 0.6,
      confidenceLong: 0.5,
    },
  },
}));

import { DeepgramSTT } from './DeepgramSTT';

// Access private validateTranscript via the transcript emission pathway.
// We wire onTranscript and onNoSpeech callbacks and feed Deepgram-shaped
// messages through the WS message handler to test the full validation chain.

describe('DeepgramSTT Transcript Validation', () => {
  let stt: DeepgramSTT;
  let transcripts: Array<{ text: string; confidence: number }>;
  let noSpeechCount: number;

  beforeEach(() => {
    stt = new DeepgramSTT('test-call');
    transcripts = [];
    noSpeechCount = 0;

    stt.onTranscript((text, conf) => transcripts.push({ text, confidence: conf }));
    stt.onNoSpeech(() => noSpeechCount++);
  });

  // Helper: simulate a speech_final message through the internal handler
  function sendSpeechFinal(transcript: string, confidence: number) {
    // Trigger SpeechStarted first to set speechStartedAt (200ms ago = valid duration)
    const msg = {
      type: 'SpeechStarted' as const,
      channel: [0],
      timestamp: 0,
    };
    (stt as any).handleMessage(msg);

    // Wait enough time for the speech duration gate (> 200ms)
    (stt as any).speechStartedAt = Date.now() - 300;

    const result = {
      type: 'Results' as const,
      channel: {
        alternatives: [{
          transcript,
          confidence,
          words: [],
        }],
      },
      is_final: true,
      speech_final: true,
      from_finalize: false,
      start: 0,
      duration: 0.5,
    };
    (stt as any).handleMessage(result);
  }

  // Helper: simulate a speech_final with very short speech duration
  function sendShortSpeechFinal(transcript: string, confidence: number) {
    // Set speechStartedAt to just 50ms ago (< 200ms threshold)
    (stt as any).speechStartedAt = Date.now() - 50;

    const result = {
      type: 'Results' as const,
      channel: {
        alternatives: [{
          transcript,
          confidence,
          words: [],
        }],
      },
      is_final: true,
      speech_final: true,
      from_finalize: false,
      start: 0,
      duration: 0.05,
    };
    (stt as any).handleMessage(result);
  }

  // ─── Gate 1: Empty / Short Transcripts ──────────────────────────────────

  describe('Empty/Short Transcript Rejection', () => {
    it('rejects empty transcript', () => {
      sendSpeechFinal('', 0.9);
      expect(transcripts).toHaveLength(0);
    });

    it('rejects single-character transcript', () => {
      sendSpeechFinal('a', 0.9);
      expect(transcripts).toHaveLength(0);
      expect(noSpeechCount).toBe(1);
    });

    it('rejects whitespace-only transcript', () => {
      sendSpeechFinal('   ', 0.9);
      expect(transcripts).toHaveLength(0);
    });

    it('accepts 2+ character transcript with sufficient confidence', () => {
      sendSpeechFinal('hi', 0.8);
      expect(transcripts).toHaveLength(1);
      expect(transcripts[0]!.text).toBe('hi');
    });
  });

  // ─── Gate 2: Filler / Noise Rejection ──────────────────────────────────

  describe('Filler/Noise Rejection', () => {
    const fillers = ['uh', 'umm', 'hmm', 'aa', 'huh', 'oh', 'mm', 'ah', 'ee'];
    for (const filler of fillers) {
      it(`rejects filler "${filler}"`, () => {
        sendSpeechFinal(filler, 0.9);
        expect(transcripts).toHaveLength(0);
        expect(noSpeechCount).toBe(1);
      });
    }

    it('rejects repeated fillers "uh uh uh"', () => {
      sendSpeechFinal('uh uh uh', 0.8);
      expect(transcripts).toHaveLength(0);
      expect(noSpeechCount).toBe(1);
    });

    it('rejects Hindi filler "हां"', () => {
      sendSpeechFinal('हां', 0.8);
      expect(transcripts).toHaveLength(0);
    });

    it('rejects "hmm hmm"', () => {
      sendSpeechFinal('hmm hmm', 0.9);
      expect(transcripts).toHaveLength(0);
    });

    it('accepts real speech "yes I am interested"', () => {
      sendSpeechFinal('yes I am interested', 0.8);
      expect(transcripts).toHaveLength(1);
    });

    it('accepts "haan zaroor" (Hindi affirmative + real word)', () => {
      sendSpeechFinal('haan zaroor', 0.7);
      expect(transcripts).toHaveLength(1);
    });
  });

  // ─── Gate 3: Adaptive Confidence ───────────────────────────────────────

  describe('Adaptive Confidence Thresholds', () => {
    it('rejects short transcript (2-3 chars) below 0.7 confidence', () => {
      sendSpeechFinal('ok', 0.65);
      expect(transcripts).toHaveLength(0);
      expect(noSpeechCount).toBe(1);
    });

    it('accepts short transcript (2-3 chars) at 0.7+ confidence', () => {
      sendSpeechFinal('ok', 0.75);
      expect(transcripts).toHaveLength(1);
    });

    it('rejects 1-2 word transcript below 0.6 confidence', () => {
      sendSpeechFinal('hello there', 0.55);
      expect(transcripts).toHaveLength(0);
    });

    it('accepts 1-2 word transcript at 0.6+ confidence', () => {
      sendSpeechFinal('hello there', 0.65);
      expect(transcripts).toHaveLength(1);
    });

    it('rejects 3+ word transcript below 0.5 confidence', () => {
      sendSpeechFinal('what is the price', 0.45);
      expect(transcripts).toHaveLength(0);
    });

    it('accepts 3+ word transcript at 0.5+ confidence', () => {
      sendSpeechFinal('what is the price', 0.55);
      expect(transcripts).toHaveLength(1);
    });
  });

  // ─── Gate 4: Speech Duration ───────────────────────────────────────────

  describe('Speech Duration Gate', () => {
    it('rejects sub-200ms speech with moderate confidence', () => {
      sendShortSpeechFinal('hello', 0.7);
      expect(transcripts).toHaveLength(0);
      expect(noSpeechCount).toBe(1);
    });

    it('accepts sub-200ms speech with very high confidence (>= 0.85)', () => {
      sendShortSpeechFinal('yes', 0.9);
      expect(transcripts).toHaveLength(1);
    });

    it('accepts normal-duration speech with moderate confidence', () => {
      sendSpeechFinal('hello', 0.7);
      expect(transcripts).toHaveLength(1);
    });
  });

  // ─── Integration: Multiple Gates ───────────────────────────────────────

  describe('Multi-Gate Integration', () => {
    it('background noise scenario: short, low-confidence filler is caught by multiple gates', () => {
      sendSpeechFinal('uh', 0.3);
      expect(transcripts).toHaveLength(0);
      expect(noSpeechCount).toBe(1); // only one onNoSpeech (first failing gate exits)
    });

    it('real caller speech passes all gates', () => {
      sendSpeechFinal('मेरा नाम शिवा है', 0.82);
      expect(transcripts).toHaveLength(1);
      expect(transcripts[0]!.text).toBe('मेरा नाम शिवा है');
    });

    it('breathing/fan noise: single char + low confidence rejected', () => {
      sendSpeechFinal('h', 0.3);
      expect(transcripts).toHaveLength(0);
    });

    it('PSTN line artifact: "aa" filler rejected', () => {
      sendSpeechFinal('aa', 0.6);
      expect(transcripts).toHaveLength(0);
    });

    it('echo of agent TTS: "mhmm mhmm" rejected', () => {
      sendSpeechFinal('mhmm mhmm', 0.7);
      expect(transcripts).toHaveLength(0);
    });

    it('valid short response "haan zaroor" passes', () => {
      sendSpeechFinal('haan zaroor', 0.75);
      expect(transcripts).toHaveLength(1);
    });
  });

  // ─── Callback Behavior ─────────────────────────────────────────────────

  describe('Rejected Transcript Recovery', () => {
    it('fires onNoSpeech for rejected transcripts (enables orchestrator recovery)', () => {
      sendSpeechFinal('uh', 0.9);    // filler → rejected
      sendSpeechFinal('a', 0.9);     // too short → rejected
      sendSpeechFinal('ok', 0.5);    // low confidence short → rejected
      expect(noSpeechCount).toBe(3);
      expect(transcripts).toHaveLength(0);
    });

    it('does NOT fire onNoSpeech for valid transcripts', () => {
      sendSpeechFinal('Saturday morning works', 0.8);
      expect(noSpeechCount).toBe(0);
      expect(transcripts).toHaveLength(1);
    });
  });
});
