/**
 * CallOrchestrator: per-call pipeline controller.
 *
 * Wires together:
 *   Twilio (audio I/O)
 *     ↓ raw PCMU
 *   Deepgram (STT, VAD, barge-in signal)
 *     ↓ final transcript
 *   Bedrock Claude (LLM, streaming)
 *     ↓ streamed text
 *   ElevenLabs Flash v2.5 (TTS, streaming)
 *     ↓ ulaw_8000 audio (same format as Twilio, no conversion)
 *   Twilio
 *
 * State machine:
 *   IDLE → LISTENING → GENERATING → SPEAKING → (INTERRUPTED →) LISTENING
 *
 * Barge-in flow:
 *   1. Deepgram VAD fires `SpeechStarted` while state === SPEAKING
 *   2. BargeInDetector confirms via VAD path (RMS path disabled — PSTN echo)
 *   3. ElevenLabs stream aborted, generation AbortController signalled
 *   4. Twilio `clear` sent (flushes Twilio's jitter buffer)
 *   5. Partial assistant message discarded from history
 *   6. State → LISTENING; Deepgram continues collecting the utterance
 *   7. Final transcript → fresh LLM call
 */

import { DeepgramSTT } from '../stt/DeepgramSTT';
import { BedrockLLM }  from '../llm/BedrockLLM';
import { ElevenLabsTTS } from '../tts/ElevenLabsTTS';
import { SarvamTTS } from '../tts/SarvamTTS';
import { hasGreetingAudio, getGreetingChunks } from '../tts/GreetingCache';
import { BargeInDetector } from '../interruption/BargeInDetector';
import { ConversationManager } from '../llm/ConversationManager';
import { LatencyTracker } from '../metrics/LatencyTracker';
import { TwilioService } from '../telephony/TwilioService';
import { globalToolRegistry } from '../tools/ToolRegistry';
import { Env } from '../config/env';
import { Logger, closeCallLogger } from '../shared/logger';
import type { StreamEvent } from '../llm/types';

type CallState =
  | 'IDLE'
  | 'LISTENING'     // Deepgram active, waiting for speech
  | 'GENERATING'    // LLM is generating a response
  | 'SPEAKING'      // ElevenLabs is streaming audio to Twilio
  | 'INTERRUPTED'   // Barge-in fired, cancelling current output
  | 'ENDED';

export class CallOrchestrator {
  private state: CallState = 'IDLE';

  private readonly callSid: string;
  private readonly twilioService: TwilioService;
  private readonly stt: DeepgramSTT;
  private readonly llm: BedrockLLM;
  private readonly conversation: ConversationManager;
  private readonly latency: LatencyTracker;
  private readonly bargeIn: BargeInDetector;
  private readonly log: Logger;

  /** Bumped on every new LLM generation; used to discard stale audio. */
  private generationId = 0;

  /**
   * Timestamp when the call started.
   * Audio frames in the first CALL_START_AUDIO_DROP_MS are discarded to
   * avoid flooding Deepgram/barge-in with Twilio ring-down connection noise.
   */
  private readonly callStartAt = Date.now();
  private readonly CALL_START_AUDIO_DROP_MS = 500;

  /** AbortController for the active LLM + TTS generation. */
  private abortController: AbortController | null = null;

  /**
   * Persistent TTS WS — opened once at call start and reused for every turn.
   * Provider selected by TTS_PROVIDER env var (elevenlabs | sarvam).
   */
  private readonly tts: ElevenLabsTTS | SarvamTTS;

  /** Tracks the full text accumulated so far in the active generation. */
  private activeResponseText = '';

  /**
   * When true, the active generation should NOT arm the barge-in detector
   * on first TTS audio (e.g. during greeting, or if caller set suppressBargeIn).
   */
  private suppressBargeInArm = false;

  // ─── Noise / False VAD Suppression ──────────────────────────────────────

  /** Timestamp when TTS last finished playing — used to suppress PSTN echo VAD. */
  private lastTTSCompleteAt = 0;

