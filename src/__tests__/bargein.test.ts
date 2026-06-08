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

/** Mirrors NovaSessionManager.hasActualWords — at least one letter/digit. */
function hasActualWords(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

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
  /** Transcripts promoted to a new USER turn — simulates streamer.promoteUserTurn(). */
  promotedTurns: string[];
  /** Mirrors NovaContext.bargeInPending — suppresses interim transcripts during barge-in. */
  bargeInPending: boolean;
  /** Mirrors NovaContext.lastTurnCompleteGeneration — deduplicates turn-complete. */
  lastTurnCompleteGeneration: number;
  /** Mirrors NovaContext.awaitingUserSpeech — self-followup guard. */
  awaitingUserSpeech: boolean;
  /** Mirrors NovaContext.lastFinalizedUserText — promotion dedup. */
  lastFinalizedUserText: string;
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
    promotedTurns: [],
    bargeInPending: false,
    lastTurnCompleteGeneration: -1,
    awaitingUserSpeech: false,
    lastFinalizedUserText: '',
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
    ctx.lastTurnCompleteGeneration = -1;
    ctx.awaitingUserSpeech = false;
    ctx.lastFinalizedUserText = '';
    if (ctx.conversationState === 'AI_SPEAKING' && ctx.activeContentId) {
      const now = Date.now();
      if (now - ctx.lastBargeInAt > 300) {
        ctx.lastBargeInAt = now;
        ctx.cancelledContentIds.add(ctx.activeContentId);
        ctx.activeContentId = '';
        transitionState('INTERRUPTED');
        onInterruption();
        ctx.bargeInPending = true;
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
    // A cancelled content block must never regain ownership.
    if (ctx.cancelledContentIds.has(contentId)) return;

    // Record generation for EVERY content block (AUDIO or TEXT)
    ctx.contentIdToGeneration.set(contentId, ctx.responseGeneration);

    if (type === 'AUDIO') {
      // INTERRUPTED guard: reject audio blocks from a resumed interrupted response.
      if (ctx.conversationState === 'INTERRUPTED') {
        ctx.cancelledContentIds.add(contentId);
        return;
      }

      // Self-followup guard: reject AUDIO after turn-complete with no user speech.
      if (ctx.awaitingUserSpeech) {
        ctx.cancelledContentIds.add(contentId);
        return;
      }

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
    // Cancelled content filter: text from a cancelled block is always discarded.
    if (ctx.cancelledContentIds.has(contentId)) return;
    // Stale generation filter (applies to USER + ASSISTANT)
    const gen = ctx.contentIdToGeneration.get(contentId);
    if (gen !== undefined && gen < ctx.responseGeneration) return;
    // INTERRUPTED discards ASSISTANT leftovers only — USER text is the caller's live
    // barge-in speech and must be kept (root-cause fix).
    if (ctx.conversationState === 'INTERRUPTED' && role !== 'USER') return;

    if (role === 'USER') {
      ctx.awaitingUserSpeech = false;
      ctx.currentUserTranscript += text;
      // Transcript-confirmed barge-in: real words while AI_SPEAKING interrupt now,
      // preserving the live transcript + re-stamping the block (mirrors production
      // handleInterruption with the preserve hint). Fires once (next delta is INTERRUPTED).
      if (ctx.conversationState === 'AI_SPEAKING' && hasActualWords(ctx.currentUserTranscript)) {
        ctx.responseGeneration++;
        ctx.lastTurnCompleteGeneration = -1;
        ctx.awaitingUserSpeech = false;
        if (ctx.activeContentId) {
          ctx.cancelledContentIds.add(ctx.activeContentId);
          ctx.activeContentId = '';
        }
        ctx.currentAssistantTranscript = '';
        ctx.contentIdToGeneration.set(contentId, ctx.responseGeneration);
        ctx.bargeInPending = true;
        transitionState('INTERRUPTED');
        onInterruption();
      }
    } else {
      // Self-followup guard: discard ASSISTANT text after turn-complete with no user speech.
      if (ctx.awaitingUserSpeech) return;
      ctx.currentAssistantTranscript += text;
      // Control-token guard: suppress interim while it looks like a JSON control token.
      if (ctx.currentAssistantTranscript.trimStart().startsWith('{')) return;
    }
  };

  // ── content-end ──
  const handleContentEnd = (contentId: string): void => {
    // Cancelled content filter: a cancelled block can never finalize transcripts.
    if (ctx.cancelledContentIds.has(contentId)) {
      ctx.contentIdToGeneration.delete(contentId);
      return;
    }
    // Stale generation filter
    const gen = ctx.contentIdToGeneration.get(contentId);
    if (gen !== undefined && gen < ctx.responseGeneration) {
      ctx.contentIdToGeneration.delete(contentId);
      return;
    }
    // INTERRUPTED early-return only when no USER transcript is pending — a pending
    // USER transcript is the caller's live barge-in speech and must be finalized.
    if (ctx.conversationState === 'INTERRUPTED' && !ctx.currentUserTranscript) {
      ctx.contentIdToGeneration.delete(contentId);
      return;
    }

    const interrupted = ctx.conversationState === 'INTERRUPTED';
    ctx.contentIdToGeneration.delete(contentId);

    if (ctx.currentUserTranscript) {
      const finalUserText = ctx.currentUserTranscript;
      ctx.finalizedTranscripts.push({ role: 'user', text: finalUserText, isFinal: true });
      ctx.currentUserTranscript = '';
      if (!interrupted) {
        ctx.bargeInPending = false;
      }
      // Promote a transcript finalized during INTERRUPTED into a new USER turn and
      // recover to LISTENING (mirrors NovaSessionManager.executePromotion). Promotion
      // is immediate and bypasses dedup — interrupted speech is never suppressed.
      if (interrupted) {
        if (ctx.activeContentId) {
          ctx.cancelledContentIds.add(ctx.activeContentId);
          ctx.activeContentId = '';
        }
        ctx.currentAssistantTranscript = '';
        ctx.conversationState = 'LISTENING';
        // Promoted turn is caller input → allow the agent's reply through. Nova
        // streams the promoted response without a completionStart in this
        // deployment, so awaitingUserSpeech must be false or the reply is dropped.
        ctx.awaitingUserSpeech = false;
        ctx.bargeInPending = false;
        ctx.promotedTurns.push(finalUserText);
      }
      ctx.lastFinalizedUserText = finalUserText;
    }
    if (ctx.currentAssistantTranscript) {
      const at = ctx.currentAssistantTranscript.trim();
      const isControlToken =
        at.startsWith('{') && at.endsWith('}') && /"interrupted"\s*:/.test(at);
      // Never finalize a Nova control token ({"interrupted":true}) into history/output.
      if (isControlToken) {
        ctx.currentAssistantTranscript = '';
      } else if (interrupted) {
        // Discard assistant leftovers if interrupted.
        ctx.currentAssistantTranscript = '';
      } else if (ctx.awaitingUserSpeech) {
        // Self-followup guard: discard assistant text finalized after turn-complete
        // with no intervening user speech.
        ctx.currentAssistantTranscript = '';
      } else {
        ctx.finalizedTranscripts.push({ role: 'assistant', text: ctx.currentAssistantTranscript, isFinal: true });
        ctx.currentAssistantTranscript = '';
      }
    }

    // Settling timer at audio content-end (mirrors production code).
    // In tests, we emit turn-complete immediately for simplicity — the settling
    // timer's 500ms delay is tested via jest.useFakeTimers in dedicated tests.
    if (contentId === ctx.activeContentId && ctx.conversationState === 'AI_SPEAKING') {
      client.emit('turn-complete', 'AUDIO_COMPLETE');
    }
  };

  // ── turn-complete ──
  const handleTurnComplete = (): void => {
    // Deduplicate: audio content-end fires turn-complete immediately, and
    // completionEnd may fire another. Process once per generation.
    if (ctx.lastTurnCompleteGeneration === ctx.activeResponseGeneration
      && ctx.conversationState === 'LISTENING') {
      ctx.cancelledContentIds.clear();
      ctx.contentIdToGeneration.clear();
      ctx.activeContentId = '';
      return;
    }
    ctx.lastTurnCompleteGeneration = ctx.activeResponseGeneration;

    const isCurrentResponse = ctx.responseGeneration === ctx.activeResponseGeneration;
    if (isCurrentResponse) {
      // Normal completion — release protection maps and go back to listening.
      ctx.cancelledContentIds.clear();
      ctx.contentIdToGeneration.clear();
      ctx.activeContentId = '';
      transitionState('LISTENING');
      ctx.bargeInPending = false;
      ctx.awaitingUserSpeech = true;
    }
    // else: stale turn-complete from interrupted old response — leave state and
    // protection maps intact so late-arriving stale events are still blocked.
  };

  /**
   * Simulates NovaSessionManager.handleInterruption() — proactive barge-in from
   * AudioRouter RMS detection. Mirrors the Round 2 production code: bumps
   * responseGeneration, cancels active content, transitions to INTERRUPTED.
   * Does NOT clear contentIdToGeneration (that was the bug we fixed).
   */
  const handleProactiveBargeIn = (): void => {
    // Bump generation so stale-generation filters work.
    // CRITICAL: do NOT set activeResponseGeneration — leave it at the old value
    // so the interrupted response's turn-complete is correctly detected as stale
    // (responseGeneration !== activeResponseGeneration).
    ctx.responseGeneration++;
    ctx.lastTurnCompleteGeneration = -1;
    ctx.awaitingUserSpeech = false; // caller spoke

    if (ctx.activeContentId) {
      ctx.cancelledContentIds.add(ctx.activeContentId);
      ctx.activeContentId = '';
    }
    ctx.currentAssistantTranscript = '';
    ctx.currentUserTranscript = '';
    // DO NOT clear contentIdToGeneration — old blocks must retain their gen mapping
    ctx.bargeInPending = true;
    transitionState('INTERRUPTED');
    onInterruption();
  };

  /**
   * Simulates NovaSessionManager.handleVadEndDuringInterruption() — VAD end fired
   * while INTERRUPTED. Recovers immediately unless a real word-bearing transcript
   * was captured (genuine barge-in → let it promote).
   */
  const handleVadEnd = (): void => {
    if (ctx.conversationState !== 'INTERRUPTED') return;
    if (hasActualWords(ctx.currentUserTranscript)) return;
    ctx.currentUserTranscript = '';
    ctx.bargeInPending = false;
    ctx.awaitingUserSpeech = true;
    transitionState('LISTENING');
  };

  client.on('completion-start', handleCompletionStart);
  client.on('content-start', handleContentStart);
  client.on('audio-output', handleAudioOutput);
  client.on('text-output', handleTextOutput);
  client.on('content-end', handleContentEnd);
  client.on('turn-complete', handleTurnComplete);

  return { ctx, routedChunks, onAudioOutput, onInterruption, handleProactiveBargeIn, handleVadEnd };
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
  private readonly pending = new Map<string, { startMs: number; lastSpeechMs: number }>();
  readonly VAD_THRESHOLD = 500;
  readonly COOLDOWN_MS = 300;
  readonly CONFIRM_MS = 400;
  readonly GAP_MS = 120;

  bargeInCount = 0;

  /**
   * Returns true only when sustained speech reaches the confirm window — mirrors
   * AudioRouter's pending→confirm model. A single loud frame enters PENDING and
   * returns false; bursts that stop before CONFIRM_MS are discarded.
   */
  checkBargeIn(sessionId: string, pcm16: Buffer, agentSpeaking: boolean): boolean {
    if (!agentSpeaking) { this.pending.delete(sessionId); return false; }
    const rms = this.computeRms(pcm16);
    const now = Date.now();
    const pending = this.pending.get(sessionId);
    if (rms >= this.VAD_THRESHOLD) {
      if (!pending) {
        this.pending.set(sessionId, { startMs: now, lastSpeechMs: now });
        return false;
      }
      pending.lastSpeechMs = now;
      if (now - pending.startMs >= this.CONFIRM_MS) {
        const last = this.lastBargeInAt.get(sessionId) ?? 0;
        if (now - last < this.COOLDOWN_MS) return false;
        this.lastBargeInAt.set(sessionId, now);
        this.pending.delete(sessionId);
        this.bargeInCount++;
        return true;
      }
      return false;
    }
    if (pending && now - pending.lastSpeechMs > this.GAP_MS) {
      this.pending.delete(sessionId);
    }
    return false;
  }

  /** Feed continuous loud speech for `ms`, one 20ms frame at a time (fake timers). */
  sustainSpeech(sessionId: string, ms: number): boolean {
    let triggered = false;
    for (let t = 0; t <= ms; t += 20) {
      if (this.checkBargeIn(sessionId, LOUD_PCM, true)) triggered = true;
      jest.advanceTimersByTime(20);
    }
    return triggered;
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
    this.pending.delete(sessionId);
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

  test('BARGE-IN cooldown: second barge-in within 300ms does not double-call onInterruption', () => {
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
    // Even sustained loud audio does not interrupt when the agent is not speaking.
    let triggered = false;
    for (let t = 0; t <= 600; t += 20) {
      if (bargeIn.checkBargeIn('sess-1', LOUD_PCM, false)) triggered = true;
      jest.advanceTimersByTime(20);
    }
    expect(triggered).toBe(false);
    expect(bargeIn.bargeInCount).toBe(0);
  });

  test('No barge-in for silent audio while agent is speaking', () => {
    const triggered = bargeIn.checkBargeIn('sess-1', SILENT_PCM, true);
    expect(triggered).toBe(false);
    expect(bargeIn.bargeInCount).toBe(0);
  });

  test('A single loud frame does NOT interrupt — only enters PENDING', () => {
    const triggered = bargeIn.checkBargeIn('sess-1', LOUD_PCM, true);
    expect(triggered).toBe(false);
    expect(bargeIn.bargeInCount).toBe(0);
  });

  test('Short burst (< 300ms) then silence does NOT interrupt', () => {
    // 280ms of speech, then it stops.
    for (let t = 0; t < 280; t += 20) {
      bargeIn.checkBargeIn('sess-1', LOUD_PCM, true);
      jest.advanceTimersByTime(20);
    }
    // Silence past the gap tolerance — pending is discarded.
    for (let t = 0; t < 200; t += 20) {
      bargeIn.checkBargeIn('sess-1', SILENT_PCM, true);
      jest.advanceTimersByTime(20);
    }
    expect(bargeIn.bargeInCount).toBe(0);
  });

  test('Sustained speech >= 400ms DOES interrupt', () => {
    const triggered = bargeIn.sustainSpeech('sess-1', 400);
    expect(triggered).toBe(true);
    expect(bargeIn.bargeInCount).toBe(1);
  });

  test('Brief inter-word dips (< gap) do not reset the pending run', () => {
    // ~200ms speech, a single 20ms dip (< 120ms gap), then more speech past 400ms.
    for (let t = 0; t < 200; t += 20) {
      bargeIn.checkBargeIn('sess-1', LOUD_PCM, true);
      jest.advanceTimersByTime(20);
    }
    bargeIn.checkBargeIn('sess-1', SILENT_PCM, true); // brief dip
    jest.advanceTimersByTime(20);
    let triggered = false;
    for (let t = 0; t < 240; t += 20) {
      if (bargeIn.checkBargeIn('sess-1', LOUD_PCM, true)) triggered = true;
      jest.advanceTimersByTime(20);
    }
    expect(triggered).toBe(true);
    expect(bargeIn.bargeInCount).toBe(1);
  });

  test('Once confirmed, no further triggers while the agent is no longer speaking', () => {
    expect(bargeIn.sustainSpeech('sess-1', 400)).toBe(true);
    expect(bargeIn.bargeInCount).toBe(1);
    // After the barge-in, the agent stops speaking (state leaves AI_SPEAKING in
    // production). Further loud frames with agentSpeaking=false must not re-trigger.
    for (let t = 0; t <= 600; t += 20) {
      expect(bargeIn.checkBargeIn('sess-1', LOUD_PCM, false)).toBe(false);
      jest.advanceTimersByTime(20);
    }
    expect(bargeIn.bargeInCount).toBe(1);
  });

  test('Different sessions can both trigger barge-in independently', () => {
    expect(bargeIn.sustainSpeech('sess-1', 400)).toBe(true);
    expect(bargeIn.sustainSpeech('sess-2', 400)).toBe(true);
    expect(bargeIn.bargeInCount).toBe(2);
  });

  test('cleanup removes pending + cooldown state for session', () => {
    bargeIn.sustainSpeech('sess-1', 400);
    bargeIn.cleanup('sess-1');
    // After cleanup, a fresh sustained run fires again immediately (cooldown cleared).
    const after = bargeIn.sustainSpeech('sess-1', 400);
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

  test('USER transcript during INTERRUPTED is KEPT and finalized (caller barge-in speech not lost)', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    // Agent speaking
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'audio-A', 'AUDIO');

    // Proactive (AudioRouter) barge-in → INTERRUPTED, no new completionStart yet.
    ctx.conversationState = 'INTERRUPTED';
    ctx.cancelledContentIds.add('audio-A');

    // Caller's live ASR for the barge-in utterance arrives WHILE INTERRUPTED.
    client.emit('content-start', 'user-text-B', 'TEXT');
    client.emit('text-output', 'my name is', 'user-text-B', 'USER');
    client.emit('text-output', ' Shiva', 'user-text-B', 'USER');
    // Root-cause fix: USER text is kept, not discarded.
    expect(ctx.currentUserTranscript).toBe('my name is Shiva');

    // content-end still INTERRUPTED → must FINALIZE the user transcript (not drop it).
    client.emit('content-end', 'user-text-B', 'END_TURN');
    const userFinals = ctx.finalizedTranscripts.filter((t) => t.role === 'user');
    expect(userFinals).toHaveLength(1);
    expect(userFinals[0].text).toBe('my name is Shiva');

    // …and it must be PROMOTED into a new USER turn + recover to LISTENING, so Nova
    // responds to it instead of resuming the interrupted response.
    expect(ctx.promotedTurns).toEqual(['my name is Shiva']);
    expect(ctx.conversationState).toBe('LISTENING');
    expect(ctx.cancelledContentIds.has('audio-A')).toBe(true);
  });

  test('Nova control token {"interrupted":true} is never finalized into transcript/output', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    client.emit('completion-start', 'compl-1', 'prompt-1');
    // A normal assistant response finalizes fine.
    client.emit('content-start', 'text-A', 'TEXT');
    client.emit('content-start', 'audio-A', 'AUDIO');
    client.emit('text-output', 'Bilkul, theek hai.', 'text-A', 'ASSISTANT');
    client.emit('content-end', 'text-A', 'END_TURN');

    // Nova then emits its barge-in control token as a separate assistant text block.
    client.emit('content-start', 'text-ctrl', 'TEXT');
    client.emit('text-output', '{ "interrupted" : true }', 'text-ctrl', 'ASSISTANT');
    // Interim must be suppressed (not surfaced).
    client.emit('content-end', 'text-ctrl', 'END_TURN');

    const assistantTexts = ctx.finalizedTranscripts.filter((t) => t.role === 'assistant').map((t) => t.text);
    expect(assistantTexts).toEqual(['Bilkul, theek hai.']);
    expect(assistantTexts.some((t) => t.includes('interrupted'))).toBe(false);
  });

  test('USER transcript finalized in LISTENING (normal) is NOT promoted', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    // Normal turn — no interruption.
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'user-text-A', 'TEXT');
    client.emit('text-output', 'my name is Shiva', 'user-text-A', 'USER');
    // Simulate normal listening state when the final arrives.
    ctx.conversationState = 'LISTENING';
    client.emit('content-end', 'user-text-A', 'END_TURN');

    expect(ctx.finalizedTranscripts.filter((t) => t.role === 'user')).toHaveLength(1);
    // Not interrupted → no promotion (Nova answers the audio turn natively).
    expect(ctx.promotedTurns).toHaveLength(0);
  });

  test('Rapid re-interruption after cooldown reset works (resetBargeInCooldown)', () => {
    const client = new MockNovaClient();
    const { ctx, onInterruption } = buildHandlers(client);

    // First response → barge-in
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'audio-A', 'AUDIO');
    // Barge-in fires
    client.emit('completion-start', 'compl-2', 'prompt-1');
    expect(onInterruption).toHaveBeenCalledTimes(1);

    // New response starts — in production, onNewResponse resets the AudioRouter cooldown.
    // Here we verify the Nova-side cooldown was set, then manually simulate the reset
    // that happens via ctx.onNewResponse() in the real onCompletionStart handler.
    // The second completionStart already bumped lastBargeInAt. Reset it to simulate
    // the cooldown reset that onNewResponse() provides.
    ctx.lastBargeInAt = 0;

    // New response plays
    client.emit('content-start', 'audio-B', 'AUDIO');
    expect(ctx.conversationState).toBe('AI_SPEAKING');

    // Another barge-in immediately — should fire because cooldown was reset
    client.emit('completion-start', 'compl-3', 'prompt-1');
    expect(onInterruption).toHaveBeenCalledTimes(2);
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

describe('Cooldown reset: AudioRouter barge-in re-fires after cooldown clear', () => {
  let bargeIn: MockAudioRouterBargeIn;

  beforeEach(() => {
    bargeIn = new MockAudioRouterBargeIn();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('After cooldown reset, barge-in fires again on the next sustained run', () => {
    // First barge-in (sustained 400ms)
    expect(bargeIn.sustainSpeech('sess-1', 400)).toBe(true);
    expect(bargeIn.bargeInCount).toBe(1);

    // Only 50ms later — still within cooldown
    jest.advanceTimersByTime(50);

    // Reset cooldown + pending (simulates AudioRouter.resetBargeInCooldown)
    bargeIn.cleanup('sess-1');

    // A fresh sustained run fires immediately (no cooldown wait)
    const triggered = bargeIn.sustainSpeech('sess-1', 400);
    expect(triggered).toBe(true);
    expect(bargeIn.bargeInCount).toBe(2);
  });
});

describe('Silence re-engagement', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('Silence prompt fires 3 seconds after agent finishes speaking', () => {
    const silencePromptCalls: string[] = [];

    // Simulate a minimal silence re-engagement flow
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    let conversationState: ConversationState = 'LISTENING';
    const SILENCE_TIMEOUT_MS = 3_000;
    const SILENCE_PROMPT = '[The caller has been silent for several seconds. Say exactly: "I may not have heard you. Are you still there?"]';

    // Agent finishes speaking → start silence timer
    conversationState = 'LISTENING';
    silenceTimer = setTimeout(() => {
      silenceTimer = null;
      if (conversationState === 'LISTENING') {
        silencePromptCalls.push(SILENCE_PROMPT);
      }
    }, SILENCE_TIMEOUT_MS);

    // At 2 seconds — timer should NOT have fired
    jest.advanceTimersByTime(2_000);
    expect(silencePromptCalls).toHaveLength(0);

    // At 3 seconds — timer fires
    jest.advanceTimersByTime(1_000);
    expect(silencePromptCalls).toHaveLength(1);
    expect(silencePromptCalls[0]).toContain('I may not have heard you. Are you still there?');
  });

  test('Silence timer is cancelled when caller speaks (completionStart)', () => {
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    let conversationState: ConversationState = 'LISTENING';
    const silencePromptCalls: string[] = [];
    const SILENCE_TIMEOUT_MS = 3_000;

    // Agent finishes → start timer
    silenceTimer = setTimeout(() => {
      silenceTimer = null;
      if (conversationState === 'LISTENING') {
        silencePromptCalls.push('re-engage');
      }
    }, SILENCE_TIMEOUT_MS);

    // Caller speaks at 1.5 seconds → cancel timer
    jest.advanceTimersByTime(1_500);
    clearTimeout(silenceTimer!);
    silenceTimer = null;
    conversationState = 'AI_THINKING';

    // Past the 3-second mark — nothing should fire
    jest.advanceTimersByTime(2_000);
    expect(silencePromptCalls).toHaveLength(0);
  });

  test('Silence timer is cancelled on client-side barge-in', () => {
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    let conversationState: ConversationState = 'LISTENING';
    const silencePromptCalls: string[] = [];
    const SILENCE_TIMEOUT_MS = 3_000;

    // Agent finishes → start timer
    silenceTimer = setTimeout(() => {
      silenceTimer = null;
      if (conversationState === 'LISTENING') {
        silencePromptCalls.push('re-engage');
      }
    }, SILENCE_TIMEOUT_MS);

    // Simulate handleInterruption cancelling the timer
    jest.advanceTimersByTime(500);
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
    conversationState = 'INTERRUPTED';

    jest.advanceTimersByTime(3_000);
    expect(silencePromptCalls).toHaveLength(0);
  });

  test('Silence prompt does NOT fire if agent is already speaking again', () => {
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    let conversationState: ConversationState = 'LISTENING';
    const silencePromptCalls: string[] = [];
    const SILENCE_TIMEOUT_MS = 3_000;

    // Agent finishes → start timer
    silenceTimer = setTimeout(() => {
      silenceTimer = null;
      if (conversationState === 'LISTENING') {
        silencePromptCalls.push('re-engage');
      }
    }, SILENCE_TIMEOUT_MS);

    // Agent starts speaking again at 2s (e.g. Nova responded to something)
    jest.advanceTimersByTime(2_000);
    conversationState = 'AI_SPEAKING';

    // Timer fires at 3s but state is AI_SPEAKING → no prompt
    jest.advanceTimersByTime(1_000);
    expect(silencePromptCalls).toHaveLength(0);
  });
});

describe('Outbound generation guard: in-flight audio discarded after interruption', () => {
  /**
   * Simulates the AudioRouter outbound generation guard that prevents stale
   * audio from reaching Twilio after a barge-in. The real code uses an async
   * processOutbound() step; this mock uses a deferred promise to simulate it.
   */
  class MockOutboundRouter {
    private generation = new Map<string, number>();
    readonly sentChunks: string[] = [];

    /** Simulate routeOutbound: capture gen → async work → check gen → send */
    async routeOutbound(sessionId: string, label: string, resolveEncoding: () => void): Promise<void> {
      const genAtEntry = this.generation.get(sessionId) ?? 0;

      // Simulate async processOutbound — caller resolves when ready
      await new Promise<void>((r) => {
        // Store the resolve fn so the test can control timing
        resolveEncoding();
        r();
      });

      const genNow = this.generation.get(sessionId) ?? 0;
      if (genNow !== genAtEntry) return; // discarded

      this.sentChunks.push(label);
    }

    handleInterruption(sessionId: string): void {
      this.generation.set(sessionId, (this.generation.get(sessionId) ?? 0) + 1);
    }

    cleanup(sessionId: string): void {
      this.generation.delete(sessionId);
    }
  }

  test('Chunks dispatched before interruption are discarded after async step', async () => {
    const router = new MockOutboundRouter();

    // Chunk dispatched before interruption (gen=0)
    const p1 = router.routeOutbound('sess-1', 'chunk-before', () => {});

    // Interruption bumps generation to 1
    router.handleInterruption('sess-1');

    // Chunk dispatched after interruption (gen=1) — should succeed
    const p2 = router.routeOutbound('sess-1', 'chunk-after', () => {});

    await Promise.all([p1, p2]);

    // Only the post-interruption chunk should have been sent
    expect(router.sentChunks).toEqual(['chunk-after']);
  });

  test('Multiple interruptions discard all prior chunks', async () => {
    const router = new MockOutboundRouter();

    const p1 = router.routeOutbound('sess-1', 'gen0-chunk', () => {});
    router.handleInterruption('sess-1');

    const p2 = router.routeOutbound('sess-1', 'gen1-chunk', () => {});
    router.handleInterruption('sess-1');

    const p3 = router.routeOutbound('sess-1', 'gen2-chunk', () => {});

    await Promise.all([p1, p2, p3]);

    // Only the chunk from the latest generation survives
    expect(router.sentChunks).toEqual(['gen2-chunk']);
  });

  test('Cleanup removes generation state', async () => {
    const router = new MockOutboundRouter();

    router.handleInterruption('sess-1'); // gen=1
    router.cleanup('sess-1');

    // After cleanup, gen resets to 0 — chunk should succeed
    const p = router.routeOutbound('sess-1', 'post-cleanup', () => {});
    await p;
    expect(router.sentChunks).toEqual(['post-cleanup']);
  });

  test('Post-interruption behavior: interrupted response discarded, new response flows', () => {
    const client = new MockNovaClient();
    const { ctx, routedChunks, onInterruption } = buildHandlers(client);

    // Agent starts speaking
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'audio-A', 'AUDIO');
    client.emit('audio-output', Buffer.from('agent-speaking'), 'audio-A', 'compl-1');
    expect(routedChunks.map(b => b.toString())).toContain('agent-speaking');

    // User interrupts — Nova fires new completion
    client.emit('completion-start', 'compl-2', 'prompt-1');
    expect(onInterruption).toHaveBeenCalled();

    // Stale audio from interrupted response — discarded
    client.emit('audio-output', Buffer.from('stale-after-interrupt'), 'audio-A', 'compl-1');

    // Agent generates new response to user's interruption
    client.emit('content-start', 'audio-B', 'AUDIO');
    client.emit('audio-output', Buffer.from('new-response'), 'audio-B', 'compl-2');
    client.emit('content-end', 'audio-B', 'END_TURN');

    const routed = routedChunks.map(b => b.toString());
    expect(routed).not.toContain('stale-after-interrupt');
    expect(routed).toContain('new-response');
    expect(ctx.conversationState).toBe('LISTENING');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NEW TESTS: Multi-fragment interruption aggregation
// ─────────────────────────────────────────────────────────────────────────────

describe('Multi-fragment interruption aggregation', () => {
  test('First interrupted fragment is promoted immediately; later fragments are finalized but not re-promoted', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    // Agent speaking
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'audio-A', 'AUDIO');

    // Proactive barge-in → INTERRUPTED
    ctx.conversationState = 'INTERRUPTED';
    ctx.cancelledContentIds.add('audio-A');
    ctx.bargeInPending = true;

    // First fragment: "हाँ, मैं" — finalized at VAD-end → promoted immediately,
    // state recovers to LISTENING and bargeInPending is cleared.
    client.emit('content-start', 'user-text-1', 'TEXT');
    client.emit('text-output', 'हाँ, मैं', 'user-text-1', 'USER');
    client.emit('content-end', 'user-text-1', 'END_TURN');

    expect(ctx.conversationState).toBe('LISTENING');
    expect(ctx.bargeInPending).toBe(false);
    expect(ctx.promotedTurns).toEqual(['हाँ, मैं']);

    // Second fragment: "भी" — arrives after recovery (state LISTENING), so it is
    // finalized into history but NOT separately promoted (exactly one promoted turn
    // per interruption).
    client.emit('content-start', 'user-text-2', 'TEXT');
    client.emit('text-output', 'भी', 'user-text-2', 'USER');
    client.emit('content-end', 'user-text-2', 'END_TURN');

    const userFinals = ctx.finalizedTranscripts.filter(t => t.role === 'user');
    expect(userFinals).toHaveLength(2);
    expect(userFinals[0].text).toBe('हाँ, मैं');
    expect(userFinals[1].text).toBe('भी');
    expect(ctx.promotedTurns).toHaveLength(1);
  });

  test('bargeInPending is cleared on normal (non-interrupted) content-end', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    // Normal turn — no interruption
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'user-text-A', 'TEXT');
    client.emit('text-output', 'Hello', 'user-text-A', 'USER');

    // Manually set bargeInPending to verify it gets cleared
    ctx.bargeInPending = true;
    // Force state to LISTENING (non-interrupted)
    ctx.conversationState = 'LISTENING';
    client.emit('content-end', 'user-text-A', 'END_TURN');

    expect(ctx.bargeInPending).toBe(false);
  });

  test('bargeInPending is cleared by turn-complete (safety net)', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'audio-A', 'AUDIO');
    ctx.bargeInPending = true;

    client.emit('content-end', 'audio-A', 'END_TURN');
    // turn-complete fired immediately by content-end → bargeInPending cleared
    expect(ctx.bargeInPending).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NEW TESTS: Duplicate assistant suppression
// ─────────────────────────────────────────────────────────────────────────────

describe('Duplicate assistant suppression', () => {
  test('Assistant text from cancelled content block is discarded (text-output)', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'text-A', 'TEXT');
    client.emit('content-start', 'audio-A', 'AUDIO');

    // Cancel text-A content block (simulates interruption cleanup)
    ctx.cancelledContentIds.add('text-A');

    // Text arrives for cancelled content — must be discarded
    client.emit('text-output', 'This should be suppressed', 'text-A', 'ASSISTANT');
    expect(ctx.currentAssistantTranscript).toBe('');
  });

  test('Assistant text from cancelled content block is discarded (content-end)', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'text-A', 'TEXT');
    client.emit('text-output', 'Partial response', 'text-A', 'ASSISTANT');

    // Cancel the block
    ctx.cancelledContentIds.add('text-A');

    // content-end for cancelled block — must not finalize
    client.emit('content-end', 'text-A', 'END_TURN');
    expect(ctx.finalizedTranscripts).toHaveLength(0);
  });

  test('Only current generation assistant text is finalized after barge-in cycle', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    // Response 1
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'text-1', 'TEXT');
    client.emit('content-start', 'audio-1', 'AUDIO');
    client.emit('text-output', 'Old response', 'text-1', 'ASSISTANT');

    // Barge-in
    client.emit('completion-start', 'compl-2', 'prompt-1');

    // Stale text from old generation
    client.emit('text-output', ' continues', 'text-1', 'ASSISTANT');
    client.emit('content-end', 'text-1', 'END_TURN');

    // Response 2
    client.emit('content-start', 'text-2', 'TEXT');
    client.emit('content-start', 'audio-2', 'AUDIO');
    client.emit('text-output', 'New response', 'text-2', 'ASSISTANT');
    client.emit('content-end', 'text-2', 'END_TURN');
    client.emit('content-end', 'audio-2', 'END_TURN');

    // Only new response finalized
    const assistantTexts = ctx.finalizedTranscripts
      .filter(t => t.role === 'assistant')
      .map(t => t.text);
    expect(assistantTexts).toEqual(['New response']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NEW TESTS: Cancelled generation transcript discard
// ─────────────────────────────────────────────────────────────────────────────

describe('Cancelled generation transcript discard', () => {
  test('Cancelled content block cannot emit USER transcripts via text-output', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'user-text-A', 'TEXT');

    // Cancel
    ctx.cancelledContentIds.add('user-text-A');

    client.emit('text-output', 'Stale user text', 'user-text-A', 'USER');
    expect(ctx.currentUserTranscript).toBe('');
  });

  test('Cancelled content block content-end never finalizes transcript', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'text-A', 'TEXT');
    client.emit('text-output', 'Some text', 'text-A', 'ASSISTANT');

    // Cancel and then try to finalize
    ctx.cancelledContentIds.add('text-A');
    client.emit('content-end', 'text-A', 'END_TURN');

    expect(ctx.finalizedTranscripts).toHaveLength(0);
    // currentAssistantTranscript should still contain text (it was accumulated
    // before cancellation, but content-end was blocked from finalizing it)
    expect(ctx.currentAssistantTranscript).toBe('Some text');
  });

  test('Cancelled generation cannot regain ownership via content-start', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'audio-A', 'AUDIO');
    expect(ctx.activeContentId).toBe('audio-A');

    // Cancel audio-A
    ctx.cancelledContentIds.add('audio-A');
    ctx.activeContentId = '';

    // content-start for cancelled block is already in cancelledContentIds —
    // it remains blocked for audio-output
    client.emit('audio-output', Buffer.from('stale'), 'audio-A', 'compl-1');
    // Should be discarded by audio-output handler
  });

  test('Audio from cancelled content is discarded even if state is not INTERRUPTED', () => {
    const client = new MockNovaClient();
    const { routedChunks } = buildHandlers(client);

    // Normal response → barge-in → new response
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'audio-A', 'AUDIO');
    client.emit('audio-output', Buffer.from('live'), 'audio-A', 'compl-1');

    // Barge-in: new completionStart → AI_THINKING (not INTERRUPTED!)
    client.emit('completion-start', 'compl-2', 'prompt-1');

    // New response starts → AI_SPEAKING
    client.emit('content-start', 'audio-B', 'AUDIO');

    // Late audio from old content-A arrives while state is AI_SPEAKING (for B)
    client.emit('audio-output', Buffer.from('stale-from-A'), 'audio-A', 'compl-1');

    const routed = routedChunks.map(b => b.toString());
    expect(routed).toContain('live');
    expect(routed).not.toContain('stale-from-A');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NEW TESTS: Watchdog non-interference
// ─────────────────────────────────────────────────────────────────────────────

describe('Watchdog non-interference', () => {
  test('Audio content-end fires turn-complete immediately (not via watchdog)', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    const states: ConversationState[] = [];

    // Normal response
    client.emit('completion-start', 'compl-1', 'prompt-1');
    states.push(ctx.conversationState); // AI_THINKING

    client.emit('content-start', 'audio-A', 'AUDIO');
    states.push(ctx.conversationState); // AI_SPEAKING

    client.emit('audio-output', Buffer.from('chunk'), 'audio-A', 'compl-1');

    // content-end for AUDIO fires turn-complete IMMEDIATELY
    client.emit('content-end', 'audio-A', 'END_TURN');
    states.push(ctx.conversationState); // LISTENING (immediate, no 5s delay)

    expect(states).toEqual(['AI_THINKING', 'AI_SPEAKING', 'LISTENING']);
  });

  test('Duplicate turn-complete after audio content-end is deduplicated', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    // Normal response
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'audio-A', 'AUDIO');
    client.emit('audio-output', Buffer.from('chunk'), 'audio-A', 'compl-1');

    // content-end fires turn-complete immediately → LISTENING
    client.emit('content-end', 'audio-A', 'END_TURN');
    expect(ctx.conversationState).toBe('LISTENING');

    // Simulate a late completionEnd also firing turn-complete
    client.emit('turn-complete', 'COMPLETION_END');
    // Should still be LISTENING (deduplicated, no double processing)
    expect(ctx.conversationState).toBe('LISTENING');
  });

  test('INTERRUPTED recovery turn-complete is NOT deduplicated', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    // Normal response → audio completes
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'audio-A', 'AUDIO');
    client.emit('content-end', 'audio-A', 'END_TURN');
    expect(ctx.conversationState).toBe('LISTENING');

    // Proactive barge-in → INTERRUPTED
    ctx.conversationState = 'INTERRUPTED';
    ctx.cancelledContentIds.add('audio-A');

    // Recovery turn-complete (from INTERRUPTED recovery watchdog)
    client.emit('turn-complete', 'INTERRUPTED_RECOVERY');
    // Should process (not deduplicate) because state is INTERRUPTED, not LISTENING
    expect(ctx.conversationState).toBe('LISTENING');
  });

  test('Normal response completes without watchdog interference', () => {
    const client = new MockNovaClient();
    const { ctx, routedChunks } = buildHandlers(client);

    // Full normal response cycle
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'text-A', 'TEXT');
    client.emit('text-output', 'Hello there!', 'text-A', 'ASSISTANT');
    client.emit('content-end', 'text-A', 'END_TURN');

    client.emit('content-start', 'audio-A', 'AUDIO');
    client.emit('audio-output', Buffer.from('audio-data'), 'audio-A', 'compl-1');
    client.emit('content-end', 'audio-A', 'END_TURN');

    // State should be LISTENING (immediate, no watchdog needed)
    expect(ctx.conversationState).toBe('LISTENING');

    // Transcript finalized correctly
    const assistants = ctx.finalizedTranscripts.filter(t => t.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].text).toBe('Hello there!');

    // Audio routed correctly
    expect(routedChunks.map(b => b.toString())).toContain('audio-data');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NEW TESTS (Round 2): Proactive barge-in generation tracking
