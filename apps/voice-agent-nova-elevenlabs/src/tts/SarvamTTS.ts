/**
 * SarvamTTS: per-CALL persistent TTS via the Sarvam AI Bulbul v3
 * WebSocket API.
 *
 * Drop-in replacement for ElevenLabsTTS with identical interface:
 *
 *   startTurn(ctxId)  — send config + prepare for new context
 *   streamText(text)  — feed LLM tokens into the active context
 *   flush()           — end of LLM response; forces remaining audio
 *   server → { type: "audio", data: { audio } }  then  { type: "event", data: { event_type: "final" } }
 *   abort()           — barge-in: close context (reconnect socket for next turn)
 *   destroy()         — call ended: close socket
 *
 * Audio output format: mulaw @ 8000Hz — forwarded as-is to Twilio.
 *
 * Sarvam WebSocket idle timeout is ~60s; we send ping every 20s to keep alive.
 */

import WebSocket from 'ws';
import { Env } from '../config/env';
import { Logger } from '../shared/logger';
import type { OnTTSError } from './types';

const SARVAM_WS_BASE = 'wss://api.sarvam.ai/text-to-speech/ws';

export type TTSState = 'idle' | 'connecting' | 'open' | 'closed';

export type OnContextAudio = (audioBase64: string, contextId: string) => void;
export type OnContextDone  = (contextId: string) => void;

export class SarvamTTS {
  private ws: WebSocket | null = null;
  private state: TTSState = 'idle';
  private readonly log: Logger;

  private onAudioChunk?: OnContextAudio;
  private onComplete?: OnContextDone;
  private onErr?: OnTTSError;

  /** Context id of the turn currently being synthesized (null between turns). */
  private activeContextId: string | null = null;
  /** True once the config message has been sent for the current connection. */
  private configSent = false;

  /** Text chunks buffered while WS is still connecting/reconnecting. */
  private readonly textQueue: string[] = [];
  /** True if flush() was called while still connecting — send once open. */
  private pendingFlush = false;

  private openPromise: Promise<void> | null = null;
  /** Set when destroy() is called — stops auto-reconnect. */
  private destroyed = false;

  /** Keepalive interval handle. */
  private keepaliveInterval: ReturnType<typeof setInterval> | null = null;

  /** Latency tracking. */
  private turnStartTime = 0;
  private firstAudioReceived = false;

  constructor(callSid: string) {
    this.log = Logger.forCall(callSid, 'SarvamTTS');
  }

  // ─── Callback Registration ────────────────────────────────────────────────

  onAudio(cb: OnContextAudio): this { this.onAudioChunk = cb; return this; }
  onDone(cb: OnContextDone): this   { this.onComplete = cb;   return this; }
  onError(cb: OnTTSError): this     { this.onErr = cb;        return this; }

  // ─── Connection (once per call, auto-reconnect) ──────────────────────────

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

        // Send config immediately on connect
        this.sendConfig();

        // Start keepalive
        this.startKeepalive();

        // Drain any queued text
        for (const text of this.textQueue) {
          this.sendText(text);
        }
        this.textQueue.length = 0;

