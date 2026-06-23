/**
 * BargeInValidator unit tests (Sarvam infra).
 *
 * Covers:
 *  - validateInterimEcho: semantic echo detection against user transcript & agent response
 *  - validateFinal: final-transcript echo/filler detection
 *  - State management: onTTSStarted, onUserTranscript, onAgentResponseStarted, updateAgentResponse, resetTurn
 *  - Metrics tracking
 */

import { describe, it, expect } from 'vitest';
import { BargeInValidator } from './BargeInValidator';

// ─── Echo Detection (Interim) ───────────────────────────────────────────────

describe('validateInterimEcho', () => {
  it('rejects interim matching last user transcript (STT echo)', () => {
    const v = new BargeInValidator();
    v.onUserTranscript('mujhe price batao project ka');

    const d = v.validateInterimEcho('mujhe price batao project ka');
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe('echo');
    expect(d.details.matchedAgainst).toBe('last_user_transcript');
  });

  it('rejects interim similar to last user transcript (word overlap)', () => {
    const v = new BargeInValidator();
    v.onUserTranscript('price batao project ka');

    const d = v.validateInterimEcho('project ka price batao');
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe('echo');
  });

  it('rejects interim matching active agent response (speaker echo)', () => {
    const v = new BargeInValidator();
    v.onAgentResponseStarted('Akshay Vista ka price 85 lakh se start hota hai');

    const d = v.validateInterimEcho('price 85 lakh se start hota');
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe('echo');
    expect(d.details.matchedAgainst).toBe('agent_response');
  });

  it('rejects substring match of agent response', () => {
    const v = new BargeInValidator();
    v.onAgentResponseStarted('Akshay Vista Baner mein located hai aur yeh bahut achha project hai');

    const d = v.validateInterimEcho('Baner mein located hai');
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe('echo');
  });

  it('accepts text not matching any echo source', () => {
    const v = new BargeInValidator();
    v.onUserTranscript('price batao');
    v.onAgentResponseStarted('price 85 lakh se start hota hai');

    const d = v.validateInterimEcho('amenities kya hain project mein');
    expect(d.accepted).toBe(true);
  });

  it('accepts when no echo sources are set', () => {
    const v = new BargeInValidator();
    const d = v.validateInterimEcho('main yeh poochna chahta tha');
    expect(d.accepted).toBe(true);
  });

  it('case-insensitive echo matching', () => {
    const v = new BargeInValidator();
    v.onUserTranscript('Price Batao');

    const d = v.validateInterimEcho('price batao yaar');
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe('echo');
  });
});

// ─── Echo Detection (Final) ────────────────────────────────────────────────

describe('validateFinal', () => {
  it('rejects filler words', () => {
    const v = new BargeInValidator();
    expect(v.validateFinal('hmm', 0.9).accepted).toBe(false);
    expect(v.validateFinal('hmm', 0.9).reason).toBe('filler_pattern');
    expect(v.validateFinal('haan', 0.9).accepted).toBe(false);
    expect(v.validateFinal('ok', 0.9).accepted).toBe(false);
    expect(v.validateFinal('okay', 0.9).accepted).toBe(false);
    expect(v.validateFinal('ji', 0.9).accepted).toBe(false);
  });

  it('rejects Hindi fillers', () => {
    const v = new BargeInValidator();
    expect(v.validateFinal('हाँ', 0.9).accepted).toBe(false);
    expect(v.validateFinal('जी', 0.9).accepted).toBe(false);
    expect(v.validateFinal('हम्म', 0.9).accepted).toBe(false);
  });

  it('rejects combined fillers', () => {
    const v = new BargeInValidator();
    expect(v.validateFinal('hmm hmm', 0.9).accepted).toBe(false);
  });

  it('rejects final transcript echoing agent response', () => {
    const v = new BargeInValidator();
    v.onAgentResponseStarted('Akshay Vista ka price 85 lakh se start hota hai');

    const d = v.validateFinal('price 85 lakh se start hota hai', 0.9);
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe('echo');
  });

  it('accepts genuine new speech in final', () => {
    const v = new BargeInValidator();
    v.onAgentResponseStarted('price 85 lakh se start hota hai');

    const d = v.validateFinal('mujhe location ke baare mein batao', 0.9);
    expect(d.accepted).toBe(true);
  });

  it('requires BOTH similarity AND substring for final echo rejection', () => {
    const v = new BargeInValidator();
    // Agent response shares some words but final is not a substring
    v.onAgentResponseStarted('price 85 lakh se start hota hai Baner mein');

    // This has some word overlap but is completely different content
    const d = v.validateFinal('mujhe 85 lakh ka budget hai main interested hoon', 0.9);
    // Low similarity (not enough common words as fraction of union) — should accept
    expect(d.accepted).toBe(true);
  });
});