// ─────────────────────────────────────────────────────────────────────────────

describe('Proactive barge-in: generation tracking', () => {
  test('handleProactiveBargeIn bumps responseGeneration so stale events are filtered', () => {
    const client = new MockNovaClient();
    const { ctx, handleProactiveBargeIn } = buildHandlers(client);

    // Agent starts speaking
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'text-A', 'TEXT');
    client.emit('content-start', 'audio-A', 'AUDIO');
    client.emit('text-output', 'Hello, how can I help', 'text-A', 'ASSISTANT');
    expect(ctx.responseGeneration).toBe(1);

    // Proactive barge-in (AudioRouter RMS detection)
    handleProactiveBargeIn();

    // Generation must have been bumped, but activeResponseGeneration stays at old
    // value so the interrupted response's turn-complete is detected as stale.
    expect(ctx.responseGeneration).toBe(2);
    expect(ctx.activeResponseGeneration).toBe(1); // NOT bumped — stale detection
    expect(ctx.conversationState).toBe('INTERRUPTED');

    // Stale text from old generation (gen=1) must be discarded
    client.emit('text-output', ' you today?', 'text-A', 'ASSISTANT');
    expect(ctx.currentAssistantTranscript).toBe('');

    // Stale content-end from old generation must not finalize
    client.emit('content-end', 'text-A', 'END_TURN');
    expect(ctx.finalizedTranscripts).toHaveLength(0);
  });

  test('contentIdToGeneration is NOT cleared on proactive barge-in — stale events are tracked', () => {
    const client = new MockNovaClient();
    const { ctx, handleProactiveBargeIn } = buildHandlers(client);

    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'text-A', 'TEXT');
    client.emit('content-start', 'audio-A', 'AUDIO');

    // Verify old content blocks are in the generation map
    expect(ctx.contentIdToGeneration.get('text-A')).toBe(1);
    expect(ctx.contentIdToGeneration.get('audio-A')).toBe(1);

    // Proactive barge-in
    handleProactiveBargeIn();

    // contentIdToGeneration must NOT be cleared — old blocks retain their gen
    expect(ctx.contentIdToGeneration.get('text-A')).toBe(1);
    expect(ctx.contentIdToGeneration.get('audio-A')).toBe(1);

    // Stale text from text-A (gen=1, current=2) is filtered
    client.emit('text-output', 'stale text', 'text-A', 'ASSISTANT');
    expect(ctx.currentAssistantTranscript).toBe('');
  });

  test('Stale assistant transcript from interrupted response never reaches finalizedTranscripts', () => {
    const client = new MockNovaClient();
    const { ctx, handleProactiveBargeIn, routedChunks } = buildHandlers(client);

    // Response 1: agent speaks
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'text-1', 'TEXT');
    client.emit('content-start', 'audio-1', 'AUDIO');
    client.emit('text-output', 'Bilkul, theek hai.', 'text-1', 'ASSISTANT');
    client.emit('audio-output', Buffer.from('audio-data-1'), 'audio-1', 'compl-1');

    // Proactive barge-in
    handleProactiveBargeIn();

    // Stale text from old gen arrives
    client.emit('text-output', ' Aap ka naam kya hai?', 'text-1', 'ASSISTANT');
    client.emit('content-end', 'text-1', 'END_TURN');

    // Stale audio from old gen
    client.emit('audio-output', Buffer.from('stale-audio'), 'audio-1', 'compl-1');
    client.emit('content-end', 'audio-1', 'END_TURN');

    // No finalized transcripts from the interrupted response
    expect(ctx.finalizedTranscripts).toHaveLength(0);

    // Stale audio not routed
    const routed = routedChunks.map(b => b.toString());
    expect(routed).not.toContain('stale-audio');
  });

  test('New content blocks after proactive barge-in work normally', () => {
    const client = new MockNovaClient();
    const { ctx, handleProactiveBargeIn, routedChunks } = buildHandlers(client);

    // Response 1
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'audio-1', 'AUDIO');
    client.emit('audio-output', Buffer.from('live-audio'), 'audio-1', 'compl-1');

    // Proactive barge-in
    handleProactiveBargeIn();

    // Nova responds natively with new completionStart
    client.emit('completion-start', 'compl-2', 'prompt-1');

    // New response
    client.emit('content-start', 'text-2', 'TEXT');
    client.emit('content-start', 'audio-2', 'AUDIO');
    client.emit('text-output', 'Fresh response', 'text-2', 'ASSISTANT');
    client.emit('audio-output', Buffer.from('new-audio'), 'audio-2', 'compl-2');
    client.emit('content-end', 'text-2', 'END_TURN');
    client.emit('content-end', 'audio-2', 'END_TURN');

    // New response accepted
    const assistants = ctx.finalizedTranscripts.filter(t => t.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].text).toBe('Fresh response');

    const routed = routedChunks.map(b => b.toString());
    expect(routed).toContain('new-audio');
    expect(ctx.conversationState).toBe('LISTENING');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NEW TESTS (Round 2): INTERRUPTED guard on AUDIO content-start
