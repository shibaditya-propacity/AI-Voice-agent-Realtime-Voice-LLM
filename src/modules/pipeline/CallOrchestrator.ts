/**
 * CallOrchestrator: per-call pipeline controller.
 *
 * Wires together:
 *   Twilio (audio I/O)
 *     ↓ raw PCMU
 *   Deepgram (STT, VAD, barge-in signal)
 *     ↓ final transcript
 *   Groq LLM (streaming)
 *     ↓ streamed text
 *   Sarvam TTS (streaming)
 *     ↓ mulaw 8kHz audio (same format as Twilio, no conversion)
 *   Twilio
 *
 * State machine:
 *   IDLE → LISTENING → GENERATING → SPEAKING → (INTERRUPTED →) LISTENING
 *
 * ConversationStateManager injects [PROPERTY FACTS] + [SESSION STATE] +
 * [NEXT ACTION] into the system prompt before every Groq call.
 */

import { DeepgramSTT } from './DeepgramSTT';
import { GroqLLM } from './GroqLLM';
import { SarvamTTS } from './SarvamTTS';
import { BargeInDetector } from './BargeInDetector';
import { LLMConversationManager } from './LLMConversationManager';
import { SessionState } from './SessionState';
import { LatencyTracker } from './LatencyTracker';
import { maybeGetOpener } from './humanize';
import { TwilioService } from '../twilio/TwilioService';
import { Env } from '../../config';
import { Logger, closeCallLogger } from '../../shared/Logger';
import type { StreamEvent } from './LLMTypes';
import { classifyIntent, isLocallyRoutable, buildLocalResponse, IntentMetrics } from '../intent';
import { PROPERTY_FACTS } from '../conversation/PropertyFacts';

type CallState =
  | 'IDLE'
  | 'LISTENING'
  | 'GENERATING'
  | 'SPEAKING'
  | 'INTERRUPTED'
  | 'ENDED';

export class CallOrchestrator {
  private state: CallState = 'IDLE';

  private readonly callSid: string;
  private readonly twilioService: TwilioService;
  private readonly stt: DeepgramSTT;
  private readonly llm: GroqLLM;
  private readonly conversation: LLMConversationManager;
  private readonly session: SessionState;
  private readonly latency: LatencyTracker;
  private readonly bargeIn: BargeInDetector;
  private readonly intentMetrics: IntentMetrics;
  private readonly log: Logger;

  private generationId = 0;

  private readonly callStartAt = Date.now();
  private readonly CALL_START_AUDIO_DROP_MS = 500;

  private abortController: AbortController | null = null;

  private readonly tts: SarvamTTS;

  private activeResponseText = '';

  private speculativeText: string | null = null;

  private conversationComplete = false;
  private suppressBargeInArm = false;

  // ─── Noise / False VAD Suppression ──────────────────────────────────────

  private lastTTSCompleteAt = 0;
  private readonly POST_TTS_VAD_SUPPRESS_MS = 1500;

  private consecutiveEmptyVADs = 0;
  private readonly MAX_EMPTY_VADS_FOR_PREWARM = 2;

  private lastVADAt = 0;
  private lastTranscriptAt = 0;

  // ─── No-Speech Recovery ─────────────────────────────────────────────────

  private emptyFinalStreak = 0;
  private lastRepromptAt = 0;
  private repromptCount = 0;
  private readonly EMPTY_FINALS_BEFORE_REPROMPT = 2;
  private readonly REPROMPT_MIN_GAP_MS = 8000;
  private readonly MAX_REPROMPTS_PER_CALL = 3;
  private readonly REPROMPT_TEXTS = [
    'Hello? Aapki awaaz nahi aa rahi, kya aap sun rahe hain?',
    'Hello? Lagta hai connection mein issue hai, kya aap mujhe sun pa rahe hain?',
    'Hello? Agar aap sun rahe hain toh please bataiye, main yahan hoon.',
  ] as const;
  private repromptTextIndex = 0;

  // ─── Silence Timer ──────────────────────────────────────────────────────

  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly SILENCE_TIMEOUT_MS = 7000;

  // ─── Playback Duration Tracking ─────────────────────────────────────────

  private ttsAudioBytesSent = 0;
  private firstTTSAudioSentAt = 0;
  private playbackCompleteTimer: ReturnType<typeof setTimeout> | null = null;
  private sttUnmuteTimer: ReturnType<typeof setTimeout> | null = null;
  private ttsGenerationDone = false;

