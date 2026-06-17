/**
 * SarvamTTS: per-CALL persistent TTS via the Sarvam AI Bulbul v3
 * WebSocket API.
 *
 * Audio output format: mulaw @ 8000Hz — forwarded as-is to Twilio.
 */

import WebSocket from 'ws';
import { Env } from '../../config';
import { Logger } from '../../shared/Logger';

export type TTSState = 'idle' | 'connecting' | 'open' | 'closed';
export type OnTTSError = (err: Error) => void;
export type OnContextAudio = (audioBase64: string, contextId: string) => void;
export type OnContextDone  = (contextId: string) => void;

const SARVAM_WS_BASE = 'wss://api.sarvam.ai/text-to-speech/ws';

export class SarvamTTS {
  private ws: WebSocket | null = null;
  private state: TTSState = 'idle';
  private readonly log: Logger;

  private onAudioChunk?: OnContextAudio;
  private onComplete?: OnContextDone;
  private onErr?: OnTTSError;

  private activeContextId: string | null = null;
  private configSent = false;

  private readonly textQueue: string[] = [];
  private pendingFlush = false;

  private openPromise: Promise<void> | null = null;
  private destroyed = false;

  private keepaliveInterval: ReturnType<typeof setInterval> | null = null;

  private turnStartTime = 0;
  private firstAudioReceived = false;

  constructor(callSid: string) {
    this.log = Logger.forCall(callSid, 'SarvamTTS');
  }

  onAudio(cb: OnContextAudio): this { this.onAudioChunk = cb; return this; }
  onDone(cb: OnContextDone): this   { this.onComplete = cb;   return this; }
  onError(cb: OnTTSError): this     { this.onErr = cb;        return this; }

