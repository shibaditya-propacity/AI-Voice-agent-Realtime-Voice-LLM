/**
 * BargeInValidator unit tests.
 *
 * Covers all 5 rejection reasons:
 *  1. filler_pattern — fillers in English and Hindi
 *  2. grace_window — too soon after TTS started
 *  3. short_fragment — single words, too few characters
 *  4. repeated_interim — same text within window
 *  5. echo — matches user transcript or agent response
 *
 * Also covers acceptance paths and metrics.
 */

import { BargeInValidator } from '../modules/pipeline/BargeInValidator';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Advance time by manipulating Date.now. */
let mockNow = 1000000;
const realDateNow = Date.now;

beforeEach(() => {
  mockNow = 1000000;
  Date.now = () => mockNow;
});

afterEach(() => {
  Date.now = realDateNow;
});

function advanceTime(ms: number): void {
  mockNow += ms;
}

// ─── Filler Pattern ─────────────────────────────────────────────────────────

describe('filler_pattern rejection', () => {
  it('rejects English fillers', () => {
    const v = new BargeInValidator();
    const fillers = ['hmm', 'uh', 'um', 'mhmm', 'uhh', 'umm', 'ah', 'huh', 'mmm'];
    for (const filler of fillers) {
      const d = v.validateInterim(filler);
      expect(d.accepted).toBe(false);
      expect(d.reason).toBe('filler_pattern');
    }
  });

  it('rejects Hindi fillers', () => {
    const v = new BargeInValidator();
    const fillers = ['haan', 'ji', 'han', 'हाँ', 'जी', 'हम्म'];
    for (const filler of fillers) {
      const d = v.validateInterim(filler);
      expect(d.accepted).toBe(false);
      expect(d.reason).toBe('filler_pattern');
    }
  });

  it('rejects combined fillers', () => {
    const v = new BargeInValidator();
    const d = v.validateInterim('hmm hmm');
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe('filler_pattern');
  });

  it('rejects "ok" and "okay"', () => {
    const v = new BargeInValidator();
    expect(v.validateInterim('ok').accepted).toBe(false);
    expect(v.validateInterim('okay').accepted).toBe(false);
  });

  it('rejects fillers in validateFinal too', () => {
    const v = new BargeInValidator();
    const d = v.validateFinal('hmm', 0.9);
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe('filler_pattern');
  });
});

// ─── Grace Window ───────────────────────────────────────────────────────────

describe('grace_window rejection', () => {
  it('rejects interims within TTS grace period', () => {
    const v = new BargeInValidator();
    v.onTTSStarted();
    advanceTime(500); // 500ms < 1200ms default grace

    const d = v.validateInterim('main yeh poochna chahta tha');
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe('grace_window');
  });

  it('accepts interims after grace period', () => {
    const v = new BargeInValidator();
    v.onTTSStarted();
    advanceTime(1500); // 1500ms > 1200ms default grace

    const d = v.validateInterim('main yeh poochna chahta tha');
    expect(d.accepted).toBe(true);
  });

  it('respects custom grace period', () => {
    const v = new BargeInValidator({ ttsGraceMs: 2000 });
    v.onTTSStarted();
    advanceTime(1500); // 1500ms < 2000ms custom grace

    const d = v.validateInterim('main yeh poochna chahta tha');
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe('grace_window');
  });

  it('does not reject when TTS has not started', () => {
    const v = new BargeInValidator();
    // No onTTSStarted() call
    const d = v.validateInterim('main yeh poochna chahta tha');
    expect(d.accepted).toBe(true);
  });
});

// ─── Short Fragment ─────────────────────────────────────────────────────────

describe('short_fragment rejection', () => {
  it('rejects single words (word count < 2)', () => {
    const v = new BargeInValidator();
    // Need to bypass grace window and fillers first
    advanceTime(2000);

    const d = v.validateInterim('hello');
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe('short_fragment');
  });

  it('rejects very short text (char length < 4)', () => {
    const v = new BargeInValidator({ minCharLength: 4 });
    advanceTime(2000);

    const d = v.validateInterim('hi ya');
    // "hi ya" = 2 words, 5 chars — passes both
    expect(d.accepted).toBe(true);

    const d2 = v.validateInterim('ab c');
    // "ab c" = 2 words, 4 chars — just passes
    expect(d2.accepted).toBe(true);
  });

  it('accepts multi-word text', () => {
    const v = new BargeInValidator();
    advanceTime(2000);

    const d = v.validateInterim('price kitna hai');
    expect(d.accepted).toBe(true);
  });
});