  constructor(callSid: string, twilioService: TwilioService) {
    this.callSid        = callSid;
    this.twilioService  = twilioService;
    this.stt            = new DeepgramSTT(callSid);
    this.tts            = new SarvamTTS(callSid);
    this.llm            = new GroqLLM(callSid);
    this.conversation   = new LLMConversationManager(callSid);
    this.session        = new SessionState(callSid);
    this.latency        = new LatencyTracker(callSid);
    this.bargeIn        = new BargeInDetector(callSid);
    this.intentMetrics  = new IntentMetrics(callSid);
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

    // Wire persistent TTS
    this.tts
      .onAudio((audio, ctxId) => this.handleTTSAudio(audio, this.genIdFromContext(ctxId)))
      .onDone((ctxId)         => this.handleTTSDone(this.genIdFromContext(ctxId)))
      .onError((err)          => this.log.error('TTS error', err));

    this.stt.connect();
    void this.tts.open().catch(() => {});
    this.log.info('Call orchestrator ready', { state: this.state });

    // Fixed greeting — no LLM needed
    this.speakCanned('Hi, मैं Arjun बोल रहा हूँ Akshay Vista से। क्या मैं आपका नाम जान सकता हूँ?');
  }

  /** Called for every inbound audio frame from Twilio. */
  handleInboundAudio(audioBase64: string): void {
    if (this.state === 'ENDED') return;

    // Drop first 500ms of audio — Twilio call-connect ring-down noise
    if (Date.now() - this.callStartAt < this.CALL_START_AUDIO_DROP_MS) return;

    const pcmu = Buffer.from(audioBase64, 'base64');

    // Forward raw PCMU to Deepgram — no codec conversion needed.
    this.stt.sendAudio(pcmu);
  }

  async end(): Promise<void> {
    if (this.state === 'ENDED') return;
    this.state = 'ENDED';

    this.log.info('Call ending');
    this.latency.mark('call_end');

    this.bargeIn.disarm();

    if (this.playbackCompleteTimer) {
      clearTimeout(this.playbackCompleteTimer);
      this.playbackCompleteTimer = null;
    }
    if (this.sttUnmuteTimer) {
      clearTimeout(this.sttUnmuteTimer);
      this.sttUnmuteTimer = null;
    }
    this.clearSilenceTimer();

    this.abortController?.abort();

    this.tts.destroy();

    this.stt.finalize();
    this.stt.close();

    this.latency.logCallSummary();
    this.intentMetrics.logCallSummary();
    this.log.info('Call orchestrator ended');

    closeCallLogger(this.callSid);
  }

  // ─── TTS Prewarming ───────────────────────────────────────────────────────

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

    if (this.state === 'SPEAKING' || this.state === 'GENERATING') {
      this.log.debug('VAD during agent speech (transcript-gated, not firing barge-in)', {
        state: this.state,
      });
      return;
    }

    if (this.lastVADAt > 0 && this.lastVADAt > this.lastTranscriptAt) {
      this.consecutiveEmptyVADs++;
    }
    this.lastVADAt = now;

    const msSinceTTS = now - this.lastTTSCompleteAt;
    if (this.lastTTSCompleteAt > 0 && msSinceTTS < this.POST_TTS_VAD_SUPPRESS_MS) {
      this.log.debug('VAD ignored (post-TTS echo)', { msSinceTTS });
      return;
    }

    if (this.consecutiveEmptyVADs >= this.MAX_EMPTY_VADS_FOR_PREWARM) {
      this.log.debug('VAD ignored (noise — consecutive empty VADs)', {
        count: this.consecutiveEmptyVADs,
      });
      return;
    }

    this.latency.mark('speech_started');
    this.log.info('Speech started (VAD)', { state: this.state });

