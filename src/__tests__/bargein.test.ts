/**
 * Barge-in and interruption handling tests.
 *
 * These tests verify the exact scenarios described in the bug report:
 *
 *  1. Audio overlap — agent continues speaking after caller starts speaking
 *  2. In-flight response not cancelled on barge-in
 *  3. Stale chunks from cancelled responses replayed to caller
 *  4. Duplicate Twilio sequence numbers processed twice
 *  5. Old partial transcripts reused
 *  6. Conversation state inconsistency after interruption
 *
 * Each test uses lightweight EventEmitter-based mocks that simulate the Nova
 * event stream without requiring AWS credentials or real network I/O.
 */

import { EventEmitter } from 'events';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a PCM16 buffer with a given RMS energy level (for VAD simulation). */
function makePcm16(samples: number, amplitude: number): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(amplitude, i * 2);
  }
  return buf;
}

/** Silent PCM16 buffer (RMS ≈ 0) */
const SILENT_PCM = makePcm16(320, 0);

/** Loud PCM16 buffer (RMS well above vadRmsThreshold=500) */
const LOUD_PCM = makePcm16(320, 8000);

// ─── Mock Nova Client ─────────────────────────────────────────────────────────
// Simulates the Nova event stream locally without AWS.

class MockNovaClient extends EventEmitter {
  isOpen = true;
  closed = false;
  readonly connect = jest.fn().mockResolvedValue(undefined);

  // Simulate Nova completing a response turn: fires the full output event sequence.
  simulateResponse(contentId = 'content-A', completionId = 'completion-1'): void {
    this.emit('completion-start', completionId, 'prompt-1');
    this.emit('content-start', contentId, 'AUDIO');
    // Two audio chunks
    this.emit('audio-output', Buffer.from('chunk1'), contentId, completionId);
    this.emit('audio-output', Buffer.from('chunk2'), contentId, completionId);
    this.emit('content-end', contentId, 'END_TURN');
    this.emit('turn-complete', 'END_TURN');
  }

  // Simulate barge-in: Nova sends a new completionStart while old audio is still streaming.
  simulateBargeIn(
    oldContentId = 'content-A',
    newContentId = 'content-B',
    oldCompletionId = 'completion-1',
    newCompletionId = 'completion-2',
  ): void {
    // Old response starts
    this.emit('completion-start', oldCompletionId, 'prompt-1');
    this.emit('content-start', oldContentId, 'AUDIO');
    this.emit('audio-output', Buffer.from('old-chunk-1'), oldContentId, oldCompletionId);
    this.emit('audio-output', Buffer.from('old-chunk-2'), oldContentId, oldCompletionId);

    // Nova detects caller speech — new completionStart interrupts the old one
    this.emit('completion-start', newCompletionId, 'prompt-1');

    // Old chunks that still dribble in AFTER the new completionStart (the overlap bug)
    this.emit('audio-output', Buffer.from('stale-chunk-1'), oldContentId, oldCompletionId);
    this.emit('audio-output', Buffer.from('stale-chunk-2'), oldContentId, oldCompletionId);

    // New response content
    this.emit('content-start', newContentId, 'AUDIO');
    this.emit('audio-output', Buffer.from('new-chunk-1'), newContentId, newCompletionId);
    this.emit('content-end', newContentId, 'END_TURN');
    this.emit('turn-complete', 'END_TURN');
  }

  close(): void { this.closed = true; this.isOpen = false; }
  startPrompt(): string { return 'prompt-1'; }
  openAudioBlock(): void {}
  sendUserTextBlock(): void {}
  sendAudio(): void {}
  closeAudioBlock(): void {}
  sendPromptEnd(): void {}
  initialize(): void {}
}

// ─── Mock NovaAudioStreamer ───────────────────────────────────────────────────

class MockNovaAudioStreamer {
  listening = false;
  bufferCleared = false;
  conversationOpen = true;
  readonly promptName = 'prompt-1';

