/**
 * NovaAudioStreamer: manages per-turn audio streaming to Nova Sonic.
 *
 * Each user speech segment = one Nova prompt turn:
 *
 *   beginUserTurn()   → promptStart + contentStart(SYS, first turn only) + contentStart(AUDIO)
 *   pushAudio(chunk)  → audioInput × N  (buffered and flushed)
 *   endUserTurn()     → contentEnd + promptEnd
 *
 * Content blocks are identified by contentName (unique string per block).
 */

import { v4 as uuidv4 } from 'uuid';
import { Env } from '../../config';
import { Logger } from '../../shared/Logger';
import { toBase64, pcmFrameBytes } from '../../utils/helpers';
import { AudioBuffer } from '../audio/AudioBuffer';
import { NovaClient } from './NovaClient';

export class NovaAudioStreamer {
  private readonly client: NovaClient;
  private readonly log: Logger;

  private readonly buffer: AudioBuffer;
  private readonly minChunkBytes: number;

  /** True only for the very first turn — system prompt is sent then. */
  private isFirstTurn: boolean = true;

  /** Whether a user turn is currently open. */
  private turnOpen: boolean = false;

  /** Current prompt name (one per turn). */
  private currentPromptName: string = '';

  /** contentName for the open USER audio block in the current turn. */
  private currentContentName: string = '';

  constructor(sessionId: string, callId: string, client: NovaClient) {
    this.client = client;
    this.log = Logger.forSession(sessionId, callId, 'NovaAudioStreamer');

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
   * Send a greeting turn (first turn only): system prompt + silent audio block +
   * promptEnd. Nova Sonic requires at least one audio block per prompt, so we send
   * 300ms of silence to satisfy the constraint. The hard promptEnd causes Nova to
   * respond immediately with a spoken greeting regardless of VAD.
   *
   * After completionEnd fires → onTurnComplete → beginUserTurn() opens the real
   * audio listening turn.
   */
  sendGreeting(): void {
    if (!this.client.isOpen) return;

    this.currentPromptName = this.client.startPrompt(true); // includes system
    this.currentContentName = `greet_${uuidv4().replace(/-/g, '')}`;

    // Open audio block (required by Nova Sonic — text-only turns are rejected)
    this.client.openAudioBlock(this.currentPromptName, this.currentContentName);

    // Send 300ms of PCM16 silence at 16kHz (16-bit mono = 2 bytes/sample)
    // promptEnd forces a response regardless of what audio was in the buffer.
    const silenceSamples = Math.floor(Env.audio.internalSampleRate * 0.3); // 300ms
    const silence = Buffer.alloc(silenceSamples * 2, 0);
    for (let offset = 0; offset < silence.length; offset += this.minChunkBytes) {
      const chunk = silence.subarray(offset, Math.min(offset + this.minChunkBytes, silence.length));
      this.client.sendAudio(this.currentPromptName, this.currentContentName, toBase64(chunk));
    }

    this.client.closeAudioBlock(this.currentPromptName, this.currentContentName);
    this.client.sendPromptEnd(this.currentPromptName);
    this.isFirstTurn = false;

    this.log.debug('Greeting turn sent (silence + promptEnd)', { promptName: this.currentPromptName });
  }

  /**
   * Open a new user turn.
   * Sends promptStart + contentStart(USER AUDIO).
   * System prompt is only included on first turn (if sendGreeting() was not called).
   */
  beginUserTurn(): void {
    if (this.turnOpen || !this.client.isOpen) return;

    const includeSystem = this.isFirstTurn;

    this.currentPromptName = this.client.startPrompt(includeSystem);
    this.currentContentName = `audio_${uuidv4().replace(/-/g, '')}`;

    this.client.openAudioBlock(this.currentPromptName, this.currentContentName);

    this.isFirstTurn = false;
    this.turnOpen = true;

    this.log.debug('User turn opened', {
      promptName: this.currentPromptName,
      contentName: this.currentContentName,
      systemIncluded: includeSystem,
    });
  }

  /**
   * Push a noise-suppressed PCM16 chunk. Flushes to Nova when a full frame
   * has accumulated.
   */
  pushAudio(pcm16: Buffer): void {
    if (!this.turnOpen || !this.client.isOpen || pcm16.length === 0) return;
    this.buffer.push(pcm16);
    this.flush();
  }

  /**
   * Close the user turn: flush remaining audio, send contentEnd + promptEnd.
   * Nova Sonic will begin generating its response after promptEnd.
   */
  endUserTurn(): void {
    if (!this.turnOpen) return;

    const remaining = this.buffer.drain();
    if (remaining.length > 0) {
      this.sendChunk(remaining);
    }

    this.client.closeAudioBlock(this.currentPromptName, this.currentContentName);
    this.client.sendPromptEnd(this.currentPromptName);
    this.turnOpen = false;

    this.log.debug('User turn ended — promptEnd sent', {
      promptName: this.currentPromptName,
    });
  }

  /**
   * Barge-in: discard buffered audio, close the block early, signal Nova.
   */
  handleInterruption(): void {
    this.buffer.clear();
    if (this.turnOpen) {
      this.client.closeAudioBlock(this.currentPromptName, this.currentContentName);
      this.client.sendPromptEnd(this.currentPromptName);
      this.turnOpen = false;
      this.log.info('User turn interrupted — buffer cleared', {
        promptName: this.currentPromptName,
      });
    }
  }

  private flush(): void {
    while (this.buffer.hasBytes(this.minChunkBytes)) {
      this.sendChunk(this.buffer.read(this.minChunkBytes));
    }
  }

  private sendChunk(chunk: Buffer): void {
    this.client.sendAudio(this.currentPromptName, this.currentContentName, toBase64(chunk));
  }

  get isTurnOpen(): boolean {
    return this.turnOpen;
  }

  get promptName(): string {
    return this.currentPromptName;
  }
}