  /** Ignore VAD events for this long after TTS ends (PSTN echo dies down).
   *  1500ms: PSTN echo of TTS audio sustains at ~1-1.3s on most calls. */
  private readonly POST_TTS_VAD_SUPPRESS_MS = 1500;

  /**
   * Tracks how many consecutive SpeechStarted events had no real transcript.
   * Incremented when a new SpeechStarted fires and the previous one never
   * produced a transcript. Reset to 0 when a real transcript arrives.
   */
  private consecutiveEmptyVADs = 0;

  /** Suppress TTS pre-warming after this many consecutive empty VAD cycles. */
  private readonly MAX_EMPTY_VADS_FOR_PREWARM = 2;

  /** Timestamp of the last SpeechStarted event. */
  private lastVADAt = 0;

  /** Timestamp of the last real transcript received. */
  private lastTranscriptAt = 0;

  // ─── No-Speech Recovery (dead-air prevention) ───────────────────────────
  // When Deepgram repeatedly fails to decode the caller's speech (VAD fires,
  // utterance ends, zero words), re-prompt instead of sitting silent.

  /** Consecutive empty speech_final events while LISTENING. */
  private emptyFinalStreak = 0;
  private lastRepromptAt = 0;
  private repromptCount = 0;
  private readonly EMPTY_FINALS_BEFORE_REPROMPT = 2;
  private readonly REPROMPT_MIN_GAP_MS = 8000;
  private readonly MAX_REPROMPTS_PER_CALL = 3;
  private readonly REPROMPT_TEXT = "Hello? आपकी आवाज़ नहीं आ रही, क्या आप सुन रहे हैं?";

  // ─── Silence Timer (dead-air after agent finishes speaking) ────────────
  /** Timer that fires if caller is silent for SILENCE_TIMEOUT_MS after agent speaks. */
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly SILENCE_TIMEOUT_MS = 7000;

  // ─── Playback Duration Tracking ──────────────────────────────────────
  // ElevenLabs generates all audio in ~200ms but Twilio plays it over 3-5s.
  // We must keep barge-in armed and state=SPEAKING for the full playback.

  /** Total raw audio bytes sent to Twilio in the current generation. */
  private ttsAudioBytesSent = 0;

  /** Timestamp when first TTS audio chunk was sent to Twilio. */
  private firstTTSAudioSentAt = 0;

  /** Timer that transitions SPEAKING→LISTENING after estimated playback completes. */
  private playbackCompleteTimer: ReturnType<typeof setTimeout> | null = null;

  /** Whether TTS generation is done (all chunks received from ElevenLabs). */
  private ttsGenerationDone = false;

  constructor(callSid: string, twilioService: TwilioService) {
    this.callSid        = callSid;
    this.twilioService  = twilioService;
    this.stt            = new DeepgramSTT(callSid);
    this.tts            = Env.ttsProvider === 'sarvam'
                            ? new SarvamTTS(callSid)
                            : new ElevenLabsTTS(callSid);
    this.llm            = new BedrockLLM(callSid, globalToolRegistry);
    this.conversation   = new ConversationManager(callSid);
    this.latency        = new LatencyTracker(callSid);
    this.bargeIn        = new BargeInDetector(callSid);
    this.log            = Logger.forCall(callSid, 'CallOrchestrator');
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    this.log.info('Call orchestrator starting');
    this.latency.mark('call_start');
    this.state = 'LISTENING';

    // Wire STT events
    this.stt
      .onSpeech(()               => this.handleSpeechStarted())
      .onInterim((text)          => this.handleInterimTranscript(text))
      .onTranscript((text, conf) => this.handleFinalTranscript(text, conf))
      .onNoSpeech(()             => this.handleNoSpeech())
      .onErr((err)               => this.log.error('STT error', err));

    // Wire barge-in detector
    this.bargeIn.onInterruption(() => this.handleInterruption());

    // Wire the persistent TTS once — context ids encode the generation id
    // ("g{n}"), so stale-context audio is dropped by the genId guard.
    this.tts
      .onAudio((audio, ctxId) => this.handleTTSAudio(audio, this.genIdFromContext(ctxId)))
      .onDone((ctxId)         => this.handleTTSDone(this.genIdFromContext(ctxId)))
      .onError((err)          => this.log.error('TTS error', err));

    this.stt.connect();
    void this.tts.open().catch(() => { /* logged inside TTS provider */ });
    this.log.info('Call orchestrator ready', { state: this.state });

    // Fixed greeting via TTS — no LLM needed. Reliable and fast.
    this.speakCanned('Hi, मैं Arjun बोल रहा हूँ Akshay Vista से। क्या मैं आपका नाम जान सकता हूँ?');
  }