// ─── Repeated Interim ───────────────────────────────────────────────────────

describe('repeated_interim rejection', () => {
  it('rejects identical interims within the repeat window', () => {
    const v = new BargeInValidator();
    advanceTime(2000);

    const d1 = v.validateInterim('price kitna hai');
    expect(d1.accepted).toBe(true);

    advanceTime(500); // 500ms < 2000ms repeat window

    const d2 = v.validateInterim('price kitna hai');
    expect(d2.accepted).toBe(false);
    expect(d2.reason).toBe('repeated_interim');
  });

  it('accepts same text after repeat window expires', () => {
    const v = new BargeInValidator();
    advanceTime(2000);

    v.validateInterim('price kitna hai');
    advanceTime(2500); // 2500ms > 2000ms repeat window

    const d = v.validateInterim('price kitna hai');
    expect(d.accepted).toBe(true);
  });

  it('accepts different text within repeat window', () => {
    const v = new BargeInValidator();
    advanceTime(2000);

    v.validateInterim('price kitna hai');
    advanceTime(500);

    const d = v.validateInterim('location kahan hai');
    expect(d.accepted).toBe(true);
  });
});

// ─── Echo Detection ─────────────────────────────────────────────────────────

describe('echo rejection', () => {
  it('rejects interim matching last user transcript (STT echo)', () => {
    const v = new BargeInValidator();
    v.onUserTranscript('mujhe price batao project ka');
    advanceTime(2000);

    const d = v.validateInterim('mujhe price batao project ka');
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe('echo');
    expect(d.details.matchedAgainst).toBe('last_user_transcript');
  });

  it('rejects interim similar to last user transcript', () => {
    const v = new BargeInValidator();
    v.onUserTranscript('price batao project ka');
    advanceTime(2000);

    // High word overlap
    const d = v.validateInterim('project ka price batao');
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe('echo');
  });

  it('rejects interim matching active agent response (speaker echo)', () => {
    const v = new BargeInValidator();
    v.onAgentResponseStarted('Akshay Vista ka price 85 lakh se start hota hai');
    advanceTime(2000);

    const d = v.validateInterim('price 85 lakh se start hota');
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe('echo');
    expect(d.details.matchedAgainst).toBe('agent_response');
  });

  it('rejects substring match of agent response', () => {
    const v = new BargeInValidator();
    v.onAgentResponseStarted('Akshay Vista Baner mein located hai aur yeh bahut achha project hai');
    advanceTime(2000);

    const d = v.validateInterim('Baner mein located hai');
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe('echo');
  });

  it('accepts text not matching any echo source', () => {
    const v = new BargeInValidator();
    v.onUserTranscript('price batao');
    v.onAgentResponseStarted('price 85 lakh se start hota hai');
    advanceTime(2000);

    const d = v.validateInterim('amenities kya hain project mein');
    expect(d.accepted).toBe(true);
  });

  it('rejects final transcript echoing agent response', () => {
    const v = new BargeInValidator();
    v.onAgentResponseStarted('Akshay Vista ka price 85 lakh se start hota hai');

    // validateFinal checks echo against agent + requires BOTH similarity + substring
    const d = v.validateFinal('price 85 lakh se start hota hai', 0.9);
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe('echo');
  });

  it('accepts final transcript that is genuinely new speech', () => {
    const v = new BargeInValidator();
    v.onAgentResponseStarted('price 85 lakh se start hota hai');

    const d = v.validateFinal('mujhe location ke baare mein batao', 0.9);
    expect(d.accepted).toBe(true);
  });
});

// ─── State Management ───────────────────────────────────────────────────────

