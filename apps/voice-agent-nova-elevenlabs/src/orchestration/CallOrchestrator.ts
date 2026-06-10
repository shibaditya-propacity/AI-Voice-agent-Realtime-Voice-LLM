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
 *   2. BargeInDetector confirms (or RMS backup triggers)
 *   3. ElevenLabs stream aborted, generation AbortController signalled
 *   4. Twilio `clear` sent (flushes Twilio's jitter buffer)
 *   5. Partial assistant message discarded from history
 *   6. State → LISTENING; Deepgram continues collecting the utterance
 *   7. Final transcript → fresh LLM call
 */

import { DeepgramSTT } from '../stt/DeepgramSTT';
import { BedrockLLM }  from '../llm/BedrockLLM';
import { ElevenLabsTTS } from '../tts/ElevenLabsTTS';
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

  /** Active ElevenLabs TTS stream (null when not speaking). */
  private tts: ElevenLabsTTS | null = null;

  /**
   * Pre-opened ElevenLabs WS — started during user speech to hide
   * connection latency. Consumed by the next generateAndSpeak() call.
   */
  private prewarmedTTS: ElevenLabsTTS | null = null;

  /** Tracks the full text accumulated so far in the active generation. */
  private activeResponseText = '';

  /**
   * When true, the active generation should NOT arm the barge-in detector
   * on first TTS audio (e.g. during greeting, or if caller set suppressBargeIn).
   */
  private suppressBargeInArm = false;

  constructor(callSid: string, twilioService: TwilioService) {
    this.callSid        = callSid;
    this.twilioService  = twilioService;
    this.stt            = new DeepgramSTT(callSid);
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
      .onTranscript((text, conf) => this.handleFinalTranscript(text, conf))
      .onErr((err)               => this.log.error('STT error', err));

    // Wire barge-in detector
    this.bargeIn.onInterruption(() => this.handleInterruption());

    this.stt.connect();
    this.log.info('Call orchestrator ready', { state: this.state });

    // Send greeting immediately — agent speaks first so caller isn't met with silence
    void this.sendGreeting();
  }

  /**
   * Generates and speaks an opening greeting via LLM + TTS.
   * Uses a synthetic prompt so no real user turn is added to history.
   */
  private async sendGreeting(): Promise<void> {
    this.log.info('Sending greeting');
    this.conversation.addUserMessage(Env.llm.greetingPrompt);
    this.state = 'GENERATING';
    // suppressBargeIn=true: greeting must play to completion — barge-in during
    // greeting would just be Twilio connection noise, not a real user utterance.
    await this.generateAndSpeak({ suppressBargeIn: true });
    // After greeting, remove the synthetic prompt from history so it
    // doesn't pollute the real conversation context
    this.conversation.discardGreetingTurn();
  }

  /** Called for every inbound audio frame from Twilio. */
  handleInboundAudio(audioBase64: string): void {
    if (this.state === 'ENDED') return;

    // Drop first 500ms of audio — Twilio call-connect ring-down noise is
    // extremely loud (RMS ~30000) and would flood Deepgram with garbage.
    if (Date.now() - this.callStartAt < this.CALL_START_AUDIO_DROP_MS) return;

    const pcmu = Buffer.from(audioBase64, 'base64');

    // Check for energy-based barge-in (backup path)
    if (this.state === 'SPEAKING' || this.state === 'GENERATING') {
      this.bargeIn.processAudio(pcmu);
    }

    // Forward raw PCMU to Deepgram — no codec conversion needed.
    this.stt.sendAudio(pcmu);
  }

  async end(): Promise<void> {
    if (this.state === 'ENDED') return;
    this.state = 'ENDED';

    this.log.info('Call ending');
    this.latency.mark('call_end');

    this.bargeIn.disarm();

    // Abort any active generation
    this.abortController?.abort();

    // Close TTS and any pre-warmed connection
    if (this.tts) {
      this.tts.abort();
      this.tts = null;
    }
    if (this.prewarmedTTS) {
      this.prewarmedTTS.abort();
      this.prewarmedTTS = null;
    }

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
   * Open an ElevenLabs WebSocket during the user's speech window so it's
   * already connected when generateAndSpeak() needs it. Hides ~300-500ms
   * of TTS connection overhead from the critical path.
   */
  private prewarmTTS(): void {
    // If existing prewarm is still active, don't replace it
    if (this.prewarmedTTS?.isActive) return;

    // Discard stale prewarm (ElevenLabs idle-timeout closes WS after ~10s)
    if (this.prewarmedTTS) {
      this.log.debug('Discarding stale pre-warmed TTS, re-prewarming');
      this.prewarmedTTS.abort();
      this.prewarmedTTS = null;
    }

    this.latency.mark('tts_prewarm_start');
    this.log.debug('Pre-warming ElevenLabs connection');

    const tts = new ElevenLabsTTS(this.callSid);
    this.prewarmedTTS = tts;

    tts.open().then(() => {
      this.latency.mark('tts_open');
      this.log.info('ElevenLabs pre-warm ready');
    }).catch((err: Error) => {
      this.log.warn('ElevenLabs pre-warm failed', { error: err.message });
      if (this.prewarmedTTS === tts) this.prewarmedTTS = null;
    });
  }

  // ─── VAD / Speech Events ──────────────────────────────────────────────────

  private handleSpeechStarted(): void {
    this.latency.mark('speech_started');
    this.log.info('Speech started (VAD)', { state: this.state });

    if (this.state === 'LISTENING') {
      // Start pre-warming TTS during user's speech window to hide connect latency
      this.prewarmTTS();
    }

    // Primary barge-in path: Deepgram VAD detected voice during AI speech
    if (this.state === 'SPEAKING' || this.state === 'GENERATING') {
      this.bargeIn.handleSpeechStarted();
    }
  }

  // ─── Final Transcript ─────────────────────────────────────────────────────

  private handleFinalTranscript(text: string, confidence: number): void {
    if (this.state === 'ENDED') return;
    if (!text.trim()) return;

    const transcriptAt = Date.now();
    this.latency.mark('speech_final', transcriptAt);
    this.log.info('Final transcript received', {
      text,
      confidence,
      state: this.state,
      speechFinalToNowMs: 0, // this IS the speech_final event
    });

    // If we're still generating/speaking, the barge-in should have fired first.
    // If it somehow didn't, treat arriving transcript as an interrupt.
    if (this.state === 'SPEAKING' || this.state === 'GENERATING') {
      this.log.warn('Transcript arrived while AI active — forcing interruption');
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

    this.abortController = new AbortController();
    const { signal } = this.abortController;

    this.log.info('Starting LLM generation', {
      generationId: myGenId,
      turns: this.conversation.messageCount,
      suppressBargeIn: opts.suppressBargeIn ?? false,
      abortControllerCreated: true,
    });
    this.latency.mark('llm_start');

    // Consume pre-warmed TTS if still alive, otherwise create a fresh one.
    // Prewarm may have gone stale if ElevenLabs timed out the idle WS (~10s).
    const prewarmed = this.prewarmedTTS;
    this.prewarmedTTS = null;
    if (prewarmed && !prewarmed.isActive) {
      this.log.warn('Pre-warmed TTS went stale — using fresh connection');
      prewarmed.abort();
    }
    const tts = (prewarmed?.isActive) ? prewarmed : new ElevenLabsTTS(this.callSid);

    tts
      .onAudio((audio) => this.handleTTSAudio(audio, myGenId))
      .onDone(()       => this.handleTTSDone(myGenId))
      .onError((err)   => this.log.error('TTS error', err));

    this.tts = tts;
    this.state = 'SPEAKING';
    // Record whether barge-in should be armed for this generation.
    // We do NOT arm here — arm() is deferred to the first TTS audio chunk
    // so that trailing audio frames from the user's own speech (still
    // flowing through the buffer when generation starts) cannot trigger
    // a false barge-in and abort the LLM before it has sent a single token.
    this.suppressBargeInArm = opts.suppressBargeIn ?? false;

    // Start LLM streaming immediately — do NOT await tts.open() first.
    // streamText() buffers in textQueue while TTS is still connecting;
    // open() resolves in parallel and drains the queue automatically.
    const ttsOpenPromise = tts.open().then(() => {
      if (!this.latency.hasMarked('tts_open')) this.latency.mark('tts_open');
    }).catch((err: Error) => {
      this.log.error('ElevenLabs failed to open', err);
    });

    let fullText = '';
    let firstToken = true;
    let firstTextToTTS = true;

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
            this.log.info('LLM first token received');
          }

          if (firstTextToTTS) {
            firstTextToTTS = false;
            this.latency.mark('tts_first_text');
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
      // Interrupted — don't add partial response to history
      this.log.info('Generation interrupted, discarding partial response', { partialLength: fullText.length });
      tts.abort();
      this.tts = null;
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
      this.log.info('TTS first audio chunk received');

      // Arm barge-in HERE — not at generation start — so that trailing audio
      // frames from the user's own completed speech cannot trigger a false
      // barge-in during the LLM's generation window. By the time first TTS
      // audio arrives (~LLM_TTFT + TTS_latency ≈ 2s), user frames are gone.
      if (!this.suppressBargeInArm) {
        this.bargeIn.arm();
      }
    }

    // ElevenLabs ulaw_8000 base64 → send directly to Twilio (same format, zero conversion)
    this.twilioService.sendAudio(this.callSid, audioBase64);

    if (!this.latency.hasMarked('twilio_playback_start')) {
      this.latency.mark('twilio_playback_start');
    }
  }

  private handleTTSDone(genId: number): void {
    if (genId !== this.generationId) return;

    this.latency.mark('tts_complete');
    this.log.info('TTS complete');
    this.latency.logTurnSummary(this.conversation.currentTurn);

    this.tts = null;
    this.bargeIn.disarm();

    if (this.state !== 'ENDED') {
      this.state = 'LISTENING';
    }
  }

  // ─── Barge-in / Interruption ──────────────────────────────────────────────

  private handleInterruption(): void {
    if (this.state !== 'SPEAKING' && this.state !== 'GENERATING') return;

    this.log.info('Barge-in: interrupting AI response', { state: this.state });
    this.latency.mark('barge_in');

    // Bump generation ID — marks all in-flight audio/text as stale
    this.generationId++;

    // Abort the LLM stream
    if (this.abortController) {
      this.log.info('Aborting LLM AbortController', { generationId: this.generationId });
      this.abortController.abort();
      this.abortController = null;
    }

    // Abort TTS and clear Twilio's jitter buffer
    if (this.tts) {
      this.tts.abort();
      this.tts = null;
    }

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

  get currentState(): CallState { return this.state; }
}