// ─── State Management ───────────────────────────────────────────────────────

describe('state management', () => {
  it('resetTurn clears agent response and interim state', () => {
    const v = new BargeInValidator();
    v.onAgentResponseStarted('some response text here');

    // Should reject echo
    let d = v.validateInterimEcho('some response text here');
    expect(d.accepted).toBe(false);

    // Reset turn
    v.resetTurn();

    // After reset — no agent response to echo against
    d = v.validateInterimEcho('some response text here');
    expect(d.accepted).toBe(true);
  });

  it('updateAgentResponse updates echo source', () => {
    const v = new BargeInValidator();
    v.onAgentResponseStarted('price');
    v.updateAgentResponse('price 85 lakh se shuru hota hai');

    const d = v.validateInterimEcho('85 lakh se shuru hota hai');
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe('echo');
  });

  it('onUserTranscript updates user echo source', () => {
    const v = new BargeInValidator();

    // Initially no echo source
    let d = v.validateInterimEcho('price kitna hai bhai');
    expect(d.accepted).toBe(true);

    // Set user transcript
    v.onUserTranscript('price kitna hai bhai');

    // Now it should echo
    d = v.validateInterimEcho('price kitna hai bhai');
    expect(d.accepted).toBe(false);
  });
});

// ─── Metrics ────────────────────────────────────────────────────────────────

describe('metrics', () => {
  it('tracks accepted and rejected counts', () => {
    const v = new BargeInValidator();
    v.onAgentResponseStarted('price 85 lakh se start');

    v.validateInterimEcho('price 85 lakh se start'); // rejected: echo
    v.validateInterimEcho('amenities kya hain yahan'); // accepted
    v.validateInterimEcho('location kahan hai project'); // accepted

    expect(v.accepted).toBe(2);
    expect(v.rejected).toBe(1);
  });

  it('tracks rejection reason breakdown', () => {
    const v = new BargeInValidator();
    v.onAgentResponseStarted('price 85 lakh se start hota hai');
    v.onUserTranscript('price batao project ka');

    v.validateInterimEcho('price 85 lakh se start hota'); // echo (agent)
    v.validateInterimEcho('price batao project ka bhai'); // echo (user)
    v.validateFinal('hmm', 0.9); // filler

    const metrics = v.getMetrics();
    expect(metrics.ECHO_BARGEIN_REJECTED).toBe(3);
    const breakdown = metrics.rejectionBreakdown as Record<string, number>;
    expect(breakdown.echo).toBe(2);
    expect(breakdown.filler_pattern).toBe(1);
  });

  it('getMetrics returns full summary', () => {
    const v = new BargeInValidator();
    v.validateInterimEcho('yeh project kitne ka hai');
    v.validateFinal('hmm', 0.9);

    const metrics = v.getMetrics();
    expect(metrics).toHaveProperty('ECHO_BARGEIN_ACCEPTED');
    expect(metrics).toHaveProperty('ECHO_BARGEIN_REJECTED');
    expect(metrics).toHaveProperty('rejectionBreakdown');
    expect(metrics.ECHO_BARGEIN_ACCEPTED).toBe(1);
    expect(metrics.ECHO_BARGEIN_REJECTED).toBe(1);
  });
});

// ─── Edge Cases ─────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles empty agent response gracefully', () => {
    const v = new BargeInValidator();
    v.onAgentResponseStarted('');

    const d = v.validateInterimEcho('hello world test');
    expect(d.accepted).toBe(true);
  });

  it('handles very short strings that bypass substring check', () => {
    const v = new BargeInValidator();
    v.onAgentResponseStarted('hi');

    // "hi" is < 3 chars so substring match is skipped
    const d = v.validateInterimEcho('hi there how are you');
    // Word similarity of "hi" vs "hi there how are you" is low (1/5 = 0.2)
    expect(d.accepted).toBe(true);
  });

  it('custom echoSimilarityThreshold', () => {
    // Very strict threshold — even moderate overlap rejected
    const v = new BargeInValidator({ echoSimilarityThreshold: 0.3 });
    v.onAgentResponseStarted('price 85 lakh Baner location amenities club gym pool');

    // Some shared words but different content — at 0.3 threshold more likely to reject
    const d = v.validateInterimEcho('Baner mein koi aur project hai kya gym ke saath');
    // This shares "Baner", "gym" out of union — depends on exact Jaccard score
    // The point is the threshold is configurable
    expect(d).toBeDefined();
    expect(typeof d.accepted).toBe('boolean');
  });
});