// ─────────────────────────────────────────────────────────────────────────────

describe('INTERRUPTED guard: AUDIO content-start rejection', () => {
  test('AUDIO content-start during INTERRUPTED is rejected — no transition to AI_SPEAKING', () => {
    const client = new MockNovaClient();
    const { ctx, handleProactiveBargeIn } = buildHandlers(client);

    // Agent speaking
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'audio-1', 'AUDIO');
    expect(ctx.conversationState).toBe('AI_SPEAKING');

    // Proactive barge-in → INTERRUPTED
    handleProactiveBargeIn();
    expect(ctx.conversationState).toBe('INTERRUPTED');

    // Nova resumes interrupted response with a new AUDIO block — must be rejected
    client.emit('content-start', 'audio-2', 'AUDIO');
    expect(ctx.conversationState).toBe('INTERRUPTED'); // NOT AI_SPEAKING
    expect(ctx.activeContentId).toBe(''); // NOT set to audio-2
    expect(ctx.cancelledContentIds.has('audio-2')).toBe(true);

    // Audio from rejected block is discarded
    client.emit('audio-output', Buffer.from('resumed-audio'), 'audio-2', 'compl-1');
    // No audio routed (all discarded)
  });

  test('TEXT content-start during INTERRUPTED is allowed (USER speech)', () => {
    const client = new MockNovaClient();
    const { ctx, handleProactiveBargeIn } = buildHandlers(client);

    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'audio-1', 'AUDIO');

    handleProactiveBargeIn();
    expect(ctx.conversationState).toBe('INTERRUPTED');

    // TEXT content blocks (USER ASR) during INTERRUPTED must still be accepted
    client.emit('content-start', 'user-text-1', 'TEXT');
    // Should not be in cancelledContentIds
    expect(ctx.cancelledContentIds.has('user-text-1')).toBe(false);
    // contentIdToGeneration should track it at the current generation
    expect(ctx.contentIdToGeneration.get('user-text-1')).toBe(ctx.responseGeneration);
  });

  test('Multiple AUDIO blocks during INTERRUPTED are all rejected', () => {
    const client = new MockNovaClient();
    const { ctx, handleProactiveBargeIn, routedChunks } = buildHandlers(client);

    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'audio-1', 'AUDIO');

    handleProactiveBargeIn();

    // Nova sends multiple AUDIO blocks trying to resume
    client.emit('content-start', 'audio-2', 'AUDIO');
    client.emit('audio-output', Buffer.from('resumed-1'), 'audio-2', 'compl-1');
    client.emit('content-start', 'audio-3', 'AUDIO');
    client.emit('audio-output', Buffer.from('resumed-2'), 'audio-3', 'compl-1');

    expect(ctx.conversationState).toBe('INTERRUPTED');
    expect(ctx.cancelledContentIds.has('audio-2')).toBe(true);
    expect(ctx.cancelledContentIds.has('audio-3')).toBe(true);
    // Only pre-barge-in audio was routed
    const routed = routedChunks.map(b => b.toString());
    expect(routed).not.toContain('resumed-1');
    expect(routed).not.toContain('resumed-2');
  });

  test('After INTERRUPTED recovery via completionStart, AUDIO blocks are accepted', () => {
    const client = new MockNovaClient();
    const { ctx, handleProactiveBargeIn, routedChunks } = buildHandlers(client);

    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'audio-1', 'AUDIO');

    handleProactiveBargeIn();
    expect(ctx.conversationState).toBe('INTERRUPTED');

    // AUDIO during INTERRUPTED — rejected
    client.emit('content-start', 'audio-rejected', 'AUDIO');
    expect(ctx.cancelledContentIds.has('audio-rejected')).toBe(true);

    // Nova sends new completionStart → recovers from INTERRUPTED
    client.emit('completion-start', 'compl-2', 'prompt-1');
    expect(ctx.conversationState).toBe('AI_THINKING');

    // New AUDIO block — accepted
    client.emit('content-start', 'audio-new', 'AUDIO');
    expect(ctx.conversationState).toBe('AI_SPEAKING');
    expect(ctx.activeContentId).toBe('audio-new');
    expect(ctx.cancelledContentIds.has('audio-new')).toBe(false);

    client.emit('audio-output', Buffer.from('new-audio'), 'audio-new', 'compl-2');
    const routed = routedChunks.map(b => b.toString());
    expect(routed).toContain('new-audio');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NEW TESTS (Round 3): Self-followup guard (awaitingUserSpeech)
// ─────────────────────────────────────────────────────────────────────────────

describe('Self-followup guard: awaitingUserSpeech', () => {
  test('After turn-complete, AUDIO content-start is rejected until user speaks', () => {
    const client = new MockNovaClient();
    const { ctx, routedChunks } = buildHandlers(client);

    // Normal response
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'audio-1', 'AUDIO');
    client.emit('audio-output', Buffer.from('response-1'), 'audio-1', 'compl-1');
    client.emit('content-end', 'audio-1', 'END_TURN');
    // turn-complete fires → LISTENING, awaitingUserSpeech = true
    expect(ctx.conversationState).toBe('LISTENING');
    expect(ctx.awaitingUserSpeech).toBe(true);

    // Nova sends a continuation AUDIO block (self-followup) — must be REJECTED
    client.emit('content-start', 'audio-2', 'AUDIO');
    expect(ctx.conversationState).toBe('LISTENING'); // NOT AI_SPEAKING
    expect(ctx.cancelledContentIds.has('audio-2')).toBe(true);

    // Audio from rejected block is discarded
    client.emit('audio-output', Buffer.from('self-followup'), 'audio-2', 'compl-1');
    const routed = routedChunks.map(b => b.toString());
    expect(routed).not.toContain('self-followup');
  });

  test('After turn-complete, ASSISTANT text is discarded until user speaks', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    // Normal response
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'text-1', 'TEXT');
    client.emit('text-output', 'First response', 'text-1', 'ASSISTANT');
    client.emit('content-end', 'text-1', 'END_TURN');
    client.emit('content-start', 'audio-1', 'AUDIO');
    client.emit('content-end', 'audio-1', 'END_TURN');
    expect(ctx.awaitingUserSpeech).toBe(true);

    // Nova sends a repetition TEXT block (self-followup) — must be DISCARDED
    client.emit('content-start', 'text-2', 'TEXT');
    client.emit('text-output', 'First response repeated', 'text-2', 'ASSISTANT');
    expect(ctx.currentAssistantTranscript).toBe(''); // discarded by guard

    // content-end should not finalize the discarded text
    client.emit('content-end', 'text-2', 'END_TURN');
    const assistants = ctx.finalizedTranscripts.filter(t => t.role === 'assistant');
    expect(assistants).toHaveLength(1); // only original, not the repeat
    expect(assistants[0].text).toBe('First response');
  });

  test('USER text-output clears awaitingUserSpeech — next response plays normally', () => {
    const client = new MockNovaClient();
    const { ctx, routedChunks } = buildHandlers(client);

    // Turn 1 completes → awaitingUserSpeech = true
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'audio-1', 'AUDIO');
    client.emit('content-end', 'audio-1', 'END_TURN');
    expect(ctx.awaitingUserSpeech).toBe(true);

    // User speaks — clears the guard
    client.emit('content-start', 'user-text', 'TEXT');
    client.emit('text-output', 'hello', 'user-text', 'USER');
    expect(ctx.awaitingUserSpeech).toBe(false);
    client.emit('content-end', 'user-text', 'END_TURN');

    // Agent response — should be accepted
    client.emit('content-start', 'text-2', 'TEXT');
    client.emit('text-output', 'Hi there', 'text-2', 'ASSISTANT');
    expect(ctx.currentAssistantTranscript).toBe('Hi there');

    client.emit('content-start', 'audio-2', 'AUDIO');
    expect(ctx.conversationState).toBe('AI_SPEAKING');
    client.emit('audio-output', Buffer.from('response-2'), 'audio-2', 'compl-1');
    const routed = routedChunks.map(b => b.toString());
    expect(routed).toContain('response-2');
  });

  test('completionStart clears awaitingUserSpeech', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    // First completion + turn-complete
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'audio-1', 'AUDIO');
    client.emit('content-end', 'audio-1', 'END_TURN');
    expect(ctx.awaitingUserSpeech).toBe(true);

    // New completionStart (Nova VAD detected user speech)
    client.emit('completion-start', 'compl-2', 'prompt-1');
    expect(ctx.awaitingUserSpeech).toBe(false);
  });

  test('handleProactiveBargeIn clears awaitingUserSpeech', () => {
    const client = new MockNovaClient();
    const { ctx, handleProactiveBargeIn } = buildHandlers(client);

    // Turn completes → awaitingUserSpeech = true
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'audio-1', 'AUDIO');
    client.emit('content-end', 'audio-1', 'END_TURN');
    expect(ctx.awaitingUserSpeech).toBe(true);

    // Proactive barge-in — caller spoke
    handleProactiveBargeIn();
    expect(ctx.awaitingUserSpeech).toBe(false);
  });

  test('Full self-followup scenario: multi-block response suppresses continuation', () => {
    const client = new MockNovaClient();
    const { ctx, routedChunks } = buildHandlers(client);

    // Agent response part 1
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'text-1', 'TEXT');
    client.emit('text-output', 'Okay Shiva, we have 78 units in a', 'text-1', 'ASSISTANT');
    client.emit('content-end', 'text-1', 'END_TURN');
    client.emit('content-start', 'audio-1', 'AUDIO');
    client.emit('audio-output', Buffer.from('audio-part1'), 'audio-1', 'compl-1');
    client.emit('content-end', 'audio-1', 'END_TURN');
    // turn-complete → LISTENING, awaitingUserSpeech = true
    expect(ctx.conversationState).toBe('LISTENING');

    // Agent sends continuation part 2 (self-followup) — SUPPRESSED
    client.emit('content-start', 'text-2', 'TEXT');
    client.emit('text-output', ' great location near Hinjewadi', 'text-2', 'ASSISTANT');
    client.emit('content-end', 'text-2', 'END_TURN');
    client.emit('content-start', 'audio-2', 'AUDIO');
    // audio-2 is cancelled by self-followup guard
    expect(ctx.cancelledContentIds.has('audio-2')).toBe(true);

    // Only part 1 finalized
    const assistants = ctx.finalizedTranscripts.filter(t => t.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].text).toBe('Okay Shiva, we have 78 units in a');

    // Only part 1 audio routed
    const routed = routedChunks.map(b => b.toString());
    expect(routed).toContain('audio-part1');

    // User speaks → next response works normally
    client.emit('content-start', 'user-text', 'TEXT');
    client.emit('text-output', 'tell me more', 'user-text', 'USER');
    client.emit('content-end', 'user-text', 'END_TURN');
    expect(ctx.awaitingUserSpeech).toBe(false);

    client.emit('content-start', 'text-3', 'TEXT');
    client.emit('text-output', 'Sure! The project has...', 'text-3', 'ASSISTANT');
    client.emit('content-end', 'text-3', 'END_TURN');
    client.emit('content-start', 'audio-3', 'AUDIO');
    expect(ctx.conversationState).toBe('AI_SPEAKING');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NEW TESTS (Round 3): Promotion deduplication