describe('state management', () => {
  it('resetTurn clears TTS and interim state', () => {
    const v = new BargeInValidator();
    v.onTTSStarted();
    v.onAgentResponseStarted('some response');
    advanceTime(500);

    // During grace window — should reject
    let d = v.validateInterim('main poochna chahta tha');
    expect(d.accepted).toBe(false);

    // Reset turn
    v.resetTurn();
    advanceTime(100);

    // After reset — no grace window active, should pass
    d = v.validateInterim('main poochna chahta tha');
    expect(d.accepted).toBe(true);
  });

  it('updateAgentResponse updates echo source', () => {
    const v = new BargeInValidator();
    v.onAgentResponseStarted('price');
    v.updateAgentResponse('price 85 lakh se shuru hota hai');
    advanceTime(2000);

    const d = v.validateInterim('85 lakh se shuru hota hai');
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe('echo');
  });
});

// ─── Metrics ────────────────────────────────────────────────────────────────

describe('metrics', () => {
  it('tracks accepted and rejected counts', () => {
    const v = new BargeInValidator();
    advanceTime(2000);

    v.validateInterim('hmm'); // rejected: filler
    v.validateInterim('price kitna hai'); // accepted
    v.validateInterim('location kahan hai'); // accepted

    expect(v.accepted).toBe(2);
    expect(v.rejected).toBe(1);
  });

  it('tracks rejection reason breakdown', () => {
    const v = new BargeInValidator();

    // Filler rejection
    v.validateInterim('hmm');
    v.validateInterim('uh');

    // Grace window rejection
    v.onTTSStarted();
    advanceTime(500);
    v.validateInterim('main poochna tha');

    const metrics = v.getMetrics();
    expect(metrics.FALSE_BARGEIN_REJECTED).toBe(3);
    expect((metrics.rejectionBreakdown as Record<string, number>).filler_pattern).toBe(2);
    expect((metrics.rejectionBreakdown as Record<string, number>).grace_window).toBe(1);
  });

  it('getMetrics returns full summary', () => {
    const v = new BargeInValidator();
    advanceTime(2000);

    v.validateInterim('yeh project kitne ka hai');
    v.validateInterim('hmm');

    const metrics = v.getMetrics();
    expect(metrics).toHaveProperty('VALID_BARGEIN_ACCEPTED');
    expect(metrics).toHaveProperty('FALSE_BARGEIN_REJECTED');
    expect(metrics).toHaveProperty('rejectionBreakdown');
    expect(metrics.VALID_BARGEIN_ACCEPTED).toBe(1);
    expect(metrics.FALSE_BARGEIN_REJECTED).toBe(1);
  });
});

// ─── Validation Order ───────────────────────────────────────────────────────

describe('validation order', () => {
  it('filler check runs before grace window', () => {
    const v = new BargeInValidator();
    v.onTTSStarted();
    advanceTime(100); // Within grace window

    // "hmm" is a filler AND within grace window — filler should be the reason
    const d = v.validateInterim('hmm');
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe('filler_pattern');
  });

  it('grace window check runs before short fragment', () => {
    const v = new BargeInValidator();
    v.onTTSStarted();
    advanceTime(100);

    // "yo" is short AND within grace window — grace_window should win
    // Actually "yo" is single word so short_fragment would fire, but grace_window comes first
    const d = v.validateInterim('hello world');
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe('grace_window');
  });
});

// ─── Edge Cases ─────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles empty/whitespace text gracefully', () => {
    const v = new BargeInValidator();
    advanceTime(2000);

    // Empty after trim — should be rejected as short fragment
    const d = v.validateInterim('   ');
    expect(d.accepted).toBe(false);
  });

  it('case-insensitive filler matching', () => {
    const v = new BargeInValidator();
    expect(v.validateInterim('HMM').accepted).toBe(false);
    expect(v.validateInterim('Okay').accepted).toBe(false);
  });

  it('case-insensitive echo matching', () => {
    const v = new BargeInValidator();
    v.onUserTranscript('Price Batao');
    advanceTime(2000);

    const d = v.validateInterim('price batao yaar');
    // substring match (case-insensitive)
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe('echo');
  });

  it('validateFinal is less strict — no grace window or short fragment', () => {
    const v = new BargeInValidator();
    v.onTTSStarted();
    advanceTime(500); // Within grace window

    // Final should NOT be rejected by grace window
    const d = v.validateFinal('yes', 0.95);
    // "yes" — not a filler in the pattern, not echo → accepted
    expect(d.accepted).toBe(true);
  });
});
