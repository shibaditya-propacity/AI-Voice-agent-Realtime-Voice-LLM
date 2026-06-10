/**
 * ElevenLabsTTS: per-response streaming TTS via ElevenLabs WebSocket API.
 *
 * Audio output format: ulaw_8000 — raw μ-law bytes at 8 kHz.
 * This is directly compatible with Twilio's media stream format.
 * No codec conversion is required; the base64 from ElevenLabs can be
 * forwarded as-is to Twilio's `media` event payload.
 *
 * Lifecycle per LLM response:
 *   1. open()        — connect to ElevenLabs WebSocket
 *   2. streamText()  — feed text chunks as they arrive from LLM
 *   3. flush()       — signal end of text input
 *   4. wait for onComplete callback
 *   5. close() / abort()
 */

import WebSocket from 'ws';
import { Env } from '../config/env';
import { Logger } from '../shared/logger';
import type {
  ElevenLabsInitMessage,
  ElevenLabsAudioResponse,
  OnAudioChunk,
  OnTTSComplete,
  OnTTSError,
} from './types';

const ELEVENLABS_WS_BASE = 'wss://api.elevenlabs.io/v1/text-to-speech';

export type TTSState = 'idle' | 'connecting' | 'open' | 'flushed' | 'done' | 'aborted' | 'error';

export class ElevenLabsTTS {
  private ws: WebSocket | null = null;
  private state: TTSState = 'idle';
  private readonly log: Logger;

  private onAudioChunk?: OnAudioChunk;
  private onComplete?: OnTTSComplete;
  private onErr?: OnTTSError;

  /** Text chunks buffered while WS is still connecting */
  private readonly textQueue: string[] = [];
  /** True if flush() was called while still connecting — send it once open */
  private pendingFlush = false;
  /**
   * True once the first text chunk has been sent.
   * The first chunk always includes try_trigger_generation:true so ElevenLabs
   * starts audio generation immediately without waiting for chunk_length_schedule.
   */
  private firstTextSent = false;
  private openPromise: Promise<void> | null = null;
  private openResolve: (() => void) | null = null;
  private openReject: ((err: Error) => void) | null = null;

  constructor(callSid: string) {
    this.log = Logger.forCall(callSid, 'ElevenLabsTTS');
  }

  // ─── Callback Registration ────────────────────────────────────────────────

  onAudio(cb: OnAudioChunk): this    { this.onAudioChunk = cb; return this; }
  onDone(cb: OnTTSComplete): this    { this.onComplete = cb;   return this; }
  onError(cb: OnTTSError): this      { this.onErr = cb;        return this; }

  // ─── Connection ───────────────────────────────────────────────────────────

