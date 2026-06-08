/**
 * NovaAudioStreamer: streams caller audio to Nova Sonic v2 using its native
 * continuous conversational model — ONE long-lived prompt per call.
 *
 *   startConversation() → promptStart + SYSTEM text + USER text greeting cue
 *                         + contentStart(AUDIO, interactive:true)   [block stays open]
 *   pushAudio(chunk)    → audioInput × N  (buffered and flushed into the open block)
 *   finishConversation()→ contentEnd + promptEnd                    [call teardown only]
 *
 * Nova's own VAD (turnDetectionConfiguration) detects the end of each caller
 * utterance and emits a full completionStart…completionEnd response cycle on the
 * SAME audio block — so we do NOT open/close a prompt per turn. The app has no
 * end-of-speech detector of its own, so relying on Nova's VAD here is mandatory.
 *
 * Content blocks are identified by contentName (unique string per block).
 */

import { v4 as uuidv4 } from 'uuid';
import { Env } from '../../config';
import { callTrace } from '../../shared/CallTraceLogger';
import { Logger } from '../../shared/Logger';
import { toBase64, pcmFrameBytes } from '../../utils/helpers';
import { AudioBuffer } from '../audio/AudioBuffer';
import { NovaClient } from './NovaClient';

export class NovaAudioStreamer {
  private readonly client: NovaClient;
  private readonly log: Logger;
  private readonly sessionId: string;
  private readonly callId: string;

  private readonly buffer: AudioBuffer;
  private readonly minChunkBytes: number;

  /** Whether the (single, long-lived) conversation prompt is open. */
  private conversationOpen: boolean = false;

  /** The one prompt name used for the whole call. */
  private currentPromptName: string = '';

  /** contentName for the single continuous USER audio block. */
  private audioContentName: string = '';