  /**
   * Stream pre-recorded greeting audio directly to Twilio — zero LLM/TTS latency.
   * While audio plays (~3s), pre-warm ElevenLabs so the first real response is fast.
   */
  private sendCachedGreeting(): void {
    const chunks = getGreetingChunks();
    this.log.info('Playing pre-recorded greeting', { chunks: chunks.length });
    this.latency.mark('greeting_start');
    this.state = 'SPEAKING';
    this.suppressBargeInArm = true; // No barge-in during greeting

    // Stream all chunks to Twilio immediately — Twilio buffers and plays in order
    for (const chunk of chunks) {
      this.twilioService.sendAudio(this.callSid, chunk);
    }
    this.log.info('Pre-recorded greeting sent to Twilio');

    // Pre-warm TTS connection while greeting plays — hides ~300-500ms
    this.prewarmTTS();

    // Greeting is ~3-4s of audio. Estimate playback duration and transition to LISTENING.
    // 160 bytes per chunk at 8kHz = 20ms per chunk.
    const playbackMs = chunks.length * 20;
    setTimeout(() => {
      if (this.state === 'SPEAKING' || this.state === 'IDLE') {
        this.state = 'LISTENING';
        this.lastTTSCompleteAt = Date.now();
        this.log.info('Greeting playback complete, now LISTENING', { playbackMs });
      }
    }, playbackMs);
  }

  /**
   * Fallback: generate greeting via LLM + TTS when no pre-recorded audio exists.
   */
  private async sendLLMGreeting(): Promise<void> {
    this.log.info('Sending LLM-generated greeting (no cached audio)');
    this.conversation.addUserMessage(Env.llm.greetingPrompt);
    this.state = 'GENERATING';
    await this.generateAndSpeak({ suppressBargeIn: true });
    this.conversation.discardGreetingTurn();
  }

  /** Called for every inbound audio frame from Twilio. */
  handleInboundAudio(audioBase64: string): void {
    if (this.state === 'ENDED') return;

    // Drop first 500ms of audio — Twilio call-connect ring-down noise is
    // extremely loud (RMS ~30000) and would flood Deepgram with garbage.
    if (Date.now() - this.callStartAt < this.CALL_START_AUDIO_DROP_MS) return;

    const pcmu = Buffer.from(audioBase64, 'base64');

    // RMS energy barge-in path intentionally disabled.
    // On PSTN calls the speaker echo of Arjun's TTS sustains at RMS ~31000-32000
    // for the entire TTS playback duration, indistinguishable from real speech.
    // No grace period value eliminates this — it just shifts when the false trigger
    // fires. Deepgram VAD (handleSpeechStarted) is the sole barge-in path.

    // Forward raw PCMU to Deepgram — no codec conversion needed.
    this.stt.sendAudio(pcmu);
  }