  open(): Promise<void> {
    if (this.openPromise) return this.openPromise;

    this.state = 'connecting';
    this.openPromise = new Promise<void>((resolve, reject) => {
      this.openResolve = resolve;
      this.openReject  = reject;
    });

    const params = new URLSearchParams({
      model_id:                  Env.elevenlabs.modelId,
      output_format:             'ulaw_8000',
      optimize_streaming_latency: String(Env.elevenlabs.optimizeLatency),
    });

    const url = `${ELEVENLABS_WS_BASE}/${Env.elevenlabs.voiceId}/stream-input?${params.toString()}`;

    this.log.info('Connecting to ElevenLabs', {
      model:     Env.elevenlabs.modelId,
      voiceId:   Env.elevenlabs.voiceId,
      latencyOpt: Env.elevenlabs.optimizeLatency,
    });

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.state = 'open';
      this.log.debug('ElevenLabs connected');

      // Send initialisation message with voice settings
      const init: ElevenLabsInitMessage = {
        text: ' ',
        voice_settings: {
          stability:       Env.elevenlabs.stability,
          similarity_boost: Env.elevenlabs.similarityBoost,
          speed:           Env.elevenlabs.speed,
        },
        generation_config: {
          // Start streaming audio after this many characters have accumulated.
          // Lower = lower latency, higher = better prosody.
          chunk_length_schedule: [50, 120, 200],
        },
        xi_api_key: Env.elevenlabs.apiKey,
      };

      this.send(init);

      // Flush any text that arrived while we were connecting.
      // Mark the first chunk with try_trigger_generation so ElevenLabs begins
      // synthesising immediately rather than waiting for chunk_length_schedule.
      for (let i = 0; i < this.textQueue.length; i++) {
        const payload = (!this.firstTextSent)
          ? { text: this.textQueue[i], try_trigger_generation: true }
          : { text: this.textQueue[i] };
        this.firstTextSent = true;
        this.send(payload);
      }
      this.textQueue.length = 0;

      // If flush() was called during connecting, send it now
      if (this.pendingFlush) {
        this.pendingFlush = false;
        this.state = 'flushed';
        this.send({ text: '' });
        this.log.debug('ElevenLabs deferred flush sent');
      }

      this.openResolve?.();
      this.openResolve = null;
      this.openReject  = null;
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      if (this.state === 'aborted') return;
      try {
        const data = JSON.parse(raw.toString()) as ElevenLabsAudioResponse | { message?: string };
        this.handleMessage(data);
      } catch (err) {
        this.log.warn('Unparseable ElevenLabs message', { raw: raw.toString().slice(0, 200) });
      }
    });

    ws.on('error', (err: Error) => {
      this.state = 'error';
      this.log.error('ElevenLabs WS error', err);
      this.openReject?.(err);
      this.openResolve = null;
      this.openReject  = null;
      this.onErr?.(err);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      if (this.state !== 'aborted') {
        this.log.info('ElevenLabs WS closed', { code, reason: reason.toString() });
        if (this.state !== 'done') {
          // Unexpected close before we got isFinal — treat as complete
          this.state = 'done';
          this.onComplete?.();
        }
      }
    });

    return this.openPromise;
  }

  // ─── Audio Input ──────────────────────────────────────────────────────────

  /** Feed a text chunk to ElevenLabs. Safe to call before open() resolves. */
  streamText(text: string): void {
    if (this.state === 'aborted' || this.state === 'done' || this.state === 'flushed') return;

    if (this.state === 'connecting') {
      this.textQueue.push(text);
      return;
    }

    // First chunk: tell ElevenLabs to start generating audio immediately
    // rather than waiting for chunk_length_schedule threshold.
    const payload = !this.firstTextSent
      ? { text, try_trigger_generation: true }
      : { text };
    this.firstTextSent = true;
    this.send(payload);
  }

  /** Signal end of text input. ElevenLabs will flush remaining audio. */
  flush(): void {
    if (this.state === 'connecting') {
      // WS not open yet — defer flush until open handler fires
      this.pendingFlush = true;
      this.log.debug('ElevenLabs flush deferred (still connecting)');
      return;
    }
    if (this.state !== 'open') return;
    this.state = 'flushed';
    this.send({ text: '' });
    this.log.debug('ElevenLabs flush sent');
  }

  /** Cancel streaming immediately — discards all pending audio. */
  abort(): void {
    if (this.state === 'aborted') return;
    this.state = 'aborted';
    this.textQueue.length = 0;
    this.pendingFlush = false;
    this.firstTextSent = false;
    this.log.info('ElevenLabs TTS aborted');

    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close(1000, 'Barge-in');
        }
      } catch { /* ignore */ }
      this.ws = null;
    }
  }

  // ─── Message Handling ─────────────────────────────────────────────────────

  private handleMessage(data: ElevenLabsAudioResponse | { message?: string }): void {
    if ('message' in data && data.message) {
      this.log.warn('ElevenLabs API message', { message: data.message });
      return;
    }

    const audioData = data as ElevenLabsAudioResponse;

    if (audioData.audio) {
      this.onAudioChunk?.(audioData.audio);
    }

    if (audioData.isFinal) {
      this.state = 'done';
      this.log.debug('ElevenLabs generation complete');
      this.onComplete?.();

      if (this.ws) {
        try { this.ws.close(1000, 'Done'); } catch { /* ignore */ }
        this.ws = null;
      }
    }
  }

  // ─── Utility ──────────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private send(payload: any): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      this.log.error('ElevenLabs send failed', err as Error);
    }
  }

  get currentState(): TTSState { return this.state; }
  get isActive(): boolean { return this.state === 'open' || this.state === 'connecting' || this.state === 'flushed'; }
}