    this.clearSilenceTimer();
    this.prewarmTTS();
  }

  // ─── No-Speech Recovery ───────────────────────────────────────────────────

  private handleNoSpeech(): void {
    if (this.state !== 'LISTENING') return;
    this.emptyFinalStreak++;
    this.log.debug('Empty speech event — restarting silence timer', {
      emptyFinalStreak: this.emptyFinalStreak,
    });
    this.startSilenceTimer();
  }

  /** Speak a fixed phrase through TTS — no LLM involved. */
  private speakCanned(text: string): void {
    if (this.conversationComplete) return;
    const myGenId = ++this.generationId;
    this.activeResponseText = text;

    this.ttsAudioBytesSent = 0;
    this.firstTTSAudioSentAt = 0;
    this.ttsGenerationDone = false;
    if (this.playbackCompleteTimer) {
      clearTimeout(this.playbackCompleteTimer);
      this.playbackCompleteTimer = null;
    }

    this.state = 'SPEAKING';
    this.suppressBargeInArm = false;

    this.muteSTTForEchoBurst();

    this.tts.startTurn(`g${myGenId}`);
    this.tts.streamText(text);
    this.tts.flush();
  }

  // ─── Interim Transcript: instant word-gated barge-in ─────────────────────

  private static readonly ECHO_FILLER_PATTERN = /^(mhmm|hmm|mm|uh|um|uhh|umm|hm|mmm|ah|huh)(\s+(mhmm|hmm|mm|uh|um|uhh|umm|hm|mmm|ah|huh))*$/i;

  private handleInterimTranscript(text: string): void {
    if (!text.trim()) return;

    if (!this.latency.hasMarked('first_interim')) {
      this.latency.mark('first_interim');
    }

    if (this.state === 'LISTENING') {
      this.clearSilenceTimer();
      return;
    }

    if (this.state !== 'SPEAKING') return;
    if (this.suppressBargeInArm) return;

    if (CallOrchestrator.ECHO_FILLER_PATTERN.test(text.trim())) {
      this.log.debug('Interim ignored (echo/filler pattern)', { text });
      return;
    }

    this.log.info('BargeInDetected (interim words during agent speech)', { text });
    this.handleInterruption();
  }

  // ─── Stable Interim → Speculative LLM Generation ──────────────────────────

  private handleStableInterim(text: string, confidence: number): void {
    if (this.state !== 'LISTENING') return;
    if (!text.trim()) return;
    if (this.conversationComplete) return;
    if (this.session.bookingStatus === 'BOOKED') {
      this.log.info('Ignoring stable interim — booking already complete', { text });
      return;
    }

    if (!this.session.shouldAllowSpeculation(text)) {
      this.log.info('Speculation blocked by safety gate', {
        text, lastAskedField: this.session.lastAskedField, hasName: !!this.session.info.name,
      });
      this.consecutiveEmptyVADs = 0;
      this.lastTranscriptAt = Date.now();
      this.clearSilenceTimer();
      return;
    }

    this.log.info('Speculative LLM start from stable interim', { text, confidence, state: this.state });

    this.consecutiveEmptyVADs = 0;
    this.emptyFinalStreak = 0;
    this.lastTranscriptAt = Date.now();
    this.clearSilenceTimer();

    this.latency.mark('stable_interim');

    this.speculativeText = text.trim();

    this.conversation.addUserMessage(text.trim());
    this.state = 'GENERATING';

    this.log.info('Stable interim → speculative LLM handoff', {
      transcriptLenChars: text.trim().length,
    });

    void this.generateAndSpeak();
  }

  // ─── Final Transcript ─────────────────────────────────────────────────────

  private handleFinalTranscript(text: string, confidence: number): void {
    if (this.state === 'ENDED') return;
    if (!text.trim()) return;

    if (this.session.bookingStatus === 'BOOKED' || this.conversationComplete) {
      this.log.info('Ignoring final transcript — conversation already complete', { text });
      return;
    }

    const prevName = this.session.info.name;
    const prevDate = this.session.info.preferredDate;
    const prevTime = this.session.info.preferredTime;

    this.session.advanceTurn();
    this.session.extractFromUserTranscript(text);

    this.consecutiveEmptyVADs = 0;
    this.emptyFinalStreak = 0;
    this.lastTranscriptAt = Date.now();
    this.clearSilenceTimer();

    const transcriptAt = Date.now();
    this.latency.mark('speech_final', transcriptAt);
    this.log.info('Final transcript received', {
      text, confidence, state: this.state, speculativeText: this.speculativeText,
    });

    // ── Speculative generation reconciliation ──────────────────────────
    // If a scheduling slot was newly captured this turn, any in-flight
    // speculation is stale — the deterministic template must take over.
    const schedulingSlotCaptured =
      (!prevDate && !!this.session.info.preferredDate) ||
      (!prevTime && !!this.session.info.preferredTime);

    if (this.speculativeText !== null) {
      const specText = this.speculativeText;
      this.speculativeText = null;
      const finalText = text.trim();

      if (!schedulingSlotCaptured && finalText === specText) {
        this.latency.recordSpeculation('confirmed_exact');
        this.log.info('Speculative generation CONFIRMED (exact match)', { text: specText });
        return;
      }

      if (!schedulingSlotCaptured && finalText.startsWith(specText) && specText.length >= 8) {
        this.latency.recordSpeculation('confirmed_prefix');
        this.log.info('Speculative generation CONFIRMED (prefix match)', {
          speculative: specText, final: finalText,
        });
        this.conversation.updateLastUserMessage(finalText);
        return;
      }

      this.latency.recordSpeculation(schedulingSlotCaptured ? 'invalidated_scheduling' : 'invalidated');
      this.log.warn('Speculative generation INVALIDATED — aborting', {
        speculative: specText, final: finalText, schedulingSlotCaptured,
      });
      this.generationId++;
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
      }
      this.tts.abort();
      this.twilioService.clearAudio(this.callSid);
      this.conversation.discardLastUserMessage();
      this.conversation.discardLastAssistantMessage();
      this.state = 'LISTENING';
      this.ensureSTTUnmuted();
    }

    // Transcript-gated barge-in
    if (this.state === 'SPEAKING' || this.state === 'GENERATING') {
      this.log.info('Transcript-gated barge-in: real speech confirmed during agent speech', {
        text, state: this.state,
      });
      this.handleInterruption();
    }

    if ((this.state as string) === 'ENDED') return;

    this.conversation.addUserMessage(text);

    // Pin messages with critical info extraction
    if (!prevName && this.session.info.name) {
      this.conversation.pinLastUserMessage('name:' + this.session.info.name);
    }
    if (!prevDate && this.session.info.preferredDate) {
      this.conversation.pinLastUserMessage('date:' + this.session.info.preferredDate);
    }
    if (!prevTime && this.session.info.preferredTime) {
      this.conversation.pinLastUserMessage('time:' + this.session.info.preferredTime);
    }

    // ── Deterministic scheduling responses (no LLM) ──────────────────
    const cannedScheduling = this.maybeCannedSchedulingResponse(prevDate, prevTime);
    if (cannedScheduling) {
      this.log.info('Scheduling response (deterministic, no LLM)', {
        template: cannedScheduling, bookingStatus: this.session.bookingStatus,
      });
      this.conversation.addAssistantText(cannedScheduling);
      this.session.extractFromAssistantResponse(cannedScheduling);
      this.speakCanned(cannedScheduling);
      return;
    }

    // ── Intent-based local routing (no LLM) ─────────────────────────
    const localResponse = this.maybeLocalIntentResponse(text);
    if (localResponse) {
      this.log.info('Intent routed locally (no LLM)', {
        response: localResponse, transcriptToResponseMs: Date.now() - transcriptAt,
      });
      const humanPrefix = Env.humanization.enabled
        ? maybeGetOpener(text)
        : '';
      const fullResponse = humanPrefix ? humanPrefix + localResponse : localResponse;
      this.conversation.addAssistantText(fullResponse);
      this.session.extractFromAssistantResponse(fullResponse);
      this.speakCanned(fullResponse);
      return;
    }

    this.state = 'GENERATING';

    this.log.info('Transcript → LLM handoff', {
      transcriptLenChars: text.length,
      transcriptToLlmMs: Date.now() - transcriptAt,
    });

    void this.generateAndSpeak();
  }

  // ─── Deterministic Scheduling Templates ─────────────────────────────────

  /**
   * If a scheduling slot was newly captured this turn, return the appropriate
   * canned response. Returns null if no scheduling transition happened (fall
   * through to LLM).
   */
  private maybeCannedSchedulingResponse(
    prevDate: string | null,
    prevTime: string | null,
  ): string | null {
    const { preferredDate, preferredTime, name } = this.session.info;
    const status = this.session.bookingStatus;

    // Both slots just completed → confirm visit
    if (status === 'CONFIRMATION_PENDING' && preferredDate && preferredTime) {
      const nameClause = name ? `${name} ji, ` : '';
      return `${nameClause}aapki ${preferredDate} ko ${preferredTime} ki visit book ho gayi hai. Aapka din shubh rahe.`;
    }

    // Date was newly captured, time still missing → ask time
    if (!prevDate && preferredDate && !preferredTime) {
      return `${preferredDate} works. Kis time aana convenient rahega aapke liye — morning ya afternoon?`;
    }

    // Time was newly captured, date still missing → ask day
    if (!prevTime && preferredTime && !preferredDate) {
      return `${preferredTime} noted. Kaunsa day aapke liye convenient rahega — weekday ya weekend?`;
    }

    return null;
  }

  // ─── Intent-Based Local Routing ─────────────────────────────────────────

  /**
   * Classify the user utterance and return a deterministic response if the
   * intent is a property-information query. Returns null to fall through to LLM.
   *
   * Skipped when:
   *  - Name hasn't been collected yet (GET_NAME flow needs LLM personality)
   *  - Booking is in progress (scheduling flow handles these)
   */
  private maybeLocalIntentResponse(userText: string): string | null {
    // Don't short-circuit LLM during name collection — needs conversational handling
    if (!this.session.info.name) {
      return null;
    }

    // Don't route locally during active scheduling
    const status = this.session.bookingStatus;
    if (status === 'DATE_CAPTURED' || status === 'TIME_CAPTURED' ||
        status === 'CONFIRMATION_PENDING' || status === 'BOOKED') {
      return null;
    }

    const classification = classifyIntent(userText);

    if (isLocallyRoutable(classification.intent)) {
      const response = buildLocalResponse(
        classification.intent,
        PROPERTY_FACTS,
        this.session.currentTurn,
      );

      if (response) {
        this.intentMetrics.record(classification.intent, 'local', classification.classificationTimeUs);
        return response;
      }
    }

    // Not locally routable — record as LLM-bound
    this.intentMetrics.record(classification.intent, 'llm', classification.classificationTimeUs);
    return null;
  }

  // ─── LLM + TTS Pipeline ───────────────────────────────────────────────────

  private async generateAndSpeak(opts: { suppressBargeIn?: boolean } = {}): Promise<void> {
    if (this.session.bookingStatus === 'BOOKED' && !this.session.shouldEndCall) {
      this.log.info('generateAndSpeak() blocked — booking already BOOKED');
      this.state = 'LISTENING';
      return;
    }

    const myGenId = ++this.generationId;
    this.activeResponseText = '';

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
    });
    this.latency.mark('llm_start');

    const tts = this.tts;
    tts.startTurn(`g${myGenId}`);

    this.state = 'SPEAKING';
    this.suppressBargeInArm = opts.suppressBargeIn ?? false;

    this.muteSTTForEchoBurst();

    if (!this.tts.isActive) {
      tts.open().then(() => {
        if (!this.latency.hasMarked('tts_open')) this.latency.mark('tts_open');
      }).catch((err: Error) => {
        this.log.error('TTS failed to open', err);
      });
    }

    let fullText = '';
    let firstToken = true;
    const humanPrefix = Env.humanization.enabled
      ? maybeGetOpener(this.conversation.getLastUserText())
      : '';

    // Inject session state into system prompt
    this.conversation.setSystemPromptSuffix(this.session.toPromptBlock());

    try {
      const stream = this.llm.stream(
        this.conversation.toMessages(),
        signal,
      );

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
            if (humanPrefix) {
              tts.streamText(humanPrefix);
            }
          }

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
      this.log.info('Generation interrupted, discarding partial response', { partialLength: fullText.length });
      tts.abort();
      return;
    }

    if (fullText.trim()) {
      const validationIssues = this.session.validateOutput(fullText);

      if (this.session.hasHallucinatedBooking(fullText)) {
        this.log.warn('HALLUCINATION DETECTED: LLM claimed booking without CONFIRMATION_PENDING', {
          text: fullText.substring(0, 100),
          bookingStatus: this.session.bookingStatus,
        });
      } else {
        this.session.extractFromAssistantResponse(fullText);
      }

      if (validationIssues.length > 0) {
        this.log.warn('Output validation issues detected', {
          issues: validationIssues, text: fullText.substring(0, 150),
        });
      }

      this.conversation.addAssistantText(fullText);
      this.log.info('LLM generation complete', { responseLength: fullText.length });

      if (this.session.shouldEndCall && !this.conversationComplete) {
        this.conversationComplete = true;
        this.log.info('Conversation complete — booking confirmed by session state', {
          name: this.session.info.name,
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
    if (genId !== this.generationId) return;
    if (this.state === 'ENDED') return;

    if (!this.latency.hasMarked('tts_first_audio')) {
      this.latency.mark('tts_first_audio');
      this.firstTTSAudioSentAt = Date.now();
      this.log.info('TTS first audio chunk received');

      if (!this.suppressBargeInArm) {
        this.bargeIn.arm();
      }
    }

    this.ttsAudioBytesSent += Math.floor(audioBase64.length * 0.75);

    // Sarvam mulaw@8kHz base64 → send directly to Twilio (same format)
    this.twilioService.sendAudio(this.callSid, audioBase64);

    if (!this.latency.hasMarked('twilio_playback_start')) {
      this.latency.mark('twilio_playback_start');
    }
  }

  private handleTTSDone(genId: number): void {
    if (genId !== this.generationId) return;

    this.latency.mark('tts_complete');
    this.ttsGenerationDone = true;

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
      this.transitionToListeningAfterPlayback(genId);
      return;
    }

    this.playbackCompleteTimer = setTimeout(() => {
      this.playbackCompleteTimer = null;
      if (genId === this.generationId) {
        this.transitionToListeningAfterPlayback(genId);
      }
    }, remainingMs);
  }

  private transitionToListeningAfterPlayback(genId: number): void {
    if (genId !== this.generationId) return;

    this.bargeIn.disarm();
    this.lastTTSCompleteAt = Date.now();

    if (this.state === 'ENDED') return;

    if (this.conversationComplete) {
      this.log.info('Playback complete — conversation complete, ending call');
      void this.end();
      return;
    }

    this.state = 'LISTENING';
    this.ensureSTTUnmuted();
    this.log.info('Playback complete — now LISTENING');

    this.prewarmTTS();
    this.startSilenceTimer();
  }

  private startSilenceTimer(): void {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (this.state !== 'LISTENING') return;
      if (Date.now() - this.lastRepromptAt < this.REPROMPT_MIN_GAP_MS) return;
      if (this.repromptCount >= this.MAX_REPROMPTS_PER_CALL) return;

      const now = Date.now();
      const recentActivity = Math.max(this.lastVADAt, this.lastTranscriptAt);
      if (recentActivity > 0 && now - recentActivity < 2000) {
        this.log.debug('Silence timer deferred (recent user activity)');
        this.startSilenceTimer();
        return;
      }

      this.lastRepromptAt = Date.now();
      this.repromptCount++;
      this.log.warn('Silence timer: reprompting caller', {
        repromptCount: this.repromptCount, silenceMs: this.SILENCE_TIMEOUT_MS,
      });
      const reprompt = this.REPROMPT_TEXTS[this.repromptTextIndex % this.REPROMPT_TEXTS.length];
      this.repromptTextIndex++;
      this.speakCanned(reprompt);
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

    if (this.conversationComplete) {
      this.log.info('Barge-in suppressed — conversation complete, letting final response finish');
      return;
    }

    this.log.info('Barge-in: interrupting AI response', {
      state: this.state, ttsGenerationDone: this.ttsGenerationDone,
      audioBytesSent: this.ttsAudioBytesSent,
    });
    this.latency.mark('barge_in');
    this.speculativeText = null;

    if (this.playbackCompleteTimer) {
      clearTimeout(this.playbackCompleteTimer);
      this.playbackCompleteTimer = null;
    }

    this.generationId++;

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      this.latency.mark('llm_cancelled');
    }

    this.tts.abort();
    this.latency.mark('tts_cancelled');

    this.twilioService.clearAudio(this.callSid);
    this.bargeIn.disarm();

    this.conversation.discardLastAssistantMessage();

    this.state = 'LISTENING';
    this.ensureSTTUnmuted();
    this.log.info('Barge-in handled — back to LISTENING');

    this.prewarmTTS();
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  private genIdFromContext(ctxId: string): number {
    const n = parseInt(ctxId.slice(1), 10);
    return Number.isNaN(n) ? -1 : n;
  }

  get currentState(): CallState { return this.state; }
}