  startListening(_reason: string): void { this.listening = true; }
  handleInterruption(): void { this.bufferCleared = true; }
  pushAudio(_pcm: Buffer): void {}
  startConversation(): void {}
  finishConversation(): void { this.conversationOpen = false; }
  get isConversationOpen(): boolean { return this.conversationOpen; }
}

// ─── Inline NovaSessionManager logic under test ───────────────────────────────
// Rather than importing the real NovaSessionManager (which requires live Env,
// AWS SDK, Bedrock client, etc.), we replicate only the state-machine logic
// that was changed. This lets us test the exact guard conditions in isolation.

import { ConversationState } from '../modules/nova/NovaTypes';

interface TestContext {
  conversationState: ConversationState;
  activeContentId: string;
  cancelledContentIds: Set<string>;
  lastBargeInAt: number;
  outputBytesRouted: number;
  interruptionCalled: number;
  responseGeneration: number;
  activeResponseGeneration: number;
  contentIdToGeneration: Map<string, number>;
  currentAssistantTranscript: string;
  currentUserTranscript: string;
  /** Finalized transcript entries — simulates SessionManager.addTranscriptEntry(). */
  finalizedTranscripts: Array<{ role: string; text: string; isFinal: boolean }>;
}

/**
 * Build the event handlers in the same way NovaSessionManager.wireClientEvents()
 * does. Returns the context and a cleanup function so we can simulate Nova events.
 */
function buildHandlers(client: MockNovaClient) {
  const ctx: TestContext = {
    conversationState: 'LISTENING',
    activeContentId: '',
    cancelledContentIds: new Set(),
    lastBargeInAt: 0,
    outputBytesRouted: 0,
    interruptionCalled: 0,
    responseGeneration: 0,
    activeResponseGeneration: 0,
    contentIdToGeneration: new Map(),
    currentAssistantTranscript: '',
    currentUserTranscript: '',
    finalizedTranscripts: [],
  };

  const routedChunks: Buffer[] = [];
  const onAudioOutput = jest.fn((chunk: Buffer): void => {
    ctx.outputBytesRouted += chunk.length;
    routedChunks.push(chunk);
  });
  const onInterruption = jest.fn((): void => {
    ctx.interruptionCalled++;
  });

  function transitionState(next: ConversationState): void {
    ctx.conversationState = next;
  }

  // ── completion-start ──
  const handleCompletionStart = (completionId: string): void => {
    ctx.responseGeneration++;
    if (ctx.conversationState === 'AI_SPEAKING' && ctx.activeContentId) {
      const now = Date.now();
      if (now - ctx.lastBargeInAt > 1_000) {
        ctx.lastBargeInAt = now;
        ctx.cancelledContentIds.add(ctx.activeContentId);
        ctx.activeContentId = '';
        transitionState('INTERRUPTED');
        onInterruption();
      }
    }
    // Discard partial transcripts from the interrupted response
    ctx.currentAssistantTranscript = '';
    ctx.currentUserTranscript = '';
    transitionState('AI_THINKING');
    ctx.outputBytesRouted = 0;
  };

  // ── content-start ──
  const handleContentStart = (contentId: string, type: string): void => {
    // Record generation for EVERY content block (AUDIO or TEXT)
    ctx.contentIdToGeneration.set(contentId, ctx.responseGeneration);

    if (type === 'AUDIO') {
      ctx.activeContentId = contentId;
      ctx.activeResponseGeneration = ctx.responseGeneration;
      ctx.currentAssistantTranscript = '';
      transitionState('AI_SPEAKING');
    }
  };

  // ── audio-output ──
  const handleAudioOutput = (chunk: Buffer, contentId: string): void => {
    if (ctx.cancelledContentIds.has(contentId)) return; // stale — discard
    if (ctx.conversationState === 'INTERRUPTED') return;  // proactive barge-in gap
    onAudioOutput(chunk);
  };

  // ── text-output ──
  const handleTextOutput = (text: string, contentId: string, role: string): void => {
    // Stale generation filter
    const gen = ctx.contentIdToGeneration.get(contentId);
    if (gen !== undefined && gen < ctx.responseGeneration) return;
    if (ctx.conversationState === 'INTERRUPTED') return;

    if (role === 'USER') {
      ctx.currentUserTranscript += text;
    } else {
      ctx.currentAssistantTranscript += text;
    }
  };

  // ── content-end ──
  const handleContentEnd = (contentId: string): void => {
    // Stale generation filter
    const gen = ctx.contentIdToGeneration.get(contentId);
    if (gen !== undefined && gen < ctx.responseGeneration) {
      ctx.contentIdToGeneration.delete(contentId);
      return;
    }
    if (ctx.conversationState === 'INTERRUPTED') {
      ctx.contentIdToGeneration.delete(contentId);
      return;
    }

    ctx.contentIdToGeneration.delete(contentId);

    if (ctx.currentUserTranscript) {
      ctx.finalizedTranscripts.push({ role: 'user', text: ctx.currentUserTranscript, isFinal: true });
      ctx.currentUserTranscript = '';
    }
    if (ctx.currentAssistantTranscript) {
      ctx.finalizedTranscripts.push({ role: 'assistant', text: ctx.currentAssistantTranscript, isFinal: true });
      ctx.currentAssistantTranscript = '';
    }
  };

  // ── turn-complete ──
  const handleTurnComplete = (): void => {
    const isCurrentResponse = ctx.responseGeneration === ctx.activeResponseGeneration;
    ctx.cancelledContentIds.clear();
    ctx.contentIdToGeneration.clear();
    ctx.activeContentId = '';
    if (isCurrentResponse) {
      transitionState('LISTENING');
    }
    // else: stale turn-complete from interrupted old response — leave state alone
  };

  client.on('completion-start', handleCompletionStart);
  client.on('content-start', handleContentStart);
  client.on('audio-output', handleAudioOutput);
  client.on('text-output', handleTextOutput);
  client.on('content-end', handleContentEnd);
  client.on('turn-complete', handleTurnComplete);

  return { ctx, routedChunks, onAudioOutput, onInterruption };
}

