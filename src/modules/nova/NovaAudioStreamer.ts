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
import { Logger } from '../../shared/Logger';
import { toBase64, pcmFrameBytes } from '../../utils/helpers';
import { AudioBuffer } from '../audio/AudioBuffer';
import { NovaClient } from './NovaClient';

export class NovaAudioStreamer {
  private readonly client: NovaClient;
  private readonly log: Logger;

  private readonly buffer: AudioBuffer;
  private readonly minChunkBytes: number;

  /** Whether the (single, long-lived) conversation prompt is open. */
  private conversationOpen: boolean = false;

  /** The one prompt name used for the whole call. */
  private currentPromptName: string = '';

  /** contentName for the single continuous USER audio block. */
  private audioContentName: string = '';

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
   * Open the single, long-lived conversation prompt for the whole call:
   *
   *   promptStart + SYSTEM text block            (the agent persona/instructions)
   *   USER text greeting cue ("Hello?")          (makes Nova speak the greeting)
   *   contentStart(AUDIO, interactive:true)      (left OPEN for the whole call)
   *
   * Why a text cue and not silence: Nova 2 produces NO output from silence
   * (confirmed by scripts/test-nova-v2.ts) — it needs real speech or text. A short
   * USER text turn deterministically elicits the spoken greeting defined by the
   * system prompt, then the open interactive audio block lets Nova listen and
   * respond to every subsequent caller utterance via its own VAD — no per-turn
   * promptEnd required.
   */
  startConversation(): void {
    if (this.conversationOpen || !this.client.isOpen) return;

    // promptStart + SYSTEM content block (system prompt is sent once for the call).
    this.currentPromptName = this.client.startPrompt(true);

    // Greeting cue: a USER text turn that reliably triggers a spoken greeting.
    const cueContentName = `cue_${uuidv4().replace(/-/g, '')}`;
    this.client.sendUserTextBlock(this.currentPromptName, cueContentName, Env.nova.greetingTrigger);

    // ONE interactive audio block for the entire call. Nova's VAD drives turn-taking.
    this.audioContentName = `audio_${uuidv4().replace(/-/g, '')}`;
    this.client.openAudioBlock(this.currentPromptName, this.audioContentName, true);

    this.conversationOpen = true;

    this.log.info('Conversation opened (system + greeting cue + continuous audio block)', {
      promptName: this.currentPromptName,
      cueContentName,
      audioContentName: this.audioContentName,
      greetingTrigger: Env.nova.greetingTrigger,
      interactive: true,
    });
  }

  /**
   * Push a noise-suppressed PCM16 chunk into the open audio block. Flushes to Nova
   * when a full frame has accumulated. Nova's VAD detects when the caller stops and
   * responds automatically.
   */
  pushAudio(pcm16: Buffer): void {
    if (!this.conversationOpen || !this.client.isOpen || pcm16.length === 0) return;
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
    this.client.sendAudio(this.currentPromptName, this.audioContentName, toBase64(chunk));
  }

  get isConversationOpen(): boolean {
    return this.conversationOpen;
  }

  get promptName(): string {
    return this.currentPromptName;
  }
}