  async end(): Promise<void> {
    if (this.state === 'ENDED') return;
    this.state = 'ENDED';

    this.log.info('Call ending');
    this.latency.mark('call_end');

    this.bargeIn.disarm();

    // Cancel timers
    if (this.playbackCompleteTimer) {
      clearTimeout(this.playbackCompleteTimer);
      this.playbackCompleteTimer = null;
    }
    this.clearSilenceTimer();

    // Abort any active generation
    this.abortController?.abort();

    // Close the persistent TTS socket for good
    this.tts.destroy();

    // Finalize STT (flushes any pending transcript) then close immediately
    this.stt.finalize();
    this.stt.close();

    this.latency.logCallSummary();
    this.log.info('Call orchestrator ended');

    // Flush and close the per-call log file
    closeCallLogger(this.callSid);
  }

  // ─── TTS Prewarming ───────────────────────────────────────────────────────

  /**
   * Ensure the persistent ElevenLabs socket is connected. With the
   * multi-context WS this is a no-op when already open; after an
   * unexpected close it kicks off the background reconnect.
   */
  private prewarmTTS(): void {
    if (this.tts.isActive) return;
    this.latency.mark('tts_prewarm_start');
    this.tts.open().then(() => {
      this.latency.mark('tts_open');
      this.log.info('TTS reconnected (was closed)');
    }).catch((err: Error) => {
      this.log.warn('TTS reconnect failed', { error: err.message });
    });
  }

  // ─── VAD / Speech Events ──────────────────────────────────────────────────

  private handleSpeechStarted(): void {
    const now = Date.now();

    // ── SPEAKING/GENERATING: log VAD but do NOT fire barge-in ───────────
    // NOTE: We intentionally do NOT update consecutiveEmptyVADs or lastVADAt
    // during SPEAKING — those VADs are PSTN echo of our own TTS audio, not
    // ambient noise. Counting them inflates the noise counter and blocks
    // TTS pre-warming when the user speaks next in LISTENING state.
    // On PSTN, background noise and echo produce VAD events that are
    // indistinguishable from real speech. Firing barge-in on a single VAD
    // causes false interruptions — the agent stops mid-sentence for noise.
    //
    // Instead, barge-in during SPEAKING is TRANSCRIPT-GATED:
    //   - VAD fires here → logged only (no bargeIn.handleSpeechStarted)
    //   - If it was real speech → Deepgram produces a transcript in ~300-500ms
    //   - handleFinalTranscript() detects state=SPEAKING and calls
    //     handleInterruption() — this is the actual barge-in path.
    //   - If it was noise → no transcript → no interruption.
    //
    // Trade-off: ~300-500ms more overlap where both user and agent are
    // audible. This is natural conversational turn-taking behaviour and
    // far preferable to false interruptions from background noise.
    if (this.state === 'SPEAKING' || this.state === 'GENERATING') {
      this.log.debug('VAD during agent speech (transcript-gated, not firing barge-in)', {
        state: this.state,
        consecutiveEmptyVADs: this.consecutiveEmptyVADs,
      });
      return;
    }

    // ── LISTENING: track consecutive empty VADs for noise suppression ───
    // Only count VADs in LISTENING state — SPEAKING-state VADs are PSTN echo.
    if (this.lastVADAt > 0 && this.lastVADAt > this.lastTranscriptAt) {
      this.consecutiveEmptyVADs++;
    }
    this.lastVADAt = now;

    // ── LISTENING: noise suppression for TTS pre-warming ────────────────
    // Post-TTS echo suppression (1.5s after TTS ends)
    const msSinceTTS = now - this.lastTTSCompleteAt;
    if (this.lastTTSCompleteAt > 0 && msSinceTTS < this.POST_TTS_VAD_SUPPRESS_MS) {
      this.log.debug('VAD ignored (post-TTS echo)', { msSinceTTS });
      return;
    }

    // Suppress persistent ambient noise (2+ consecutive empty VADs)
    if (this.consecutiveEmptyVADs >= this.MAX_EMPTY_VADS_FOR_PREWARM) {
      this.log.debug('VAD ignored (noise — consecutive empty VADs)', {
        count: this.consecutiveEmptyVADs,
      });
      return;
    }

    // ── Valid speech in LISTENING state ──────────────────────────────────
    this.latency.mark('speech_started');
    this.log.info('Speech started (VAD)', { state: this.state });

    // User is speaking — reset silence timer so we don't reprompt mid-speech.
    this.clearSilenceTimer();

    this.prewarmTTS();
  }