  /**
   * Caller audio is dropped until the opening greeting finishes, so an overlapping
   * "hello" / line noise can't trigger Nova to re-greet 2–3 times. Set true once the
   * greeting turn completes (or after a safety timeout).
   */
  private listening: boolean = false;
  private greetingGateTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * First-turn speech gate. Once the mic opens (listening=true) we still hold caller
   * audio OUT of Nova until the caller actually starts speaking, so Nova can't
   * endpoint on the post-greeting silence and answer the prime turn early (talking
   * over the caller's name). `speechStarted` latches true on the first speech frame
   * (or the fallback timer) and stays true for the rest of the call — subsequent
   * turns are unaffected. `preRoll` keeps a short lead-in so the first word isn't
   * clipped when the gate opens.
   */
  private speechStarted: boolean = false;
  private preRoll: Buffer[] = [];
  private preRollBytes: number = 0;
  private speechGateTimer: ReturnType<typeof setTimeout> | null = null;
  /** Keep ~200ms of pre-roll @ internal rate (16-bit mono). */
  private readonly preRollMaxBytes: number = Math.floor(0.2 * Env.audio.internalSampleRate) * 2;

  /** RMS energy of a PCM16-LE buffer (for the first-turn speech gate). */
  private static computeRms(pcm16: Buffer): number {
    const samples = pcm16.length >> 1;
    if (samples === 0) return 0;
    let sumSq = 0;
    for (let i = 0; i < samples; i++) {
      const s = pcm16.readInt16LE(i * 2);
      sumSq += s * s;
    }
    return Math.sqrt(sumSq / samples);
  }

  constructor(sessionId: string, callId: string, client: NovaClient) {
    this.client = client;
    this.log = Logger.forSession(sessionId, callId, 'NovaAudioStreamer');
    this.sessionId = sessionId;
    this.callId = callId;

    this.buffer = new AudioBuffer({
      maxBytes: Env.audio.bufferMaxBytes,
      sessionId,
      callId,
    });

    this.minChunkBytes = pcmFrameBytes(
      Env.audio.chunkMs,
      Env.audio.internalSampleRate,
      16,
      1,
    );
  }

  /**
   * Open the single, long-lived conversation prompt for the whole call:
   *
   *   promptStart + SYSTEM text block            (the agent persona/instructions)
   *   USER text cue ("Hello?") + contentEnd      (primes Nova's conversational mode)
   *   contentStart(AUDIO, interactive:true)      (left OPEN for the whole call)
   *
   * The USER text cue is required per the Nova 2 Sonic event sequence. Its contentEnd
   * triggers Nova to start a response (the greeting). The opening greeting audio is a
   * pre-recorded WAV played separately, and the system prompt tells Nova the greeting
   * was already played so it does not re-greet. The interactive audio block then stays
   * open for the entire call — Nova's VAD drives every turn from the caller's first
   * utterance onward.
   */
  startConversation(opts?: { greetingGateMs?: number }): void {
    if (this.conversationOpen || !this.client.isOpen) return;

    // promptStart + SYSTEM content block (system prompt is sent once for the call).
    this.currentPromptName = this.client.startPrompt(true);

    // Prime the conversation before opening the interactive AUDIO block. A text
    // content block with contentEnd must precede the audio block, otherwise Nova
    // opens the block but never activates its VAD for turn-taking (silence after the
    // greeting). Two modes:
    //
    //   'assistant' (default) — inject the greeting as Nova's OWN prior turn. Nova
    //       then has nothing to answer, so it stays quiet and WAITS for the caller's
    //       reply (their name). This is the fix for Nova talking over / dropping the
    //       caller's name. The static WAV speaks the same line to the caller.
    //   'cue' (legacy) — a USER text turn that makes Nova respond immediately. Falls
    //       back here if assistant-priming leaves Nova silent on this account.
    const primeContentName = `prime_${uuidv4().replace(/-/g, '')}`;
    if (Env.nova.firstTurnMode === 'assistant') {
      this.client.sendAssistantTextBlock(
        this.currentPromptName,
        primeContentName,
        Env.nova.greetingText,
      );
    } else if (Env.nova.firstTurnMode === 'cue') {
      this.client.sendUserTextBlock(
        this.currentPromptName,
        primeContentName,
        Env.nova.firstTurnCue,
      );
    }
    // 'none': send no cue at all. Nova waits for the caller's audio (their name) to
    // drive the first turn — the same VAD path that every later turn already uses —
    // so the name is transcribed instead of Nova answering a cue with a placeholder.

    // ONE interactive audio block for the entire call. Nova's VAD drives turn-taking;
    // the caller's first utterance is the first turn.
    this.audioContentName = `audio_${uuidv4().replace(/-/g, '')}`;
    this.client.openAudioBlock(this.currentPromptName, this.audioContentName, true);

    this.conversationOpen = true;

    // Hold off feeding caller audio to Nova until the static greeting has finished
    // playing, so the caller's reply during the greeting isn't half-captured. Opens
    // after the greeting duration (+buffer); falls back to a short default if unknown.
    this.listening = false;
    const gateMs = Math.max(opts?.greetingGateMs ?? 1_500, 500);
    this.greetingGateTimer = setTimeout(() => this.startListening('greeting-finished'), gateMs);
    if (typeof this.greetingGateTimer.unref === 'function') this.greetingGateTimer.unref();

    this.log.info('Conversation opened (SYSTEM + greeting prime + interactive audio block; static greeting plays separately)', {
      promptName: this.currentPromptName,
      primeMode: Env.nova.firstTurnMode,
      primeContentName,
      audioContentName: this.audioContentName,
      gateMs,
      interactive: true,
    });
  }

  /**
   * Begin feeding caller audio to Nova. Called when the greeting turn completes (or
   * on the safety timeout). Idempotent.
   */
  startListening(reason: string): void {
    if (this.listening) return;
    this.listening = true;
    if (this.greetingGateTimer) {
      clearTimeout(this.greetingGateTimer);
      this.greetingGateTimer = null;
    }
    this.buffer.clear(); // drop anything that arrived during the greeting

    // Arm the first-turn speech gate: hold audio out of Nova until the caller speaks.
    // A fallback force-opens it so a silent caller still gets a Nova re-engagement.
    const gateMs = Env.nova.firstTurnSpeechGateMs;
    if (gateMs > 0) {
      this.speechStarted = false;
      this.preRoll = [];
      this.preRollBytes = 0;
      this.speechGateTimer = setTimeout(() => this.openSpeechGate('speech-gate-timeout'), gateMs);
      if (typeof this.speechGateTimer.unref === 'function') this.speechGateTimer.unref();
    } else {
      this.speechStarted = true; // gate disabled — feed audio immediately
    }

    callTrace.event(this.callId, this.sessionId, 'mic.open', { reason, speechGateMs: gateMs });
    this.log.info('Greeting done — now listening to caller audio', { reason, speechGateMs: gateMs });
  }

  /** Open the first-turn speech gate: flush any pre-roll, then feed audio normally. */
  private openSpeechGate(reason: string): void {
    if (this.speechStarted) return;
    this.speechStarted = true;
    if (this.speechGateTimer) {
      clearTimeout(this.speechGateTimer);
      this.speechGateTimer = null;
    }
    // Flush the buffered pre-roll so the caller's first word isn't clipped.
    for (const frame of this.preRoll) this.buffer.push(frame);
    this.preRoll = [];
    this.preRollBytes = 0;
    callTrace.event(this.callId, this.sessionId, 'speech-gate.open', { reason });
    this.log.info('First-turn speech gate opened — forwarding caller audio to Nova', { reason });
    this.flush();
  }

  /**
   * Push a noise-suppressed PCM16 chunk into the open audio block. Flushes to Nova
   * when a full frame has accumulated. Nova's VAD detects when the caller stops and
   * responds automatically.
   */
  pushAudio(pcm16: Buffer): void {
    if (!this.conversationOpen || !this.client.isOpen || pcm16.length === 0) return;
    // Ignore caller audio until the greeting has finished playing.
    if (!this.listening) return;

    // First-turn speech gate: before the caller starts speaking, hold audio in a
    // short rolling pre-roll instead of sending silence to Nova (which would make it
    // answer the prime turn early and talk over the caller's name).
    if (!this.speechStarted) {
      if (NovaAudioStreamer.computeRms(pcm16) < Env.audio.vadRmsThreshold) {
        this.preRoll.push(pcm16);
        this.preRollBytes += pcm16.length;
        while (this.preRollBytes > this.preRollMaxBytes && this.preRoll.length > 1) {
          this.preRollBytes -= this.preRoll.shift()!.length;
        }
        return;
      }
      this.openSpeechGate('speech-detected');
    }

    this.buffer.push(pcm16);
    this.flush();
  }

  /**
   * End the whole conversation (call teardown): flush remaining audio, then close
   * the audio block and the prompt. Nova finishes any in-flight response and the
   * stream is closed by the client (sessionEnd).
   */
  finishConversation(): void {
    if (!this.conversationOpen) return;

    if (this.greetingGateTimer) {
      clearTimeout(this.greetingGateTimer);
      this.greetingGateTimer = null;
    }
    if (this.speechGateTimer) {
      clearTimeout(this.speechGateTimer);
      this.speechGateTimer = null;
    }

    const remaining = this.buffer.drain();
    if (remaining.length > 0) {
      this.sendChunk(remaining);
    }

    this.client.closeAudioBlock(this.currentPromptName, this.audioContentName);
    this.client.sendPromptEnd(this.currentPromptName);
    this.conversationOpen = false;

    this.log.debug('Conversation finished — contentEnd + promptEnd sent', {
      promptName: this.currentPromptName,
    });
  }

  /**
   * Inject a USER text cue into the open prompt to trigger a Nova response when the
   * caller has been silent too long. Nova treats it as an end-of-turn signal and
   * generates a re-engagement reply (e.g. "Are you still there?").
   * No-op if the conversation is not open or the client is closed.
   */
  sendSilencePrompt(text: string): void {
    if (!this.conversationOpen || !this.client.isOpen) return;
    const cueContentName = `silence_${uuidv4().replace(/-/g, '')}`;
    this.client.sendUserTextBlock(this.currentPromptName, cueContentName, text);
    this.log.info('🔇 Silence prompt injected — waiting for Nova re-engagement response', {
      promptName: this.currentPromptName,
      cueContentName,
    });
  }

  /**
   * Promote a caller utterance that was captured DURING an interruption into an
   * explicit new USER turn, so Nova generates a fresh response to it. Nova sometimes
   * transcribes barge-in speech but never answers it (it resumes its prior response);
   * re-injecting the final transcript as a USER text block forces Nova to respond to
   * the caller's actual words. Mirrors sendSilencePrompt's mechanism.
   */
  promoteUserTurn(text: string): void {
    if (!this.conversationOpen || !this.client.isOpen) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const cueContentName = `promote_${uuidv4().replace(/-/g, '')}`;
    this.client.sendUserTextBlock(this.currentPromptName, cueContentName, trimmed);
    this.log.info('Promoted interrupted caller transcript to a new USER turn', {
      promptName: this.currentPromptName,
      cueContentName,
      preview: trimmed.slice(0, 80),
    });
  }

  /**
   * Barge-in: Nova handles turn-taking natively on the interactive audio block, so
   * we keep the block open and simply drop any buffered inbound audio. The outbound
   * (caller-facing) audio is cleared separately by the AudioRouter via Twilio.
   */
  handleInterruption(): void {
    this.buffer.clear();
    this.log.info('Barge-in — inbound buffer cleared (Nova manages the turn natively)', {
      promptName: this.currentPromptName,
    });
  }

  private flush(): void {
    while (this.buffer.hasBytes(this.minChunkBytes)) {
      this.sendChunk(this.buffer.read(this.minChunkBytes));
    }
  }

  private sendChunk(chunk: Buffer): void {
    const out = NovaAudioStreamer.applyGain(chunk, Env.audio.inputGain);
    this.client.sendAudio(this.currentPromptName, this.audioContentName, toBase64(out));
  }

  /**
   * Apply a linear gain to PCM16-LE samples (clamped to int16) so Nova hears quiet
   * callers. Returns the input unchanged when gain ≈ 1.0. Operates on a COPY so the
   * caller's buffer (used elsewhere for RMS/VAD) is never mutated.
   */
  private static applyGain(pcm16: Buffer, gain: number): Buffer {
    if (!gain || Math.abs(gain - 1) < 1e-3) return pcm16;
    const out = Buffer.allocUnsafe(pcm16.length);
    const n = pcm16.length >> 1;
    for (let i = 0; i < n; i++) {
      let s = Math.round(pcm16.readInt16LE(i * 2) * gain);
      if (s > 32767) s = 32767;
      else if (s < -32768) s = -32768;
      out.writeInt16LE(s, i * 2);
    }
    // Handle a trailing odd byte (shouldn't occur for PCM16, but stay safe).
    if (pcm16.length & 1) out[pcm16.length - 1] = pcm16[pcm16.length - 1];
    return out;
  }

  get isConversationOpen(): boolean {
    return this.conversationOpen;
  }

  get promptName(): string {
    return this.currentPromptName;
  }

  /** Whether the greeting gate has opened (caller audio is being fed to Nova). */
  get isListening(): boolean {
    return this.listening;
  }
}