        if (this.pendingFlush) {
          this.pendingFlush = false;
          // Drain preSendBuffer before flush — text queued via streamText()
          // went through sendText() which only accumulates into preSendBuffer.
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
        // A close mid-turn means remaining audio is lost — finish the turn.
        if (this.activeContextId) {
          const ctx = this.activeContextId;
          this.activeContextId = null;
          this.onComplete?.(ctx);
        }
        // Reconnect in the background so the next turn starts on a warm socket.
        if (wasOpen) void this.open().catch(() => { /* logged in error handler */ });
      });
    });

    return this.openPromise;
  }

  // ─── Turn Lifecycle ───────────────────────────────────────────────────────

  /** Begin a new turn. Each turn streams text then flushes on the shared WS. */
  startTurn(contextId: string): void {
    if (this.destroyed) return;

    this.activeContextId = contextId;
    this.textQueue.length = 0;
    this.pendingFlush = false;
    this.firstAudioReceived = false;
    this.turnStartTime = Date.now();
    this.preSendBuffer = '';

    if (this.state !== 'open') {
      // Ensure we're connecting; text will drain from queue once open.
      void this.open().catch(() => { /* logged in error handler */ });
    }
  }

  /** Feed a text chunk to the active context. Safe before WS is open. */
  streamText(text: string): void {
    if (this.destroyed || !this.activeContextId) return;

    if (this.state !== 'open') {
      this.textQueue.push(text);
      return;
    }
    this.sendText(text);
  }

  /** End of LLM text — force generation of all remaining audio. */
  flush(): void {
    if (this.destroyed || !this.activeContextId) return;

    if (this.state !== 'open') {
      this.pendingFlush = true;
      this.log.debug('Sarvam flush deferred (still connecting)');
      return;
    }
    // Drain any buffered text before flushing
    if (this.preSendBuffer) {
      this.send({ type: 'text', data: { text: this.preSendBuffer } });
      this.preSendBuffer = '';
    }
    this.sendFlush();
    this.log.debug('Sarvam flush sent');
  }

  /**
   * Barge-in: abort current generation.
   * Soft abort: null the context so stale audio is dropped by handleMessage,
   * then send flush to clear Sarvam's text buffer. The WS stays open — no
   * reconnect latency (~65-100ms saved per barge-in).
   * Sarvam will finish generating any buffered audio (discarded), then the
   * next startTurn/streamText works immediately on the warm socket.
   */
  abort(): void {
    this.textQueue.length = 0;
    this.pendingFlush = false;

    if (!this.activeContextId) return;
    const ctx = this.activeContextId;
    this.activeContextId = null;

    // Soft abort: send flush to drain Sarvam's buffer; stale audio is
    // discarded in handleMessage (activeContextId is null).
    // WS stays open — next turn starts instantly.
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendFlush();
    }

    this.log.info('TTSCancelled (barge-in, soft abort)', { contextId: ctx });
  }

  /** Call ended — close the socket for good. */
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

  // ─── Message Handling ─────────────────────────────────────────────────────

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
      // Lowest possible — start generating audio as early as possible.
      // Sarvam minimum is 30 chars. Short responses (12 words) are ~60 chars
      // total, so first audio fires after ~50% of text arrives.
      min_buffer_size: 30,
      // Keep short for faster incremental chunks on longer responses
      max_chunk_length: 100,
      ...(Env.sarvam.temperature !== undefined && { temperature: Env.sarvam.temperature }),
    };
    this.log.info('Sarvam config sent', { target_language_code: config.target_language_code, speaker: config.speaker });
    this.send({ type: 'config', data: config });
    this.configSent = true;
  }

  /**
   * Text accumulator — Sarvam needs enough text to start synthesis
   * (min_buffer_size=30 chars). We accumulate tokens until we hit the
   * threshold, then send immediately so Sarvam can start generating audio
   * while LLM continues producing tokens. Remaining text is sent at flush().
   */
  private preSendBuffer = '';
  /** Minimum chars before sending a text chunk to Sarvam mid-stream.
   *  Must match or exceed the min_buffer_size in config (30). */
  private readonly PRE_SEND_THRESHOLD = 30;

  private sendText(text: string): void {
    this.preSendBuffer += text;

    // Once we accumulate enough text, send immediately so Sarvam can
    // start synthesis in parallel with ongoing LLM token streaming.
    // This reduces first-audio latency by ~100-200ms on longer responses.
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

    // Drop audio/events if no active context (stale from pre-barge-in)
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

  // ─── Keepalive ────────────────────────────────────────────────────────────

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping' });
      }
    }, 20_000); // Every 20s (Sarvam idles at ~60s)
  }

  private stopKeepalive(): void {
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
  }

  // ─── Utility ──────────────────────────────────────────────────────────────

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