// ─── AudioRouter sequence dedup logic under test ──────────────────────────────

class MockAudioRouterDedup {
  private readonly lastSeqNums = new Map<string, number>();

  /** Returns true if the frame should be processed; false if it is a duplicate. */
  shouldProcess(sessionId: string, seqNum: number): boolean {
    if (seqNum <= 0) return true; // seqNum=0 means no sequence tracking
    const last = this.lastSeqNums.get(sessionId) ?? 0;
    if (seqNum <= last) return false; // duplicate
    this.lastSeqNums.set(sessionId, seqNum);
    return true;
  }

  cleanup(sessionId: string): void {
    this.lastSeqNums.delete(sessionId);
  }
}

// ─── AudioRouter proactive barge-in logic under test ─────────────────────────

class MockAudioRouterBargeIn {
  private readonly lastBargeInAt = new Map<string, number>();
  readonly VAD_THRESHOLD = 500;
  readonly COOLDOWN_MS = 2_000;

  bargeInCount = 0;

  /** Returns true if barge-in should be triggered for this frame. */
  checkBargeIn(sessionId: string, pcm16: Buffer, agentSpeaking: boolean): boolean {
    if (!agentSpeaking) return false;
    const rms = this.computeRms(pcm16);
    if (rms < this.VAD_THRESHOLD) return false;
    const now = Date.now();
    const last = this.lastBargeInAt.get(sessionId) ?? 0;
    if (now - last < this.COOLDOWN_MS) return false;
    this.lastBargeInAt.set(sessionId, now);
    this.bargeInCount++;
    return true;
  }

