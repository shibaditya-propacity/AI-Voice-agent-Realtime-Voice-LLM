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

    // Send greeting immediately — agent speaks first so caller isn't met with silence.
    // Pre-recorded greeting plays instantly; LLM+TTS warmup happens in parallel.
    if (hasGreetingAudio()) {
      this.sendCachedGreeting();
    } else {
      void this.sendLLMGreeting();
    }
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

    // Buffer initial LLM text until chunk_length_schedule[0]=50 chars so that
    // ElevenLabs immediately begins audio generation on the first send rather
    // than waiting for enough text to accumulate token-by-token. Without this,
    // TTS latency scales with response length (227ms→529ms→781ms) because
    // ElevenLabs holds audio until it has enough text for a prosody unit.
    let ttsTextBuffer = '';
    let initialBufferFlushed = false;
    // Must match ElevenLabs chunk_length_schedule[0] minimum (50).
    // try_trigger_generation=true on first send bypasses the schedule anyway.
    const TTS_INITIAL_BUFFER_CHARS = 50;

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

          if (!initialBufferFlushed) {
            ttsTextBuffer += text;
            if (ttsTextBuffer.length >= TTS_INITIAL_BUFFER_CHARS) {
              initialBufferFlushed = true;
              this.latency.mark('tts_first_text');
              tts.streamText(ttsTextBuffer);
              ttsTextBuffer = '';
            }
          } else {
            tts.streamText(text);
          }
        }
      }

      // Short response: buffer never hit threshold — flush now so TTS gets the text
      if (!initialBufferFlushed && ttsTextBuffer) {
        this.latency.mark('tts_first_text');
        tts.streamText(ttsTextBuffer);
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