  // ─── No-Speech Recovery ───────────────────────────────────────────────────

  /**
   * Deepgram ended an utterance with zero decoded words. Just log it.
   * Reprompting is handled solely by the silence timer (SILENCE_TIMEOUT_MS)
   * to avoid false triggers from empty transcripts and PSTN echo.
   */
  private handleNoSpeech(): void {
    if (this.state !== 'LISTENING') return;
    this.emptyFinalStreak++;
    this.log.debug('Empty speech event (no reprompt — silence timer handles this)', {
      emptyFinalStreak: this.emptyFinalStreak,
    });
  }

  /** Speak a fixed phrase through the persistent TTS — no LLM involved. */
  private speakCanned(text: string): void {
    const myGenId = ++this.generationId;
    this.activeResponseText = text;

    // Same playback-tracking reset as generateAndSpeak()
    this.ttsAudioBytesSent = 0;
    this.firstTTSAudioSentAt = 0;
    this.ttsGenerationDone = false;
    if (this.playbackCompleteTimer) {
      clearTimeout(this.playbackCompleteTimer);
      this.playbackCompleteTimer = null;
    }

    this.state = 'SPEAKING';
    this.suppressBargeInArm = false;

    this.tts.startTurn(`g${myGenId}`);
    this.tts.streamText(text);
    this.tts.flush();
  }

  // ─── Interim Transcript: instant word-gated barge-in ─────────────────────

  /**
   * Non-empty interim transcript = Deepgram decoded actual WORDS from the
   * caller. PSTN echo of our own TTS only ever produces empty finalizations
   * (verified in call logs), so words are a safe, instant interrupt signal —
   * ~300ms after speech onset instead of waiting ~1s+ for speech_final.
   */
  /**
   * Filler/echo words that Deepgram produces from PSTN echo of the agent's
   * own TTS audio. These must NOT trigger interim barge-in.
   */
  private static readonly ECHO_FILLER_PATTERN = /^(mhmm|hmm|mm|uh|um|uhh|umm|hm|mmm|ah|huh)(\s+(mhmm|hmm|mm|uh|um|uhh|umm|hm|mmm|ah|huh))*$/i;

  private handleInterimTranscript(text: string): void {
    if (!text.trim()) return;

    // Any real interim words in LISTENING = user is actively speaking.
    // Reset silence timer to avoid reprompting mid-utterance.
    if (this.state === 'LISTENING') {
      this.clearSilenceTimer();
      return;
    }

    // SPEAKING only — during GENERATING, trailing interims from the user's
    // own just-finished utterance would cancel the generation they triggered.
    // The final-transcript path still replaces the turn in that window.
    if (this.state !== 'SPEAKING') return;
    if (this.suppressBargeInArm) return; // greeting — no barge-in

    // Filter out filler/echo words — PSTN echo of agent TTS is often
    // transcribed as "Mhmm mhmm mhmm" by Deepgram. Not real speech.
    if (CallOrchestrator.ECHO_FILLER_PATTERN.test(text.trim())) {
      this.log.debug('Interim ignored (echo/filler pattern)', { text });
      return;
    }

    this.log.info('BargeInDetected (interim words during agent speech)', { text });
    this.handleInterruption();
  }

  // ─── Final Transcript ─────────────────────────────────────────────────────