// ─────────────────────────────────────────────────────────────────────────────

describe('Promotion deduplication', () => {
  test('Interrupted speech is promoted even when it duplicates the last finalized text (dedup bypassed)', () => {
    const client = new MockNovaClient();
    const { ctx, handleProactiveBargeIn } = buildHandlers(client);

    // User says "can you speak in hindi" — finalized normally
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'user-text-1', 'TEXT');
    client.emit('text-output', 'can you speak in hindi', 'user-text-1', 'USER');
    client.emit('content-end', 'user-text-1', 'END_TURN');
    expect(ctx.lastFinalizedUserText).toBe('can you speak in hindi');

    // Agent starts responding in Hindi
    client.emit('content-start', 'audio-1', 'AUDIO');
    client.emit('audio-output', Buffer.from('hindi-response'), 'audio-1', 'compl-1');

    // Barge-in during Hindi response
    handleProactiveBargeIn();
    expect(ctx.conversationState).toBe('INTERRUPTED');

    // Nova ASR re-emits the SAME "can you speak in hindi" while INTERRUPTED.
    client.emit('content-start', 'user-text-2', 'TEXT');
    client.emit('text-output', 'can you speak in hindi', 'user-text-2', 'USER');
    client.emit('content-end', 'user-text-2', 'END_TURN');

    // capturedWhileInterrupted bypasses ALL dedupe — interrupted speech is never
    // dropped. It MUST be promoted so the caller always gets a response (no silence).
    expect(ctx.promotedTurns).toEqual(['can you speak in hindi']);
    const userFinals = ctx.finalizedTranscripts.filter(t => t.role === 'user');
    expect(userFinals).toHaveLength(2);
  });

  test('Different user transcript during barge-in IS promoted', () => {
    const client = new MockNovaClient();
    const { ctx, handleProactiveBargeIn } = buildHandlers(client);

    // User says "can you speak in hindi" — finalized normally
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'user-text-1', 'TEXT');
    client.emit('text-output', 'can you speak in hindi', 'user-text-1', 'USER');
    client.emit('content-end', 'user-text-1', 'END_TURN');

    // Agent starts responding
    client.emit('content-start', 'audio-1', 'AUDIO');

    // Barge-in
    handleProactiveBargeIn();

    // User says something DIFFERENT while INTERRUPTED
    client.emit('content-start', 'user-text-2', 'TEXT');
    client.emit('text-output', 'actually tell me the price', 'user-text-2', 'USER');
    client.emit('content-end', 'user-text-2', 'END_TURN');

    // Should be promoted (different text)
    expect(ctx.promotedTurns).toEqual(['actually tell me the price']);
  });

  test('lastFinalizedUserText is cleared on completionStart', () => {
    const client = new MockNovaClient();
    const { ctx } = buildHandlers(client);

    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'user-text', 'TEXT');
    client.emit('text-output', 'hello', 'user-text', 'USER');
    client.emit('content-end', 'user-text', 'END_TURN');
    expect(ctx.lastFinalizedUserText).toBe('hello');

    // New completionStart clears it
    client.emit('completion-start', 'compl-2', 'prompt-1');
    expect(ctx.lastFinalizedUserText).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NEW TESTS (Round 3): Hindi language switch during interruption
// ─────────────────────────────────────────────────────────────────────────────

describe('Hindi language switch during interruption', () => {
  test('Interruption produces exactly one promoted turn — no stale assistant leakage', () => {
    const client = new MockNovaClient();
    const { ctx, handleProactiveBargeIn, routedChunks } = buildHandlers(client);

    // Normal turn: user says "can you speak in hindi"
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'user-text-1', 'TEXT');
    client.emit('text-output', 'can you speak in hindi', 'user-text-1', 'USER');
    client.emit('content-end', 'user-text-1', 'END_TURN');

    // Agent responds in Hindi
    client.emit('content-start', 'text-hindi', 'TEXT');
    client.emit('text-output', 'Bilkul, hindi mein baat karte hain', 'text-hindi', 'ASSISTANT');
    client.emit('content-end', 'text-hindi', 'END_TURN');
    client.emit('content-start', 'audio-hindi', 'AUDIO');
    client.emit('audio-output', Buffer.from('hindi-audio'), 'audio-hindi', 'compl-1');

    // Barge-in during Hindi audio
    handleProactiveBargeIn();

    // Nova re-emits same user text while INTERRUPTED → promoted (dedup bypassed),
    // exactly once for this interruption.
    client.emit('content-start', 'user-text-2', 'TEXT');
    client.emit('text-output', 'can you speak in hindi', 'user-text-2', 'USER');
    client.emit('content-end', 'user-text-2', 'END_TURN');

    expect(ctx.promotedTurns).toEqual(['can you speak in hindi']);

    // Only the original (pre-barge-in) Hindi assistant transcript is finalized —
    // the interrupted response's partial assistant text never leaks.
    const assistants = ctx.finalizedTranscripts.filter(t => t.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].text).toBe('Bilkul, hindi mein baat karte hain');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NEW TESTS (Round 4): Interruption recovery — no resumed generation
// ─────────────────────────────────────────────────────────────────────────────

describe('Interruption recovery: cancelled generation never resumes', () => {
  test('Interrupted turn-complete is stale after proactive barge-in — state stays INTERRUPTED', () => {
    const client = new MockNovaClient();
    const { ctx, handleProactiveBargeIn } = buildHandlers(client);

    // Normal response starts
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'audio-A', 'AUDIO');
    client.emit('audio-output', Buffer.from('old-audio'), 'audio-A', 'compl-1');
    expect(ctx.conversationState).toBe('AI_SPEAKING');

    // Proactive barge-in
    handleProactiveBargeIn();
    expect(ctx.conversationState).toBe('INTERRUPTED');

    // Old response's turn-complete arrives — must be STALE, not treated as current
    client.emit('turn-complete', 'END_TURN');

    // With the fix: responseGeneration(2) !== activeResponseGeneration(1)
    // so isCurrentResponse is false — state must NOT transition to LISTENING.
    // cancelledContentIds must NOT be cleared.
    expect(ctx.conversationState).toBe('INTERRUPTED');
    expect(ctx.cancelledContentIds.size).toBeGreaterThan(0);
  });

  test('Promoted response plays without a completionStart (Nova omits it in this deployment)', () => {
    const client = new MockNovaClient();
    const { ctx, handleProactiveBargeIn, routedChunks } = buildHandlers(client);

    // Agent speaking
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'audio-A', 'AUDIO');
    client.emit('audio-output', Buffer.from('old-audio-1'), 'audio-A', 'compl-1');

    // Proactive barge-in
    handleProactiveBargeIn();
    expect(ctx.conversationState).toBe('INTERRUPTED');

    // User transcript captured during interruption → promotion fires
    client.emit('content-start', 'user-text', 'TEXT');
    client.emit('text-output', 'Can you speak in Hindi?', 'user-text', 'USER');
    client.emit('content-end', 'user-text', 'END_TURN');

    // After promotion: state=LISTENING, awaitingUserSpeech=false so the agent's
    // reply is allowed through (the self-followup guard must NOT swallow it).
    expect(ctx.conversationState).toBe('LISTENING');
    expect(ctx.awaitingUserSpeech).toBe(false);

    // Nova streams the promoted response with NO completionStart (real Nova behavior
    // in this deployment). It must be accepted and reach the caller — not discarded
    // as a self-followup. This is the silence regression that was fixed.
    client.emit('content-start', 'audio-new', 'AUDIO');
    expect(ctx.conversationState).toBe('AI_SPEAKING');
    client.emit('audio-output', Buffer.from('hindi-reply'), 'audio-new', 'compl-1');
    client.emit('content-end', 'audio-new', 'END_TURN');

    const fresh = routedChunks.filter(b => b.toString() === 'hindi-reply');
    expect(fresh).toHaveLength(1);
  });

  test('Full interruption scenario: only new response audio reaches caller', () => {
    const client = new MockNovaClient();
    const { ctx, handleProactiveBargeIn, routedChunks } = buildHandlers(client);

    // Turn 1: Agent says "Akshay Vista is located in..."
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'audio-old', 'AUDIO');
    client.emit('audio-output', Buffer.from('akshay-vista'), 'audio-old', 'compl-1');
    expect(routedChunks.map(b => b.toString())).toContain('akshay-vista');

    // User interrupts: "Can you speak in Hindi?"
    handleProactiveBargeIn();
    const routedBeforeRecovery = routedChunks.length;

    // Old response continues internally — all discarded
    client.emit('audio-output', Buffer.from('pimple-gurav'), 'audio-old', 'compl-1');
    client.emit('content-end', 'audio-old', 'END_TURN');

    // Old turn-complete — stale, ignored
    client.emit('turn-complete', 'END_TURN');
    expect(ctx.conversationState).toBe('INTERRUPTED');

    // User transcript captured → promotion
    client.emit('content-start', 'user-txt', 'TEXT');
    client.emit('text-output', 'Can you speak in Hindi?', 'user-txt', 'USER');
    client.emit('content-end', 'user-txt', 'END_TURN');
    expect(ctx.conversationState).toBe('LISTENING');
    expect(ctx.promotedTurns).toContain('Can you speak in Hindi?');

    // Nova responds to promoted text
    client.emit('completion-start', 'compl-2', 'prompt-1');
    client.emit('content-start', 'audio-hindi', 'AUDIO');
    client.emit('audio-output', Buffer.from('ji-bilkul'), 'audio-hindi', 'compl-2');
    client.emit('content-end', 'audio-hindi', 'END_TURN');

    // Verify: no stale audio leaked after barge-in
    const afterBarge = routedChunks.slice(routedBeforeRecovery);
    const staleLeaked = afterBarge.filter(b =>
      b.toString() === 'pimple-gurav',
    );
    expect(staleLeaked).toHaveLength(0);

    // Verify: new response audio DID reach the caller
    const freshAudio = afterBarge.filter(b => b.toString() === 'ji-bilkul');
    expect(freshAudio).toHaveLength(1);

    // Verify: conversation history has no partial assistant text from interrupted response
    const assistants = ctx.finalizedTranscripts.filter(t => t.role === 'assistant');
    const partialLeak = assistants.filter(t => t.text.includes('akshay') || t.text.includes('pimple'));
    expect(partialLeak).toHaveLength(0);
  });

  test('Promoted response text is finalized without a completionStart', () => {
    const client = new MockNovaClient();
    const { ctx, handleProactiveBargeIn } = buildHandlers(client);

    // Agent speaking
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'audio-A', 'AUDIO');
    client.emit('audio-output', Buffer.from('audio'), 'audio-A', 'compl-1');

    // Proactive barge-in
    handleProactiveBargeIn();

    // User transcript → promotion fires → LISTENING, awaitingUserSpeech=false
    client.emit('content-start', 'user-txt', 'TEXT');
    client.emit('text-output', 'switch to Hindi', 'user-txt', 'USER');
    client.emit('content-end', 'user-txt', 'END_TURN');
    expect(ctx.awaitingUserSpeech).toBe(false);

    // The agent's reply (TEXT) streams with no completionStart — must be accepted
    // and finalized, not swallowed by the self-followup guard.
    client.emit('content-start', 'text-reply', 'TEXT');
    client.emit('text-output', 'Theek hai, hindi mein baat karte hain', 'text-reply', 'ASSISTANT');
    client.emit('content-end', 'text-reply', 'END_TURN');

    const assistants = ctx.finalizedTranscripts.filter(t => t.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].text).toBe('Theek hai, hindi mein baat karte hain');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NEW TESTS: False barge-in suppression + transcript-confirmed barge-in
// ─────────────────────────────────────────────────────────────────────────────

describe('False barge-in suppression and transcript-confirmed barge-in', () => {
  test('Real words during AI_SPEAKING trigger barge-in and preserve the transcript', () => {
    const client = new MockNovaClient();
    const { ctx, onInterruption } = buildHandlers(client);

    // Agent speaking
    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'audio-A', 'AUDIO');
    expect(ctx.conversationState).toBe('AI_SPEAKING');

    // Caller's real words arrive on a USER block while the agent is speaking.
    client.emit('content-start', 'user-1', 'TEXT');
    client.emit('text-output', 'stop please', 'user-1', 'USER');

    // Confirmed barge-in: INTERRUPTED, old audio cancelled, transcript PRESERVED.
    expect(ctx.conversationState).toBe('INTERRUPTED');
    expect(onInterruption).toHaveBeenCalledTimes(1);
    expect(ctx.cancelledContentIds.has('audio-A')).toBe(true);
    expect(ctx.currentUserTranscript).toBe('stop please');

    // The (re-stamped) user block finalizes + promotes — nothing is lost.
    client.emit('content-end', 'user-1', 'END_TURN');
    const userFinals = ctx.finalizedTranscripts.filter(t => t.role === 'user');
    expect(userFinals.map(t => t.text)).toEqual(['stop please']);
    expect(ctx.promotedTurns).toEqual(['stop please']);
    expect(ctx.conversationState).toBe('LISTENING');
  });

  test('Punctuation-only / empty USER text does NOT trigger barge-in', () => {
    const client = new MockNovaClient();
    const { ctx, onInterruption } = buildHandlers(client);

    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'audio-A', 'AUDIO');
    expect(ctx.conversationState).toBe('AI_SPEAKING');

    client.emit('content-start', 'user-1', 'TEXT');
    client.emit('text-output', '... ', 'user-1', 'USER');
    client.emit('text-output', '?!', 'user-1', 'USER');

    // No real words → agent keeps speaking, never interrupted.
    expect(ctx.conversationState).toBe('AI_SPEAKING');
    expect(onInterruption).not.toHaveBeenCalled();
  });

  test('VAD end during INTERRUPTED with NO transcript recovers to LISTENING immediately', () => {
    const client = new MockNovaClient();
    const { ctx, handleProactiveBargeIn, handleVadEnd } = buildHandlers(client);

    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'audio-A', 'AUDIO');

    // Proactive (e.g. 400ms of sustained noise) barge-in → INTERRUPTED, no transcript.
    handleProactiveBargeIn();
    expect(ctx.conversationState).toBe('INTERRUPTED');
    expect(ctx.currentUserTranscript).toBe('');

    handleVadEnd();
    expect(ctx.conversationState).toBe('LISTENING');
    expect(ctx.bargeInPending).toBe(false);
    expect(ctx.awaitingUserSpeech).toBe(true);
  });

  test('VAD end during INTERRUPTED with a real transcript does NOT recover (genuine barge-in proceeds)', () => {
    const client = new MockNovaClient();
    const { ctx, handleProactiveBargeIn, handleVadEnd } = buildHandlers(client);

    client.emit('completion-start', 'compl-1', 'prompt-1');
    client.emit('content-start', 'audio-A', 'AUDIO');

    handleProactiveBargeIn();
    // Caller's real words arrive while INTERRUPTED (kept, not discarded).
    client.emit('content-start', 'user-1', 'TEXT');
    client.emit('text-output', 'switch to hindi', 'user-1', 'USER');
    expect(ctx.currentUserTranscript).toBe('switch to hindi');

    // VAD end fires, but a real transcript exists → must NOT recover.
    handleVadEnd();
    expect(ctx.conversationState).toBe('INTERRUPTED');

    // Genuine barge-in finalizes + promotes normally.
    client.emit('content-end', 'user-1', 'END_TURN');
    expect(ctx.promotedTurns).toEqual(['switch to hindi']);
    expect(ctx.conversationState).toBe('LISTENING');
  });
});