  private computeRms(pcm16: Buffer): number {
    const samples = pcm16.length >> 1;
    if (samples === 0) return 0;
    let sumSq = 0;
    for (let i = 0; i < samples; i++) {
      const s = pcm16.readInt16LE(i * 2);
      sumSq += s * s;
    }
    return Math.sqrt(sumSq / samples);
  }

  cleanup(sessionId: string): void {
    this.lastBargeInAt.delete(sessionId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe('Barge-in: conversation state machine', () => {
  test('Normal flow: LISTENING → AI_THINKING → AI_SPEAKING → LISTENING', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    expect(ctx.conversationState).toBe('LISTENING');

    client.simulateResponse('content-A', 'completion-1');

    expect(ctx.conversationState).toBe('LISTENING');
  });

  test('All audio chunks from a normal response reach the caller', () => {
    const client = new MockNovaClient();
    const { routedChunks } = buildHandlers(client);

    client.simulateResponse('content-A', 'completion-1');

    // 2 chunks emitted → 2 chunks routed
    expect(routedChunks).toHaveLength(2);
    expect(routedChunks[0].toString()).toBe('chunk1');
    expect(routedChunks[1].toString()).toBe('chunk2');
  });

  test('BARGE-IN: stale chunks from interrupted response are discarded', () => {
    const client = new MockNovaClient();
    const { routedChunks, onInterruption } = buildHandlers(client);

    client.simulateBargeIn('content-A', 'content-B', 'completion-1', 'completion-2');

    // 2 old chunks BEFORE barge-in should reach the caller
    // 2 stale chunks AFTER barge-in should be DISCARDED
    // 1 new chunk from the new response should reach the caller
    const routedStrings = routedChunks.map((b) => b.toString());
    expect(routedStrings).toContain('old-chunk-1');
    expect(routedStrings).toContain('old-chunk-2');
    expect(routedStrings).not.toContain('stale-chunk-1');  // BUG FIXED
    expect(routedStrings).not.toContain('stale-chunk-2');  // BUG FIXED
    expect(routedStrings).toContain('new-chunk-1');

    // onInterruption must have been called exactly once
    expect(onInterruption).toHaveBeenCalledTimes(1);
  });

  test('BARGE-IN: state transitions correctly through INTERRUPTED → AI_THINKING → AI_SPEAKING → LISTENING', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    const states: ConversationState[] = [];
    // Manually simulate the event sequence to capture intermediate states
    client.emit('completion-start', 'completion-1', 'prompt-1');
    states.push(ctx.conversationState); // should be AI_THINKING

    client.emit('content-start', 'content-A', 'AUDIO');
    states.push(ctx.conversationState); // should be AI_SPEAKING

    client.emit('audio-output', Buffer.from('chunk'), 'content-A', 'completion-1');
    // State still AI_SPEAKING

    // Barge-in: new completionStart fires while AI_SPEAKING
    client.emit('completion-start', 'completion-2', 'prompt-1');
    states.push(ctx.conversationState); // should be AI_THINKING (after INTERRUPTED → AI_THINKING)

    client.emit('content-start', 'content-B', 'AUDIO');
    states.push(ctx.conversationState); // should be AI_SPEAKING

    client.emit('turn-complete', 'END_TURN');
    states.push(ctx.conversationState); // should be LISTENING

    expect(states).toEqual(['AI_THINKING', 'AI_SPEAKING', 'AI_THINKING', 'AI_SPEAKING', 'LISTENING']);
  });

  test('BARGE-IN: activeContentId of old response is added to cancelledContentIds', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    // Get AI to SPEAKING state
    client.emit('completion-start', 'completion-1', 'prompt-1');
    client.emit('content-start', 'content-A', 'AUDIO');
    expect(ctx.activeContentId).toBe('content-A');
    expect(ctx.conversationState).toBe('AI_SPEAKING');

    // Barge-in
    client.emit('completion-start', 'completion-2', 'prompt-1');

    expect(ctx.cancelledContentIds.has('content-A')).toBe(true);
    expect(ctx.activeContentId).toBe('');
  });

  test('BARGE-IN: turn-complete from old response does not reset state to LISTENING when new response is active', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    // Start first response
    client.emit('completion-start', 'completion-1', 'prompt-1');
    client.emit('content-start', 'content-A', 'AUDIO');
    expect(ctx.conversationState).toBe('AI_SPEAKING');

    // Barge-in triggers new response (AI_THINKING)
    client.emit('completion-start', 'completion-2', 'prompt-1');
    expect(ctx.conversationState).toBe('AI_THINKING');

    // Old response sends a late turn-complete — must NOT reset to LISTENING
    client.emit('turn-complete', 'END_TURN');
    // turn-complete from OLD completion fires while we're in AI_THINKING for NEW response
    // State should remain AI_THINKING (not jump to LISTENING)
    expect(ctx.conversationState).toBe('AI_THINKING');
  });