  private handleFinalTranscript(text: string, confidence: number): void {
    if (this.state === 'ENDED') return;
    if (!text.trim()) return;

    // ── Reset noise tracking — real speech confirmed ────────────────────
    this.consecutiveEmptyVADs = 0;
    this.emptyFinalStreak = 0;
    this.lastTranscriptAt = Date.now();
    this.clearSilenceTimer();

    const transcriptAt = Date.now();
    this.latency.mark('speech_final', transcriptAt);
    this.log.info('Final transcript received', {
      text,
      confidence,
      state: this.state,
      speechFinalToNowMs: 0, // this IS the speech_final event
    });

    // Transcript-gated barge-in: if the agent is still speaking, a real
    // transcript (not just VAD) is the authoritative signal to interrupt.
    // This avoids false barge-ins from background noise on PSTN.
    if (this.state === 'SPEAKING' || this.state === 'GENERATING') {
      this.log.info('Transcript-gated barge-in: real speech confirmed during agent speech', {
        text,
        state: this.state,
      });
      this.handleInterruption();
    }

    // handleInterruption or end() may have changed state
    if ((this.state as string) === 'ENDED') return;

    this.conversation.addUserMessage(text);
    this.state = 'GENERATING';

    this.log.info('Transcript → LLM handoff', {
      transcriptLenChars: text.length,
      transcriptToLlmMs: Date.now() - transcriptAt,
    });

    // Non-blocking — errors are caught inside
    void this.generateAndSpeak();
  }

  // ─── LLM + TTS Pipeline ───────────────────────────────────────────────────

  private async generateAndSpeak(opts: { suppressBargeIn?: boolean } = {}): Promise<void> {
    const myGenId = ++this.generationId;
    this.activeResponseText = '';

    // Reset playback tracking for this generation
    this.ttsAudioBytesSent = 0;
    this.firstTTSAudioSentAt = 0;
    this.ttsGenerationDone = false;
    if (this.playbackCompleteTimer) {
      clearTimeout(this.playbackCompleteTimer);
      this.playbackCompleteTimer = null;
    }

    this.abortController = new AbortController();
    const { signal } = this.abortController;

    this.log.info('Starting LLM generation', {
      generationId: myGenId,
      turns: this.conversation.messageCount,
      suppressBargeIn: opts.suppressBargeIn ?? false,
      abortControllerCreated: true,
    });
    this.latency.mark('llm_start');

    // Start a new context on the persistent ElevenLabs socket.
    // No connection is opened here — the socket has been alive since call start.
    const tts = this.tts;
    tts.startTurn(`g${myGenId}`);

    this.state = 'SPEAKING';
    // Record whether barge-in should be armed for this generation.
    // We do NOT arm here — arm() is deferred to the first TTS audio chunk
    // so that trailing audio frames from the user's own speech (still
    // flowing through the buffer when generation starts) cannot trigger
    // a false barge-in and abort the LLM before it has sent a single token.
    this.suppressBargeInArm = opts.suppressBargeIn ?? false;

    // Socket should already be open (persistent); open() is an idempotent
    // safety net after an unexpected close. streamText() queues while
    // reconnecting and drains automatically.
    const ttsOpenPromise = tts.open().then(() => {
      if (!this.latency.hasMarked('tts_open')) this.latency.mark('tts_open');
    }).catch((err: Error) => {
      this.log.error('ElevenLabs failed to open', err);
    });

    let fullText = '';
    let firstToken = true;

    // ZERO BUFFERING: stream every token directly to TTS the instant it
    // arrives. Audio starts once 50 chars accumulate (chunk_length_schedule)
    // or at flush() right after the LLM finishes — whichever comes first.
    // Replies are capped at ~12 words so flush lands ~100ms after first token.

    try {
      const stream = this.llm.stream(this.conversation.toMessages(), signal);

      for await (const event of stream) {
        if (myGenId !== this.generationId || signal.aborted) break;

        if (event.type === 'text') {
          const { text } = event as Extract<StreamEvent, { type: 'text' }>;
          fullText += text;
          this.activeResponseText = fullText;

          if (firstToken) {
            firstToken = false;
            this.latency.mark('llm_first_token');
            this.latency.mark('tts_first_text');
            this.log.info('LLM first token received — streaming to TTS immediately');
          }

          // Stream every token directly to TTS — no buffering
          tts.streamText(text);
        }
      }
    } catch (err) {
      const e = err as Error;
      const isAbort = e.name === 'AbortError' || e.message === 'Request was aborted.';
      if (isAbort) {
        this.log.debug('LLM stream aborted (expected on barge-in)');
      } else {
        this.log.error('LLM streaming error', e);
      }
    }

    this.latency.mark('llm_complete');

    if (myGenId !== this.generationId || signal.aborted) {
      // Interrupted — don't add partial response to history.
      // handleInterruption() already closed the TTS context; this is a no-op
      // unless the abort came from somewhere else (e.g. call end).
      this.log.info('Generation interrupted, discarding partial response', { partialLength: fullText.length });
      tts.abort();
      return;
    }

    // All tokens received — flush TTS to get remaining audio.
    // flush() handles the 'connecting' state via pendingFlush flag.
    if (fullText.trim()) {
      this.conversation.addAssistantText(fullText);
      this.log.info('LLM generation complete', { responseLength: fullText.length });
    }

    tts.flush();
    this.abortController = null;

    // Ensure ttsOpenPromise doesn't become an unhandled rejection
    await ttsOpenPromise;
  }