  open(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    if (this.openPromise) return this.openPromise;

    this.state = 'connecting';

    const params = new URLSearchParams({
      model: Env.sarvam.modelId,
      send_completion_event: 'true',
    });

    const url = `${SARVAM_WS_BASE}?${params.toString()}`;

    this.log.info('Connecting to Sarvam AI (Bulbul v3, persistent WS)', {
      model:   Env.sarvam.modelId,
      speaker: Env.sarvam.speaker,
    });

    this.openPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { 'api-subscription-key': Env.sarvam.apiKey },
      });
      this.ws = ws;

      ws.on('open', () => {
        this.state = 'open';
        this.log.info('Sarvam AI connected (persistent WS)');

        this.sendConfig();
        this.startKeepalive();

        for (const text of this.textQueue) {
          this.sendText(text);
        }
        this.textQueue.length = 0;

        if (this.pendingFlush) {
          this.pendingFlush = false;
          if (this.preSendBuffer) {
            this.send({ type: 'text', data: { text: this.preSendBuffer } });
            this.preSendBuffer = '';
          }
          this.sendFlush();
          this.log.debug('Sarvam deferred flush sent (with buffered text)');
        }

        resolve();
      });

      ws.on('message', (raw: WebSocket.RawData) => {
        try {
          this.handleMessage(JSON.parse(raw.toString()));
        } catch {
          this.log.warn('Unparseable Sarvam message', { raw: raw.toString().slice(0, 200) });
        }
      });

      ws.on('error', (err: Error) => {
        this.log.error('Sarvam WS error', err);
        this.onErr?.(err);
        reject(err);
      });

      ws.on('close', (code: number, reason: Buffer) => {
        const wasOpen = this.state === 'open';
        this.state = 'closed';
        this.ws = null;
        this.openPromise = null;
        this.configSent = false;
        this.stopKeepalive();

        if (this.destroyed) return;
        this.log.warn('Sarvam WS closed unexpectedly — reconnecting', {
          code, reason: reason.toString(), midTurn: this.activeContextId !== null,
        });
        if (this.activeContextId) {
          const ctx = this.activeContextId;
          this.activeContextId = null;
          this.onComplete?.(ctx);
        }
        if (wasOpen) void this.open().catch(() => {});
      });
    });

    return this.openPromise;
  }

  startTurn(contextId: string): void {
    if (this.destroyed) return;

    this.activeContextId = contextId;
    this.textQueue.length = 0;
    this.pendingFlush = false;
    this.firstAudioReceived = false;
    this.turnStartTime = Date.now();
    this.preSendBuffer = '';

    if (this.state !== 'open') {
      void this.open().catch(() => {});
    }
  }

  streamText(text: string): void {
    if (this.destroyed || !this.activeContextId) return;

    if (this.state !== 'open') {
      this.textQueue.push(text);
      return;
    }
    this.sendText(text);
  }

  flush(): void {
    if (this.destroyed || !this.activeContextId) return;

    if (this.state !== 'open') {
      this.pendingFlush = true;
      this.log.debug('Sarvam flush deferred (still connecting)');
      return;
    }
    if (this.preSendBuffer) {
      this.send({ type: 'text', data: { text: this.preSendBuffer } });
      this.preSendBuffer = '';
    }
    this.sendFlush();
    this.log.debug('Sarvam flush sent');
  }

  abort(): void {
    this.textQueue.length = 0;
    this.pendingFlush = false;

    if (!this.activeContextId) return;
    const ctx = this.activeContextId;
    this.activeContextId = null;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendFlush();
    }

    this.log.info('TTSCancelled (barge-in, soft abort)', { contextId: ctx });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.activeContextId = null;
    this.textQueue.length = 0;
    this.stopKeepalive();

    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close(1000, 'Call ended');
        }
      } catch { /* ignore */ }
      this.ws = null;
    }
    this.state = 'closed';
    this.log.info('Sarvam persistent WS destroyed (call end)');
  }

  private sendConfig(): void {
    if (this.configSent) return;
    const config = {
      target_language_code: Env.sarvam.targetLanguageCode,
      speaker: Env.sarvam.speaker,
      speech_sample_rate: '8000',
      output_audio_codec: 'mulaw',
      model: Env.sarvam.modelId,
      pace: Env.sarvam.pace,
      enable_preprocessing: true,
      min_buffer_size: 30,
      max_chunk_length: 100,
      ...(Env.sarvam.temperature !== undefined && { temperature: Env.sarvam.temperature }),
    };
    this.log.info('Sarvam config sent', { target_language_code: config.target_language_code, speaker: config.speaker });
    this.send({ type: 'config', data: config });
    this.configSent = true;
  }

  private preSendBuffer = '';
  private readonly PRE_SEND_THRESHOLD = 30;

  private sendText(text: string): void {
    this.preSendBuffer += text;

    if (this.preSendBuffer.length >= this.PRE_SEND_THRESHOLD) {
      this.send({ type: 'text', data: { text: this.preSendBuffer } });
      this.preSendBuffer = '';
    }
  }

  private sendFlush(): void {
    this.send({ type: 'flush' });
  }

  private handleMessage(data: {
    type?: string;
    data?: { audio?: string; event_type?: string; message?: string };
  }): void {
    if (!data.type) return;

    if (data.type === 'error') {
      const msg = data.data?.message || 'Unknown Sarvam error';
      this.log.warn('Sarvam API error', { message: msg });
      this.onErr?.(new Error(msg));
      return;
    }

    if (!this.activeContextId) return;

    if (data.type === 'audio' && data.data?.audio) {
      if (!this.firstAudioReceived) {
        this.firstAudioReceived = true;
        const firstAudioLatencyMs = Date.now() - this.turnStartTime;
        this.log.info('Sarvam first-audio latency', { ms: firstAudioLatencyMs, contextId: this.activeContextId });
      }
      this.onAudioChunk?.(data.data.audio, this.activeContextId);
    }

    if (data.type === 'event' && data.data?.event_type === 'final') {
      const totalLatencyMs = Date.now() - this.turnStartTime;
      this.log.info('Sarvam TTS complete', { totalMs: totalLatencyMs, contextId: this.activeContextId });
      const ctx = this.activeContextId;
      this.activeContextId = null;
      this.onComplete?.(ctx);
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping' });
      }
    }, 20_000);
  }

  private stopKeepalive(): void {
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private send(payload: any): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      this.log.error('Sarvam send failed', err as Error);
    }
  }

  get currentState(): TTSState { return this.state; }
  get isActive(): boolean { return !this.destroyed && (this.state === 'open' || this.state === 'connecting'); }
}