  test('cancelledContentIds are cleared after turn-complete', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    client.emit('completion-start', 'completion-1', 'prompt-1');
    client.emit('content-start', 'content-A', 'AUDIO');
    client.emit('completion-start', 'completion-2', 'prompt-1'); // barge-in
    expect(ctx.cancelledContentIds.size).toBeGreaterThan(0);

    // Complete the new turn
    client.emit('content-start', 'content-B', 'AUDIO');
    client.emit('turn-complete', 'END_TURN');
    expect(ctx.cancelledContentIds.size).toBe(0);
  });

  test('BARGE-IN cooldown: second barge-in within 1s does not double-call onInterruption', () => {
    const client = new MockNovaClient();
    const { ctx, onInterruption } = buildHandlers(client);

    // First barge-in
    client.emit('completion-start', 'completion-1', 'prompt-1');
    client.emit('content-start', 'content-A', 'AUDIO');
    client.emit('completion-start', 'completion-2', 'prompt-1');
    expect(onInterruption).toHaveBeenCalledTimes(1);

    // Simulate the new response (resets state to AI_SPEAKING)
    client.emit('content-start', 'content-B', 'AUDIO');

    // Immediately another completionStart (within cooldown window)
    ctx.lastBargeInAt = Date.now(); // ensure lastBargeInAt is recent
    client.emit('completion-start', 'completion-3', 'prompt-1');
    // Should NOT fire onInterruption again within the 1s cooldown
    expect(onInterruption).toHaveBeenCalledTimes(1);
  });
});

describe('Sequence number deduplication', () => {
  let dedup: MockAudioRouterDedup;

  beforeEach(() => {
    dedup = new MockAudioRouterDedup();
  });

  test('First occurrence of a seqNum is processed', () => {
    expect(dedup.shouldProcess('sess-1', 1)).toBe(true);
    expect(dedup.shouldProcess('sess-1', 2)).toBe(true);
    expect(dedup.shouldProcess('sess-1', 3)).toBe(true);
  });

  test('Duplicate seqNum is rejected (DUPLICATE UTTERANCE IGNORED)', () => {
    dedup.shouldProcess('sess-1', 5);
    expect(dedup.shouldProcess('sess-1', 5)).toBe(false);
  });

  test('Out-of-order (older) seqNum is rejected', () => {
    dedup.shouldProcess('sess-1', 10);
    expect(dedup.shouldProcess('sess-1', 8)).toBe(false);
    expect(dedup.shouldProcess('sess-1', 9)).toBe(false);
  });

  test('Next higher seqNum after a gap is accepted', () => {
    dedup.shouldProcess('sess-1', 10);
    expect(dedup.shouldProcess('sess-1', 15)).toBe(true);
  });

  test('seqNum=0 is always processed (Twilio sends 0 before first media)', () => {
    expect(dedup.shouldProcess('sess-1', 0)).toBe(true);
    expect(dedup.shouldProcess('sess-1', 0)).toBe(true); // second 0 also passes (no tracking for 0)
  });

  test('Different sessions have independent seqNum state', () => {
    dedup.shouldProcess('sess-1', 5);
    // sess-2 has never seen seqNum 5, so it should be processed
    expect(dedup.shouldProcess('sess-2', 5)).toBe(true);
  });

  test('cleanup removes seqNum state for session', () => {
    dedup.shouldProcess('sess-1', 100);
    dedup.cleanup('sess-1');
    // After cleanup, seqNum 50 should be accepted again (no prior state)
    expect(dedup.shouldProcess('sess-1', 50)).toBe(true);
  });
});