  // ─── TTS Output ───────────────────────────────────────────────────────────

  private handleTTSAudio(audioBase64: string, genId: number): void {
    // Stale audio guard — discard chunks from a cancelled generation
    if (genId !== this.generationId) return;
    if (this.state === 'ENDED') return;

    if (!this.latency.hasMarked('tts_first_audio')) {
      this.latency.mark('tts_first_audio');
      this.firstTTSAudioSentAt = Date.now();
      this.log.info('TTS first audio chunk received');

      // Arm barge-in HERE — not at generation start — so that trailing audio
      // frames from the user's own completed speech cannot trigger a false
      // barge-in during the LLM's generation window. By the time first TTS
      // audio arrives (~LLM_TTFT + TTS_latency ≈ 2s), user frames are gone.
      if (!this.suppressBargeInArm) {
        this.bargeIn.arm();
      }
    }

    // Track raw audio bytes for playback duration estimation.
    // Base64 encodes 3 bytes into 4 chars → raw bytes = base64.length * 0.75
    this.ttsAudioBytesSent += Math.floor(audioBase64.length * 0.75);

    // ElevenLabs ulaw_8000 base64 → send directly to Twilio (same format, zero conversion)
    this.twilioService.sendAudio(this.callSid, audioBase64);

    if (!this.latency.hasMarked('twilio_playback_start')) {
      this.latency.mark('twilio_playback_start');
    }
  }

  private handleTTSDone(genId: number): void {
    if (genId !== this.generationId) return;

    this.latency.mark('tts_complete');
    this.ttsGenerationDone = true;

    // Calculate remaining playback time on Twilio.
    // ulaw_8000 = 8000 bytes/sec → totalBytes / 8000 = duration in seconds.
    const totalPlaybackMs = (this.ttsAudioBytesSent / 8000) * 1000;
    const elapsedMs = Date.now() - this.firstTTSAudioSentAt;
    const remainingMs = Math.max(0, totalPlaybackMs - elapsedMs);

    this.log.info('TTS generation complete — waiting for Twilio playback', {
      totalPlaybackMs: Math.round(totalPlaybackMs),
      elapsedMs: Math.round(elapsedMs),
      remainingMs: Math.round(remainingMs),
      audioBytes: this.ttsAudioBytesSent,
    });

    this.latency.logTurnSummary(this.conversation.currentTurn);

    if (remainingMs <= 0) {
      // Playback already finished (very short response)
      this.transitionToListeningAfterPlayback(genId);
      return;
    }

    // Keep SPEAKING + barge-in armed until playback completes.
    // If user interrupts during this window, handleInterruption() cancels the timer.
    this.playbackCompleteTimer = setTimeout(() => {
      this.playbackCompleteTimer = null;
      if (genId === this.generationId) {
        this.transitionToListeningAfterPlayback(genId);
      }
    }, remainingMs);
  }

