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
import { SessionState } from './SessionState';
import { LatencyTracker } from '../metrics/LatencyTracker';
import { TwilioService } from '../telephony/TwilioService';
import { globalToolRegistry } from '../tools/ToolRegistry';
import { humanizeResponse, maybeGetOpener } from '../shared/humanize';
import { Env } from '../config/env';
import { Logger, closeCallLogger } from '../shared/logger';
import { routeQuery } from '../llm/KnowledgeRouter';
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
  private readonly session: SessionState;
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
   * Speculative generation: when a stable interim fires, we start LLM+TTS
   * speculatively. If speech_final confirms the same text, we keep going
   * (saving ~150-300ms). If text differs, we abort and restart with the real text.
   */
  private speculativeText: string | null = null;

  /**
   * Terminal state: once a site visit is confirmed (day + time acknowledged),
   * no further LLM generations or reprompts are allowed. The call ends
   * cleanly after the final acknowledgement plays.
   */
  private conversationComplete = false;

  /**
   * When true, the active generation should NOT arm the barge-in detector
   * on first TTS audio (e.g. during greeting, or if caller set suppressBargeIn).
   */
  private suppressBargeInArm = false;

  // ─── Noise / False VAD Suppression ──────────────────────────────────────

  /** Timestamp when TTS last finished playing — used to suppress PSTN echo VAD. */
  private lastTTSCompleteAt = 0;

  /** Ignore VAD events for this long after TTS ends (PSTN echo dies down).
   *  500ms: STT muting during TTS already handles echo suppression. This
   *  post-TTS window only needs to cover the ~200-400ms tail of PSTN echo
   *  after playback ends. 1500ms was too aggressive — it suppressed real
   *  user speech and caused 7+ second response delays. */
  private readonly POST_TTS_VAD_SUPPRESS_MS = 500;

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
  /** Empty finals within this window after playback are PSTN echo of our own
   *  TTS, not the caller — they must not count toward the reprompt streak. */
  private readonly EMPTY_FINAL_ECHO_WINDOW_MS = 1500;
  // Idle reprompt: EXACTLY this line — no "hello", no "are you there",
  // no "kya aap sun rahe hain", no "can you hear me".
  private readonly REPROMPT_TEXT = "आपकी आवाज़ नहीं आ रही।";

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

  /** Timer that unmutes STT after barge-in grace period (echo suppression). */
  private sttUnmuteTimer: ReturnType<typeof setTimeout> | null = null;

  /** Whether TTS generation is done (all chunks received from ElevenLabs). */
  private ttsGenerationDone = false;

  // ─── STT Watchdog ─────────────────────────────────────────────────────
  // If SpeechStarted fires but no valid transcript arrives within
  // STT_WATCHDOG_TIMEOUT_MS, cancel the pending turn and reset to LISTENING.
  // Prevents silent/frozen states after failed STT recognition.
  private sttWatchdogTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(callSid: string, twilioService: TwilioService) {
    this.callSid        = callSid;
    this.twilioService  = twilioService;
    this.stt            = new DeepgramSTT(callSid);
    this.tts            = Env.ttsProvider === 'sarvam'
                            ? new SarvamTTS(callSid)
                            : new ElevenLabsTTS(callSid);
    this.llm            = new BedrockLLM(callSid, globalToolRegistry);
    this.conversation   = new ConversationManager(callSid);
    this.session        = new SessionState(callSid);
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
      .onStableInterim((text, conf) => this.handleStableInterim(text, conf))
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
    // Outbound sales opener: short — name, company, project, then check interest.
    // Deliberately does NOT ask for the name yet (first goal is to gauge interest).
    this.speakCanned(
      'Hi, मैं Arjun, R.R. Lunkad की Akshay Vista से। Site visit में interested होंगे?',
    );
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
    if (this.sttUnmuteTimer) {
      clearTimeout(this.sttUnmuteTimer);
      this.sttUnmuteTimer = null;
    }
    this.clearSilenceTimer();
    this.clearSTTWatchdog();

    // Abort any active generation
    this.abortController?.abort();

    // Close the persistent TTS socket for good
    this.tts.destroy();

    // Finalize STT (flushes any pending transcript) then close immediately
    this.stt.finalize();
    this.stt.close();

    this.latency.logCallSummary();
    this.log.info('Call orchestrator ended');

    // Hang up the Twilio call so the line disconnects cleanly.
    // Small delay to let the final TTS audio finish playing on the caller's end.
    setTimeout(() => {
      void this.twilioService.hangup(this.callSid);
    }, 1500);

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

  // ─── STT Echo Gating ──────────────────────────────────────────────────────
  // Mute audio to Deepgram during the PSTN echo burst window (first ~1.5s of
  // agent speech). After the grace period, unmute so transcript-gated barge-in
  // works. This eliminates ~90% of empty transcript spam from echo.

  private muteSTTForEchoBurst(): void {
    this.stt.mute();
    if (this.sttUnmuteTimer) clearTimeout(this.sttUnmuteTimer);
    this.sttUnmuteTimer = setTimeout(() => {
      this.sttUnmuteTimer = null;
      if (this.state === 'SPEAKING' || this.state === 'GENERATING') {
        this.stt.unmute();
        this.log.debug('STT unmuted after echo grace period');
      }
    }, Env.bargeIn.graceMs);
  }

  private ensureSTTUnmuted(): void {
    if (this.sttUnmuteTimer) {
      clearTimeout(this.sttUnmuteTimer);
      this.sttUnmuteTimer = null;
    }
    this.stt.unmute();
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

    // ── LISTENING: Post-TTS echo suppression ─────────────────────────────
    // Check BEFORE incrementing consecutiveEmptyVADs — suppressed echo VADs
    // must NOT inflate the noise counter (that would trigger ambient noise
    // suppression and block real user speech that arrives after the echo window).
    const msSinceTTS = now - this.lastTTSCompleteAt;
    if (this.lastTTSCompleteAt > 0 && msSinceTTS < this.POST_TTS_VAD_SUPPRESS_MS) {
      this.log.warn('FALSE_BARGEIN_REJECTED: post-TTS echo VAD suppressed', { msSinceTTS });
      return;
    }

    // ── LISTENING: track consecutive empty VADs for noise suppression ───
    // Only count VADs in LISTENING state — SPEAKING-state VADs are PSTN echo.
    if (this.lastVADAt > 0 && this.lastVADAt > this.lastTranscriptAt) {
      this.consecutiveEmptyVADs++;
    }
    this.lastVADAt = now;

    // ── Valid speech in LISTENING state ──────────────────────────────────
    // ALWAYS process VADs — clear silence timer, start watchdog, mark latency.
    // The ambient noise counter only suppresses TTS prewarm (not VAD handling),
    // because blocking VADs entirely creates a deadlock: no transcript can
    // arrive to reset the counter if we stop processing speech events.
    this.latency.mark('speech_started');
    this.log.info('Speech started (VAD)', { state: this.state });

    // User is speaking — reset silence timer so we don't reprompt mid-speech.
    this.clearSilenceTimer();

    // Start STT watchdog — if no valid transcript arrives within the timeout,
    // reset to LISTENING to prevent silent/stuck state after failed STT.
    this.startSTTWatchdog();

    // Only skip TTS prewarm if ambient noise is detected (2+ consecutive empty VADs).
    // This avoids wasting a TTS connection on noise, but still allows transcript processing.
    if (this.consecutiveEmptyVADs >= this.MAX_EMPTY_VADS_FOR_PREWARM) {
      this.log.debug('Skipping TTS prewarm — ambient noise (consecutive empty VADs)', {
        count: this.consecutiveEmptyVADs,
      });
      return;
    }

    this.prewarmTTS();
  }

  // ─── No-Speech Recovery ───────────────────────────────────────────────────

  /**
   * Deepgram ended an utterance with zero decoded words.
   * Restart the silence timer so the agent eventually reprompts — without this,
   * if handleSpeechStarted() cleared the timer and then recognition fails,
   * the agent goes permanently silent (no transcript, no timer, no recovery).
   */
  private handleNoSpeech(): void {
    if (this.state !== 'LISTENING') return;

    // Conversation is ending (booking confirmed / caller declined) — never
    // reprompt "आपकी आवाज़ नहीं आ रही"; the closing line is playing and the
    // call is about to hang up.
    if (this.session.shouldEndCall || this.conversationComplete) return;

    // ── Post-TTS echo guard ──────────────────────────────────────────────
    // On PSTN, the agent's own TTS echoes back for a short tail after playback
    // completes. Deepgram VADs that echo and finalizes it with ZERO words.
    // Those empty finals are NOT the caller failing to be heard, so they must
    // NOT count toward the "I can't hear you" reprompt streak — otherwise the
    // agent reprompts repeatedly between turns even though the caller is there.
    const msSinceTTS = this.lastTTSCompleteAt > 0 ? Date.now() - this.lastTTSCompleteAt : Infinity;
    if (msSinceTTS < this.EMPTY_FINAL_ECHO_WINDOW_MS) {
      this.log.debug('Empty final within post-TTS echo window — not counting toward reprompt', { msSinceTTS });
      this.clearSTTWatchdog();
      this.state = 'LISTENING';
      this.startSilenceTimer();
      return;
    }

    this.emptyFinalStreak++;
    this.log.debug('Empty/rejected speech event — ensuring LISTENING state with silence timer', {
      emptyFinalStreak: this.emptyFinalStreak,
      state: this.state,
    });
    // Clear watchdog — the STT turn is over (rejected or empty), not stuck.
    this.clearSTTWatchdog();
    // Ensure state is LISTENING (prevents stuck states after rejected transcripts)
    this.state = 'LISTENING';

    // Direct reprompt after consecutive empty finals — don't rely on silence
    // timer which gets endlessly reset by frequent empty VAD events.
    if (this.emptyFinalStreak >= this.EMPTY_FINALS_BEFORE_REPROMPT &&
        Date.now() - this.lastRepromptAt >= this.REPROMPT_MIN_GAP_MS &&
        this.repromptCount < this.MAX_REPROMPTS_PER_CALL) {
      this.emptyFinalStreak = 0;
      this.lastRepromptAt = Date.now();
      this.repromptCount++;
      this.log.warn('Reprompting after consecutive empty speech finals', {
        repromptCount: this.repromptCount,
      });
      this.speakCanned(this.REPROMPT_TEXT);
      return;
    }

    // Restart silence timer as fallback for true silence (no VAD events at all).
    this.startSilenceTimer();
  }

  /** Speak a fixed phrase through the persistent TTS — no LLM involved. */
  private speakCanned(text: string): void {
    if (this.conversationComplete) return; // No more speech after scheduling confirmed
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

    // Mute STT during echo burst — unmutes after barge-in grace period
    this.muteSTTForEchoBurst();

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

    // Track first interim for latency measurement (VAD → first words)
    if (!this.latency.hasMarked('first_interim')) {
      this.latency.mark('first_interim');
    }

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
      this.log.warn('FALSE_BARGEIN_REJECTED: interim is echo/filler during SPEAKING', { text });
      return;
    }

    this.log.info('BargeInDetected (interim words during agent speech)', { text });
    this.handleInterruption();
  }

  // ─── Stable Interim → Speculative LLM Generation ──────────────────────────

  /**
   * Stable interim: Deepgram interims haven't changed for ~150ms, meaning
   * the user likely stopped speaking and we're just waiting for endpointing
   * to confirm. Start LLM generation speculatively to overlap with the
   * endpointing window (~150ms). If speech_final confirms the same text,
   * we save ~150-300ms. If text differs, handleFinalTranscript aborts and restarts.
   */
  private handleStableInterim(text: string, confidence: number): void {
    // Only start speculative generation in LISTENING state
    if (this.state !== 'LISTENING') return;
    if (!text.trim()) return;
    if (this.conversationComplete) return;

    // ── Speculation DISABLED for reliability ─────────────────────────────
    // Speculative generation from stable interims was double-firing: when the
    // final transcript differed, the in-flight LLM+TTS was aborted and a fresh
    // generation started, but the restart's audio could be dropped — the caller
    // heard SILENCE after asking a question (observed on a real call). The
    // ~150ms it could save is not worth dropping answers on a sales call.
    // Every turn now runs exactly one clean generation on the final transcript.
    if (!Env.llm.speculationEnabled) {
      this.consecutiveEmptyVADs = 0;
      this.emptyFinalStreak = 0;
      this.lastTranscriptAt = Date.now();
      this.clearSilenceTimer();
      return;
    }
    // Block generation if already booked
    if (this.session.bookingStatus === 'BOOKED') {
      this.log.info('Ignoring stable interim — booking already complete', { text });
      return;
    }

    // ── Speculation safety gate ──────────────────────────────────────────
    // Block speculative generation for short utterances that don't look
    // like complete queries.
    if (!this.session.shouldAllowSpeculation(text)) {
      this.log.info('Speculation blocked by safety gate', {
        text,
        lastAskedField: this.session.lastAskedField,
      });
      // Still reset noise tracking and silence timer — real speech is happening
      this.consecutiveEmptyVADs = 0;
      this.lastTranscriptAt = Date.now();
      this.clearSilenceTimer();
      return;
    }

    // Do NOT extract user info from stable interims — wait for speech_final.
    // Extracting from interims caused "मेरा नाम" (incomplete) to be stored as name.

    this.log.info('Speculative LLM start from stable interim', {
      text,
      confidence,
      state: this.state,
    });

    // Reset noise tracking — real speech detected
    this.consecutiveEmptyVADs = 0;
    this.emptyFinalStreak = 0;
    this.lastTranscriptAt = Date.now();
    this.clearSilenceTimer();

    this.latency.mark('stable_interim');

    // Record the speculative text so handleFinalTranscript can compare
    this.speculativeText = text.trim();

    // Add to conversation and start generating
    this.conversation.addUserMessage(text.trim());
    this.state = 'GENERATING';

    this.log.info('Stable interim → speculative LLM handoff', {
      transcriptLenChars: text.trim().length,
    });

    // Try deterministic scheduling response before LLM (zero tokens)
    if (this.trySchedulingResponse()) {
      return;
    }

    // Try zero-token fact response before invoking LLM
    if (this.tryDirectFactResponse(text.trim())) {
      return;
    }

    void this.generateAndSpeak({ maxTokens: this.session.selectTokenBudget(text) });
  }

  // ─── Final Transcript ─────────────────────────────────────────────────────

  private handleFinalTranscript(text: string, confidence: number): void {
    if (this.state === 'ENDED') return;
    if (!text.trim()) return;

    // Block all processing if already booked — call is ending
    if (this.session.bookingStatus === 'BOOKED' || this.conversationComplete) {
      this.log.info('Ignoring final transcript — conversation already complete', { text });
      return;
    }

    // ── Track previous state for pin detection ─────────────────────────
    const prevDate = this.session.info.preferredDate;
    const prevTime = this.session.info.preferredTime;

    // ── Extract user info from transcript (name, date, time) ───────────
    this.session.advanceTurn();
    this.session.extractFromUserTranscript(text);

    // Did THIS turn end the conversation (booking confirmed, or caller declined)?
    // If so, any in-flight SPECULATIVE generation was built for the pre-end state
    // (e.g. "konsa time?") — it must NOT be confirmed. We force a fresh generation
    // below so the caller hears the proper closing line ("7 बजे site पर मिलते हैं"
    // / polite decline) and the call ends cleanly instead of lingering and
    // reprompting "आपकी आवाज़ नहीं आ रही".
    const conversationEndingThisTurn = this.session.shouldEndCall;

    // ── Reset noise tracking — real speech confirmed ────────────────────
    this.consecutiveEmptyVADs = 0;
    this.emptyFinalStreak = 0;
    this.lastTranscriptAt = Date.now();
    this.clearSilenceTimer();
    this.clearSTTWatchdog();

    const transcriptAt = Date.now();
    this.latency.mark('speech_final', transcriptAt);
    this.log.info('Final transcript received', {
      text,
      confidence,
      state: this.state,
      speculativeText: this.speculativeText,
      speechFinalToNowMs: 0, // this IS the speech_final event
    });

    // ── Speculative generation reconciliation ──────────────────────────
    // If we already started a speculative LLM generation from a stable interim,
    // check if the final text matches. Three outcomes:
    //   1. EXACT MATCH: speculation confirmed — let it continue (huge win)
    //   2. PREFIX MATCH: final extends speculative text — keep generation,
    //      the extra words don't change the intent enough to matter
    //      (e.g. "what are the amenities of the" → "...of the project")
    //   3. MISMATCH: abort and restart with real text
    if (this.speculativeText !== null) {
      const specText = this.speculativeText;
      this.speculativeText = null;
      const finalText = text.trim();

      if (finalText === specText && !conversationEndingThisTurn) {
        // Exact match — generation already running, nothing to do.
        this.latency.recordSpeculation('confirmed_exact');
        this.log.info('Speculative generation CONFIRMED (exact match)', {
          text: specText,
          savedMs: Date.now() - transcriptAt,
        });
        return;
      }

      // Prefix match: final text starts with the speculative text.
      // The LLM already received the core intent — extra trailing words
      // (like "project" after "what are the amenities of the") rarely
      // change the response meaningfully. Keep the generation running.
      if (finalText.startsWith(specText) && specText.length >= 8 && !conversationEndingThisTurn) {
        const extraWords = finalText.slice(specText.length).trim();
        this.latency.recordSpeculation('confirmed_prefix');
        this.log.info('Speculative generation CONFIRMED (prefix match)', {
          speculative: specText,
          final: finalText,
          extraWords,
          savedMs: Date.now() - transcriptAt,
        });
        // Update the user message in history to reflect the complete text
        this.conversation.updateLastUserMessage(finalText);
        return;
      }

      // Text differs — abort speculative generation and restart with real text.
      this.latency.recordSpeculation('invalidated');
      this.log.warn('Speculative generation INVALIDATED — aborting', {
        speculative: specText,
        final: finalText,
      });
      // Cancel in-flight LLM+TTS
      this.generationId++;
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
      }
      this.tts.abort();
      this.twilioService.clearAudio(this.callSid);
      // Remove the speculative user message from conversation history
      this.conversation.discardLastUserMessage();
      this.conversation.discardLastAssistantMessage();
      this.state = 'LISTENING';
      this.ensureSTTUnmuted();
      // Fall through to start fresh generation with the real text
    }

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

    // ── Pin message if it contained critical info extraction ──────────
    if (!prevDate && this.session.info.preferredDate) {
      this.conversation.pinLastUserMessage('date:' + this.session.info.preferredDate);
    }
    if (!prevTime && this.session.info.preferredTime) {
      this.conversation.pinLastUserMessage('time:' + this.session.info.preferredTime);
    }

    this.state = 'GENERATING';

    this.log.info('Transcript → LLM handoff', {
      transcriptLenChars: text.length,
      transcriptToLlmMs: Date.now() - transcriptAt,
    });

    // Try deterministic scheduling response before LLM (zero tokens)
    if (this.trySchedulingResponse()) {
      return;
    }

    // Try zero-token fact response before invoking LLM
    if (this.tryDirectFactResponse(text)) {
      return;
    }

    // Non-blocking — errors are caught inside
    void this.generateAndSpeak({ maxTokens: this.session.selectTokenBudget(text) });
  }

  // ─── Knowledge Router: Zero-Token Fact Responses ────────────────────────────

  /**
   * Try to answer a factual query directly from PropertyFacts, bypassing LLM.
   * Returns true if handled (response is already streaming to TTS).
   * Returns false if the query needs LLM processing.
   */
  private tryDirectFactResponse(text: string): boolean {
    const result = routeQuery(text, this.session, this.log);

    if (!result.handled) {
      this.log.debug('ROUTER_DECISION: LLM required', {
        reason: result.reason,
        text: text.substring(0, 50),
      });
      return false;
    }

    // ── Direct response path: skip LLM entirely ──────────────────────────
    this.log.info('DIRECT_FACT_RESPONSE', {
      intent: result.intent,
      response: result.response,
      reason: result.reason,
      text: text.substring(0, 50),
    });

    const myGenId = ++this.generationId;
    this.activeResponseText = result.response;

    // Reset playback tracking
    this.ttsAudioBytesSent = 0;
    this.firstTTSAudioSentAt = 0;
    this.ttsGenerationDone = false;
    if (this.playbackCompleteTimer) {
      clearTimeout(this.playbackCompleteTimer);
      this.playbackCompleteTimer = null;
    }

    // No AbortController needed — no LLM to cancel
    this.abortController = null;

    const tts = this.tts;
    tts.startTurn(`g${myGenId}`);

    this.state = 'SPEAKING';
    this.suppressBargeInArm = false;

    // Mute STT during echo burst
    this.muteSTTForEchoBurst();

    // Stream the response directly to TTS
    const humanPrefix = Env.humanization.enabled ? maybeGetOpener() : '';
    if (humanPrefix) tts.streamText(humanPrefix);
    tts.streamText(result.response);

    // Track in conversation history so context is preserved
    this.session.extractFromAssistantResponse(result.response);
    this.conversation.addAssistantText(result.response);

    this.log.info('LLM generation complete', {
      responseLength: result.response.length,
      response: result.response,
    });

    // Check for conversation-ending state
    if (this.session.shouldEndCall && !this.conversationComplete) {
      this.conversationComplete = true;
    }

    tts.flush();
    return true;
  }

  // ─── Deterministic Scheduling Responses ──────────────────────────────────
  // Zero-LLM-token responses for scheduling steps. Ensures the scheduling
  // flow works even if the LLM is unavailable (503/timeout/capacity).

  /**
   * Try to handle the current step with a deterministic scheduling response.
   * Returns true if handled (response streaming to TTS), false if LLM needed.
   */
  private trySchedulingResponse(): boolean {
    const response = this.session.getSchedulingResponse();
    if (!response) return false;

    this.log.info('LLM_BYPASSED_FOR_SCHEDULING', {
      step: this.session.currentStep,
      response,
    });

    const myGenId = ++this.generationId;
    this.activeResponseText = response;

    // Reset playback tracking
    this.ttsAudioBytesSent = 0;
    this.firstTTSAudioSentAt = 0;
    this.ttsGenerationDone = false;
    if (this.playbackCompleteTimer) {
      clearTimeout(this.playbackCompleteTimer);
      this.playbackCompleteTimer = null;
    }

    this.abortController = null;

    const tts = this.tts;
    tts.startTurn(`g${myGenId}`);

    this.state = 'SPEAKING';
    this.suppressBargeInArm = false;
    this.muteSTTForEchoBurst();

    // Stream directly to TTS — no LLM involved
    tts.streamText(response);

    // Track in conversation history
    this.session.extractFromAssistantResponse(response);
    this.conversation.addAssistantText(response);

    this.log.info('LLM generation complete', {
      responseLength: response.length,
      response,
    });

    // Check for conversation-ending state
    if (this.session.shouldEndCall && !this.conversationComplete) {
      this.conversationComplete = true;
      this.log.info('Conversation complete — booking confirmed by session state', {
        date: this.session.info.preferredDate,
        time: this.session.info.preferredTime,
        bookingStatus: this.session.bookingStatus,
      });
    }

    tts.flush();
    return true;
  }

  // ─── LLM + TTS Pipeline ───────────────────────────────────────────────────

  private async generateAndSpeak(opts: { suppressBargeIn?: boolean; maxTokens?: number } = {}): Promise<void> {
    // Hard block: never generate after booking is complete
    if (this.session.bookingStatus === 'BOOKED' && !this.session.shouldEndCall) {
      this.log.info('generateAndSpeak() blocked — booking already BOOKED');
      this.state = 'LISTENING';
      return;
    }

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

    // Mute STT during echo burst — unmutes after barge-in grace period
    this.muteSTTForEchoBurst();


    // Socket should already be open (persistent from call start).
    // If it dropped unexpectedly, streamText() queues and startTurn() reconnects.
    // No need to await — fire-and-forget safety net only.
    if (!this.tts.isActive) {
      tts.open().then(() => {
        if (!this.latency.hasMarked('tts_open')) this.latency.mark('tts_open');
      }).catch((err: Error) => {
        this.log.error('TTS failed to open', err);
      });
    }

    let fullText = '';
    let firstToken = true;
    // Decide upfront whether this turn gets a humanization opener (~7% chance).
    const humanPrefix = Env.humanization.enabled ? maybeGetOpener() : '';

    // ZERO BUFFERING: stream every token directly to TTS the instant it
    // arrives. Audio starts once 50 chars accumulate (chunk_length_schedule)
    // or at flush() right after the LLM finishes — whichever comes first.
    // Replies are capped at ~12 words so flush lands ~100ms after first token.

    // Inject current session state into the system prompt so the LLM
    // knows what info has been collected and what to ask next.
    this.conversation.setSystemPromptSuffix(this.session.toPromptBlock());

    // ── Lightweight leading-segment guard ──────────────────────────────────
    // We do NOT buffer full responses (latency-critical). We hold back only the
    // FIRST sentence/segment — until a sentence boundary, ~100 chars, or ~150ms,
    // whichever comes first — sanitize it (strip banned filler/pitch/post-
    // rejection scheduling), emit it, then stream every later token live.
    const HEAD_CHAR_CAP = 100;
    const HEAD_TIME_CAP_MS = 150;
    let head = '';
    let headFlushed = false;
    let headStartedAt = 0;

    const flushHead = (): void => {
      if (headFlushed) return;
      headFlushed = true;
      this.latency.mark('tts_first_text');
      // Measure the guard's added head-buffer cost. This is the ONLY latency
      // the leading-segment guard introduces; it is bounded by HEAD_TIME_CAP_MS.
      // (Also surfaced as llm_token_to_tts_text_ms in the TURN LATENCY summary.)
      const bufferMs = headStartedAt ? Date.now() - headStartedAt : 0;
      // Humanization opener (if any) leads, then the sanitized segment.
      if (humanPrefix) tts.streamText(humanPrefix);
      const cleaned = this.session.sanitizeStreamingHead(head);
      const modified = cleaned !== head.trim();
      this.log.info('Leading-segment guard flushed', {
        head_buffer_ms: bufferMs,
        head_chars: head.length,
        guard_modified: modified,
      });
      if (cleaned) tts.streamText(cleaned);
      head = '';
    };

    let genTokensUsed = 0;
    let genTruncated = false;

    try {
      const stream = this.llm.stream(
        this.conversation.toMessages(),
        signal,
        this.conversation.systemPrompt,
        opts.maxTokens,
      );

      for await (const event of stream) {
        if (myGenId !== this.generationId || signal.aborted) break;

        if (event.type === 'text') {
          const { text } = event as Extract<StreamEvent, { type: 'text' }>;
          fullText += text;
          this.activeResponseText = fullText;

          if (firstToken) {
            firstToken = false;
            headStartedAt = Date.now();
            this.latency.mark('llm_first_token');
            this.log.info('LLM first token received — buffering leading segment for guard');
          }

          if (!headFlushed) {
            head += text;
            const atBoundary = /[.?!।\n]/.test(text);
            const overChars = head.length >= HEAD_CHAR_CAP;
            const overTime = Date.now() - headStartedAt >= HEAD_TIME_CAP_MS;
            if (atBoundary || overChars || overTime) flushHead();
          } else {
            // Leading segment already cleared — stream every later token live.
            tts.streamText(text);
          }
        } else if (event.type === 'done') {
          const d = event as Extract<StreamEvent, { type: 'done' }>;
          genTokensUsed = d.tokensUsed ?? 0;
          genTruncated = d.truncated ?? false;
        }
      }
      // Short reply that never tripped a boundary/cap: flush the held segment.
      if (!headFlushed && (myGenId === this.generationId) && !signal.aborted) {
        flushHead();
      }
    } catch (err) {
      const e = err as Error;
      const isAbort = e.name === 'AbortError' || e.message === 'Request was aborted.';
      if (isAbort) {
        this.log.debug('LLM stream aborted (expected on barge-in)');
      } else {
        this.log.error('LLM streaming error', e);
        // ── Fallback: speak a recovery message so the user never hears silence ──
        // Without this, a Groq 503 or network error produces 0 bytes of audio
        // and the caller experiences a dead-air deadlock.
        if (myGenId === this.generationId && !signal.aborted && !fullText.trim()) {
          // If we're in a scheduling step, use deterministic response instead of generic fallback
          const schedulingResponse = this.session.getSchedulingResponse();
          const fallbackMsg = schedulingResponse ?? 'क्षमा करें, फिर से बोलिए।';
          fullText = fallbackMsg;
          tts.streamText(fallbackMsg);
          this.log.warn(schedulingResponse ? 'LLM_ERROR_SCHEDULING_FALLBACK' : 'LLM_ERROR_FALLBACK', {
            message: 'speaking recovery message to prevent silence',
            step: this.session.currentStep,
          });
        }
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

    // Record token usage for adaptive budgeting + auto-escalation (logs
    // selectedTokenLimit / actualTokensUsed / responseTruncated).
    this.session.recordGeneration(genTokensUsed, genTruncated);

    // All tokens received — flush TTS to get remaining audio.
    // flush() handles the 'connecting' state via pendingFlush flag.
    if (fullText.trim()) {
      // ── Post-generation output validation ──────────────────────────
      // Catch hallucinations before they reach the user.
      const validationIssues = this.session.validateOutput(fullText);

      if (this.session.hasHallucinatedBooking(fullText)) {
        // LLM claimed booking is done but state doesn't support it.
        // Log the hallucination but still play the response (stripping would
        // cause awkward silence). The session state machine will NOT advance
        // to BOOKED, so the next turn will correct course.
        this.log.warn('HALLUCINATION DETECTED: LLM claimed booking without CONFIRMATION_PENDING', {
          text: fullText.substring(0, 100),
          bookingStatus: this.session.bookingStatus,
          hasDate: !!this.session.info.preferredDate,
          hasTime: !!this.session.info.preferredTime,
        });
        // Do NOT call extractFromAssistantResponse — prevents false BOOKED transition
      } else {
        // Normal path: extract booking-related info from the assistant's response
        this.session.extractFromAssistantResponse(fullText);
      }

      if (validationIssues.length > 0) {
        this.log.warn('Output validation issues detected', {
          issues: validationIssues,
          text: fullText.substring(0, 150),
        });
      }

      this.conversation.addAssistantText(fullText);
      this.log.info('LLM generation complete', { responseLength: fullText.length, response: fullText });

      // State-aware completion: session state tracks whether all info
      // is collected AND the LLM confirmed the booking. This replaces
      // the old regex-only approach that could false-trigger.
      if (this.session.shouldEndCall && !this.conversationComplete) {
        this.conversationComplete = true;
        this.log.info('Conversation complete — booking confirmed by session state', {
          date: this.session.info.preferredDate,
          time: this.session.info.preferredTime,
          bookingStatus: this.session.bookingStatus,
        });
      }
    }

    tts.flush();
    this.abortController = null;
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

    if (this.state === 'ENDED') return;

    // Terminal state: conversation is complete (site visit scheduled).
    // End the call cleanly after the final acknowledgement played.
    if (this.conversationComplete) {
      this.log.info('Playback complete — conversation complete, ending call');
      void this.end();
      return;
    }

    this.state = 'LISTENING';
    this.ensureSTTUnmuted();
    // Reset noise counter — any empty VADs from during TTS are echo, not ambient noise.
    this.consecutiveEmptyVADs = 0;
    this.log.info('Playback complete — now LISTENING');

    // Pre-warm TTS now — the user usually replies within seconds, and the
    // VAD-triggered prewarm path is suppressed for POST_TTS_VAD_SUPPRESS_MS
    // after TTS ends, so without this the next turn pays the WS connect cost.
    this.prewarmTTS();

    // Start silence timer — if caller doesn't speak within SILENCE_TIMEOUT_MS, reprompt.
    this.startSilenceTimer();
  }

  /** Start a timer that reprompts if caller is silent for SILENCE_TIMEOUT_MS. */
  private startSilenceTimer(): void {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (this.state !== 'LISTENING') return;
      // Conversation ending — don't reprompt while the closing line plays.
      if (this.session.shouldEndCall || this.conversationComplete) return;
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

  // ─── STT Watchdog ─────────────────────────────────────────────────────────

  /** Start a watchdog timer — fires if no valid transcript arrives in time. */
  private startSTTWatchdog(): void {
    this.clearSTTWatchdog();
    this.sttWatchdogTimer = setTimeout(() => {
      this.sttWatchdogTimer = null;
      if (this.state !== 'LISTENING') return;

      this.log.warn('WATCHDOG_RESET: no valid transcript within timeout — resetting to LISTENING', {
        timeoutMs: Env.sttWatchdog.timeoutMs,
        consecutiveEmptyVADs: this.consecutiveEmptyVADs,
        emptyFinalStreak: this.emptyFinalStreak,
      });

      // Ensure we're firmly in LISTENING with a silence timer running
      this.state = 'LISTENING';
      this.startSilenceTimer();
    }, Env.sttWatchdog.timeoutMs);
  }

  private clearSTTWatchdog(): void {
    if (this.sttWatchdogTimer) {
      clearTimeout(this.sttWatchdogTimer);
      this.sttWatchdogTimer = null;
    }
  }

  // ─── Barge-in / Interruption ──────────────────────────────────────────────

  private handleInterruption(): void {
    if (this.state !== 'SPEAKING' && this.state !== 'GENERATING') return;

    // Do NOT interrupt the final goodbye message — let it finish and end the call.
    // Without this guard, a user saying "thanks" during the goodbye triggers
    // a new generation cycle, making the agent continue talking after booking.
    if (this.conversationComplete) {
      this.log.info('Barge-in suppressed — conversation complete, letting final response finish');
      return;
    }

    this.log.info('Barge-in: interrupting AI response', {
      state: this.state,
      ttsGenerationDone: this.ttsGenerationDone,
      audioBytesSent: this.ttsAudioBytesSent,
    });
    this.latency.mark('barge_in');
    this.speculativeText = null;

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
    this.ensureSTTUnmuted();
    this.log.info('Barge-in handled — back to LISTENING');

    // Dead-air guard: a barge-in is normally followed by a real transcript that
    // drives the next generation (and clears this timer). But a barge-in fired
    // on background noise that Deepgram briefly decoded as interim words may
    // NEVER finalize — no transcript, no handleNoSpeech, no recovery. Arm the
    // silence timer so the agent reprompts instead of sitting silent forever.
    this.startSilenceTimer();

    // Pre-warm TTS now — user is already speaking their next utterance
    this.prewarmTTS();
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  /** Context ids are "g{generationId}" — recover the genId for staleness checks. */
  private genIdFromContext(ctxId: string): number {
    const n = parseInt(ctxId.slice(1), 10);
    return Number.isNaN(n) ? -1 : n;
  }

  // ─── Scheduling Completion Detection ────────────────────────────────────
  // Now handled by SessionState.extractFromAssistantResponse() which tracks
  // collected info (name, date, time) and booking status (CONFIRMATION_PENDING → BOOKED).
  // The old regex-only approach was replaced because it could:
  //   1. Hallucinate completion when the LLM used "noted" without actual booking
  //   2. Miss completion when the LLM used non-English confirmation words
  //   3. Fire without checking if required info was actually collected

  get currentState(): CallState { return this.state; }
}