describe('Proactive barge-in: client-side VAD', () => {
  let bargeIn: MockAudioRouterBargeIn;

  beforeEach(() => {
    bargeIn = new MockAudioRouterBargeIn();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('No barge-in when agent is NOT speaking (LISTENING state)', () => {
    const triggered = bargeIn.checkBargeIn('sess-1', LOUD_PCM, false);
    expect(triggered).toBe(false);
    expect(bargeIn.bargeInCount).toBe(0);
  });

  test('No barge-in for silent audio while agent is speaking', () => {
    const triggered = bargeIn.checkBargeIn('sess-1', SILENT_PCM, true);
    expect(triggered).toBe(false);
    expect(bargeIn.bargeInCount).toBe(0);
  });

  test('Barge-in triggered for loud audio while agent is speaking', () => {
    const triggered = bargeIn.checkBargeIn('sess-1', LOUD_PCM, true);
    expect(triggered).toBe(true);
    expect(bargeIn.bargeInCount).toBe(1);
  });

  test('Cooldown: second loud frame within 2s does not double-trigger barge-in', () => {
    bargeIn.checkBargeIn('sess-1', LOUD_PCM, true); // first trigger
    jest.advanceTimersByTime(500); // within cooldown
    const second = bargeIn.checkBargeIn('sess-1', LOUD_PCM, true);
    expect(second).toBe(false);
    expect(bargeIn.bargeInCount).toBe(1); // still 1
  });

  test('Barge-in re-triggers after cooldown expires', () => {
    bargeIn.checkBargeIn('sess-1', LOUD_PCM, true);
    jest.advanceTimersByTime(2_001); // past cooldown
    const second = bargeIn.checkBargeIn('sess-1', LOUD_PCM, true);
    expect(second).toBe(true);
    expect(bargeIn.bargeInCount).toBe(2);
  });

  test('Different sessions can both trigger barge-in independently', () => {
    bargeIn.checkBargeIn('sess-1', LOUD_PCM, true);
    bargeIn.checkBargeIn('sess-2', LOUD_PCM, true);
    expect(bargeIn.bargeInCount).toBe(2);
  });

  test('cleanup removes cooldown state for session', () => {
    bargeIn.checkBargeIn('sess-1', LOUD_PCM, true);
    bargeIn.cleanup('sess-1');
    // After cleanup, sess-1 barge-in should fire again immediately
    const after = bargeIn.checkBargeIn('sess-1', LOUD_PCM, true);
    expect(after).toBe(true);
    expect(bargeIn.bargeInCount).toBe(2);
  });
});

describe('Integration: full barge-in scenario', () => {
  test('Caller barges in: only new response audio reaches the caller', () => {
    const client = new MockNovaClient();
    const { routedChunks } = buildHandlers(client);

    // Agent starts speaking — 2 chunks flow normally
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'content-A', 'AUDIO');
    client.emit('audio-output', Buffer.from('agent-1'), 'content-A', 'compl-1');
    client.emit('audio-output', Buffer.from('agent-2'), 'content-A', 'compl-1');

    // Caller speaks → Nova detects barge-in → new completionStart
    client.emit('completion-start', 'compl-2', 'prompt-1');

    // Stale agent audio from old completion (should be DISCARDED)
    client.emit('audio-output', Buffer.from('agent-3-stale'), 'content-A', 'compl-1');
    client.emit('audio-output', Buffer.from('agent-4-stale'), 'content-A', 'compl-1');

    // New response for caller's utterance
    client.emit('content-start', 'content-B', 'AUDIO');
    client.emit('audio-output', Buffer.from('new-response-1'), 'content-B', 'compl-2');
    client.emit('audio-output', Buffer.from('new-response-2'), 'content-B', 'compl-2');
    client.emit('content-end', 'content-B', 'END_TURN');
    client.emit('turn-complete', 'END_TURN');

    const routed = routedChunks.map((b) => b.toString());

    // Chunks that should reach caller
    expect(routed).toContain('agent-1');
    expect(routed).toContain('agent-2');
    expect(routed).toContain('new-response-1');
    expect(routed).toContain('new-response-2');

    // Stale chunks that must NOT reach caller
    expect(routed).not.toContain('agent-3-stale');
    expect(routed).not.toContain('agent-4-stale');
  });

  test('Agent does NOT repeat same response after barge-in', () => {
    const client = new MockNovaClient();
    const { routedChunks } = buildHandlers(client);

    // First response
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'content-A', 'AUDIO');
    client.emit('audio-output', Buffer.from('response-A'), 'content-A', 'compl-1');

    // Barge-in triggers fresh response cycle
    client.emit('completion-start', 'compl-2', 'prompt-1');

    // content-A audio after barge-in — must be discarded, NOT replayed
    client.emit('audio-output', Buffer.from('response-A'), 'content-A', 'compl-1');

    const routed = routedChunks.map((b) => b.toString());
    // 'response-A' should appear exactly ONCE (the first occurrence before barge-in)
    const occurrences = routed.filter((s) => s === 'response-A').length;
    expect(occurrences).toBe(1); // BUG FIXED: was 2 (response repeated)
  });
});