  /**
   * Transition from SPEAKING → LISTENING after Twilio finishes playing audio.
   * Called either immediately (short responses) or after the playback timer fires.
   */
  private transitionToListeningAfterPlayback(genId: number): void {
    if (genId !== this.generationId) return;

    this.bargeIn.disarm();
    this.lastTTSCompleteAt = Date.now();

    if (this.state !== 'ENDED') {
      this.state = 'LISTENING';
      this.log.info('Playback complete — now LISTENING');

      // Pre-warm TTS now — the user usually replies within seconds, and the
      // VAD-triggered prewarm path is suppressed for POST_TTS_VAD_SUPPRESS_MS
      // after TTS ends, so without this the next turn pays the WS connect cost.
      this.prewarmTTS();

      // Start silence timer — if caller doesn't speak within SILENCE_TIMEOUT_MS, reprompt.
      this.startSilenceTimer();
    }
  }

  /** Start a timer that reprompts if caller is silent for SILENCE_TIMEOUT_MS. */
  private startSilenceTimer(): void {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (this.state !== 'LISTENING') return;
      if (Date.now() - this.lastRepromptAt < this.REPROMPT_MIN_GAP_MS) return;
      if (this.repromptCount >= this.MAX_REPROMPTS_PER_CALL) return;

      // Don't reprompt if user recently spoke (VAD/transcript within last 2s)
      // — they may be mid-utterance or Deepgram is still processing.
      const now = Date.now();
      const recentActivity = Math.max(this.lastVADAt, this.lastTranscriptAt);
      if (recentActivity > 0 && now - recentActivity < 2000) {
        this.log.debug('Silence timer deferred (recent user activity)', {
          msSinceActivity: now - recentActivity,
        });
        // Restart timer for another check
        this.startSilenceTimer();
        return;
      }

      this.lastRepromptAt = Date.now();
      this.repromptCount++;
      this.log.warn('Silence timer: reprompting caller', {
        repromptCount: this.repromptCount,
        silenceMs: this.SILENCE_TIMEOUT_MS,
      });
      this.speakCanned(this.REPROMPT_TEXT);
    }, this.SILENCE_TIMEOUT_MS);
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  // ─── Barge-in / Interruption ──────────────────────────────────────────────

  private handleInterruption(): void {
    if (this.state !== 'SPEAKING' && this.state !== 'GENERATING') return;

    this.log.info('Barge-in: interrupting AI response', {
      state: this.state,
      ttsGenerationDone: this.ttsGenerationDone,
      audioBytesSent: this.ttsAudioBytesSent,
    });
    this.latency.mark('barge_in');

    // Cancel playback-complete timer (barge-in supersedes it)
    if (this.playbackCompleteTimer) {
      clearTimeout(this.playbackCompleteTimer);
      this.playbackCompleteTimer = null;
    }

    // Bump generation ID — marks all in-flight audio/text as stale
    this.generationId++;

    // Abort the LLM stream
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      this.latency.mark('llm_cancelled');
    }

    // Close the active TTS context (socket stays open) and clear Twilio's
    // jitter buffer so queued audio stops playing immediately.
    this.tts.abort();
    this.latency.mark('tts_cancelled');

    this.twilioService.clearAudio(this.callSid);
    this.bargeIn.disarm();

    // Discard the partial assistant response from conversation history
    // so the model doesn't see an incomplete assistant turn
    this.conversation.discardLastAssistantMessage();

    this.state = 'LISTENING';
    this.log.info('Barge-in handled — back to LISTENING');

    // Pre-warm TTS now — user is already speaking their next utterance
    this.prewarmTTS();
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  /** Context ids are "g{generationId}" — recover the genId for staleness checks. */
  private genIdFromContext(ctxId: string): number {
    const n = parseInt(ctxId.slice(1), 10);
    return Number.isNaN(n) ? -1 : n;
  }

  get currentState(): CallState { return this.state; }
}