describe('Transcript contamination prevention', () => {
  test('Text output from interrupted (stale) generation is discarded', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    // Start first response with both AUDIO and TEXT content blocks
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'text-A', 'TEXT');
    client.emit('content-start', 'audio-A', 'AUDIO');
    client.emit('text-output', 'Hello, how can I', 'text-A', 'ASSISTANT');
    expect(ctx.currentAssistantTranscript).toBe('Hello, how can I');

    // Barge-in: new completion starts
    client.emit('completion-start', 'compl-2', 'prompt-1');

    // Partial transcripts should be cleared by completionStart handler
    expect(ctx.currentAssistantTranscript).toBe('');

    // Stale text from old generation arrives late — must be discarded
    client.emit('text-output', ' help you today?', 'text-A', 'ASSISTANT');
    expect(ctx.currentAssistantTranscript).toBe('');
  });

  test('Content-end for stale generation does not finalize partial transcript', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    // First response
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'text-A', 'TEXT');
    client.emit('content-start', 'audio-A', 'AUDIO');
    client.emit('text-output', 'I apologize for the', 'text-A', 'ASSISTANT');

    // Barge-in
    client.emit('completion-start', 'compl-2', 'prompt-1');

    // Late content-end from old text block — must NOT finalize
    client.emit('content-end', 'text-A', 'END_TURN');
    expect(ctx.finalizedTranscripts).toHaveLength(0);
  });

  test('Normal text flow finalizes transcript correctly (no barge-in)', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    // Normal response: completion → text content → audio content → text → content-end → turn-complete
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'text-A', 'TEXT');
    client.emit('text-output', 'Hello!', 'text-A', 'ASSISTANT');
    client.emit('content-end', 'text-A', 'END_TURN');

    expect(ctx.finalizedTranscripts).toHaveLength(1);
    expect(ctx.finalizedTranscripts[0]).toEqual({
      role: 'assistant',
      text: 'Hello!',
      isFinal: true,
    });
  });

  test('User transcript from interrupted turn is discarded', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    // Simulate user speaking (content block with USER role text)
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'user-text-A', 'TEXT');
    client.emit('text-output', 'I want to', 'user-text-A', 'USER');
    expect(ctx.currentUserTranscript).toBe('I want to');

    // Agent starts responding
    client.emit('content-start', 'audio-A', 'AUDIO');

    // Another completion (barge-in)
    client.emit('completion-start', 'compl-2', 'prompt-1');

    // User transcript from old generation should be cleared
    expect(ctx.currentUserTranscript).toBe('');

    // Late user text from old generation — discarded
    client.emit('text-output', ' cancel my order', 'user-text-A', 'USER');
    expect(ctx.currentUserTranscript).toBe('');
  });

  test('New generation text is accepted after barge-in', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    // First response
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'text-A', 'TEXT');
    client.emit('content-start', 'audio-A', 'AUDIO');
    client.emit('text-output', 'Old response text', 'text-A', 'ASSISTANT');

    // Barge-in
    client.emit('completion-start', 'compl-2', 'prompt-1');

    // New response text — should be accepted
    client.emit('content-start', 'text-B', 'TEXT');
    client.emit('content-start', 'audio-B', 'AUDIO');
    client.emit('text-output', 'Fresh response', 'text-B', 'ASSISTANT');
    expect(ctx.currentAssistantTranscript).toBe('Fresh response');

    // Finalize it
    client.emit('content-end', 'text-B', 'END_TURN');
    expect(ctx.finalizedTranscripts).toHaveLength(1);
    expect(ctx.finalizedTranscripts[0].text).toBe('Fresh response');
  });

  test('Text while INTERRUPTED state is discarded (proactive barge-in gap)', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    // Get to AI_SPEAKING
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'text-A', 'TEXT');
    client.emit('content-start', 'audio-A', 'AUDIO');

    // Simulate proactive barge-in by manually setting INTERRUPTED state
    // (in production, AudioRouter calls NovaSessionManager.handleInterruption())
    ctx.conversationState = 'INTERRUPTED';
    ctx.cancelledContentIds.add('audio-A');

    // Text arriving while INTERRUPTED — must be discarded
    client.emit('text-output', 'This should not stick', 'text-A', 'ASSISTANT');
    expect(ctx.currentAssistantTranscript).toBe('');

    // content-end while INTERRUPTED — must NOT finalize
    client.emit('content-end', 'text-A', 'END_TURN');
    expect(ctx.finalizedTranscripts).toHaveLength(0);
  });

  test('No transcript leakage: only current generation transcripts survive a full barge-in cycle', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    // === Response 1 (will be interrupted) ===
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'text-1', 'TEXT');
    client.emit('content-start', 'audio-1', 'AUDIO');
    client.emit('text-output', 'Stale partial sentence', 'text-1', 'ASSISTANT');

    // === Barge-in ===
    client.emit('completion-start', 'compl-2', 'prompt-1');

    // Stale events from old generation
    client.emit('text-output', ' more stale text', 'text-1', 'ASSISTANT');
    client.emit('content-end', 'text-1', 'END_TURN');

    // === Response 2 (current) ===
    client.emit('content-start', 'text-2', 'TEXT');
    client.emit('content-start', 'audio-2', 'AUDIO');
    client.emit('text-output', 'Clean new response', 'text-2', 'ASSISTANT');
    client.emit('content-end', 'text-2', 'END_TURN');
    client.emit('turn-complete', 'END_TURN');

    // Only the new response should be finalized — zero stale transcripts
    expect(ctx.finalizedTranscripts).toHaveLength(1);
    expect(ctx.finalizedTranscripts[0].text).toBe('Clean new response');
    expect(ctx.conversationState).toBe('LISTENING');
  });
});
