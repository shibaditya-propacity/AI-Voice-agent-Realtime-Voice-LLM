/**
 * ElevenLabsTTS: per-CALL persistent TTS via the ElevenLabs multi-context
 * WebSocket API (/multi-stream-input).
 *
 * One WebSocket is opened when the call starts and reused for every turn.
 * Each LLM response is an independent "context" on that socket:
 *
 *   startTurn(ctxId)  — initialise a context (voice settings, chunk schedule)
 *   streamText(text)  — feed LLM tokens into the active context
 *   flush()           — end of LLM response; forces remaining audio
 *   server → { audio, contextId }  then  { isFinal: true, contextId }
 *   abort()           — barge-in: close_context (instant, socket stays open)
 *   destroy()         — call ended: close_socket + WS close
 *
 * Audio output format: ulaw_8000 — forwarded as-is to Twilio.
 *
 * If the socket drops mid-call (inactivity, network), it reconnects
 * immediately in the background so the next turn never pays connect cost.
 */

import WebSocket from 'ws';
import { Env } from '../config/env';
import { Logger } from '../shared/logger';
import type { OnTTSError } from './types';

const ELEVENLABS_WS_BASE = 'wss://api.elevenlabs.io/v1/text-to-speech';

export type TTSState = 'idle' | 'connecting' | 'open' | 'closed';

export type OnContextAudio = (audioBase64: string, contextId: string) => void;
export type OnContextDone  = (contextId: string) => void;

export class ElevenLabsTTS {
  private ws: WebSocket | null = null;
  private state: TTSState = 'idle';
  private readonly log: Logger;

  private onAudioChunk?: OnContextAudio;
  private onComplete?: OnContextDone;
  private onErr?: OnTTSError;

  /** Context id of the turn currently being synthesized (null between turns). */
  private activeContextId: string | null = null;
  /** True once the init message for the active context has been sent. */
  private contextInitialized = false;

  /** Text chunks buffered while WS is still connecting/reconnecting. */
  private readonly textQueue: string[] = [];
  /** True if flush() was called while still connecting — send once open. */
  private pendingFlush = false;

  private openPromise: Promise<void> | null = null;
  /** Set when destroy() is called — stops auto-reconnect. */
  private destroyed = false;

  constructor(callSid: string) {
    this.log = Logger.forCall(callSid, 'ElevenLabsTTS');
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
      model_id:           Env.elevenlabs.modelId,
      output_format:      'ulaw_8000',
      // Max allowed — keeps the socket open across long gaps between turns.
      inactivity_timeout: '180',
    });

    const url = `${ELEVENLABS_WS_BASE}/${Env.elevenlabs.voiceId}/multi-stream-input?${params.toString()}`;

    this.log.info('Connecting to ElevenLabs (multi-context, persistent)', {
      model:   Env.elevenlabs.modelId,
      voiceId: Env.elevenlabs.voiceId,
    });

    this.openPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { 'xi-api-key': Env.elevenlabs.apiKey },
      });
      this.ws = ws;

      ws.on('open', () => {
        this.state = 'open';
        this.log.info('ElevenLabs connected (persistent WS)');

        // A turn may have started while we were connecting — initialise its
        // context and drain any queued text now.
        if (this.activeContextId && !this.contextInitialized) {
          this.sendContextInit(this.activeContextId);
        }
        for (const text of this.textQueue) {
          this.send({ text, context_id: this.activeContextId });
        }
        this.textQueue.length = 0;

        if (this.pendingFlush && this.activeContextId) {
          this.pendingFlush = false;
          this.send({ context_id: this.activeContextId, flush: true });
          this.log.debug('ElevenLabs deferred flush sent');
        }

        resolve();
      });

      ws.on('message', (raw: WebSocket.RawData) => {
        try {
          this.handleMessage(JSON.parse(raw.toString()));
        } catch {
          this.log.warn('Unparseable ElevenLabs message', { raw: raw.toString().slice(0, 200) });
        }
      });

      ws.on('error', (err: Error) => {
        this.log.error('ElevenLabs WS error', err);
        this.onErr?.(err);
        reject(err);
      });

      ws.on('close', (code: number, reason: Buffer) => {
        const wasOpen = this.state === 'open';
        this.state = 'closed';
        this.ws = null;
        this.openPromise = null;
        this.contextInitialized = false;

        if (this.destroyed) return;
        this.log.warn('ElevenLabs WS closed unexpectedly — reconnecting', {
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

  /** Begin a new turn. Each turn is an independent context on the shared WS. */
  startTurn(contextId: string): void {
    if (this.destroyed) return;

    // Defensive: kill any context left over from a previous turn.
    if (this.activeContextId && this.activeContextId !== contextId) {
      this.send({ context_id: this.activeContextId, close_context: true });
    }

    this.activeContextId = contextId;
    this.contextInitialized = false;
    this.textQueue.length = 0;
    this.pendingFlush = false;

    if (this.state === 'open') {
      this.sendContextInit(contextId);
    } else {
      // Init will be sent from the 'open' handler; make sure we're connecting.
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
    this.send({ text, context_id: this.activeContextId });
  }

  /** End of LLM text — force generation of all remaining audio. */
  flush(): void {
    if (this.destroyed || !this.activeContextId) return;

    if (this.state !== 'open') {
      this.pendingFlush = true;
      this.log.debug('ElevenLabs flush deferred (still connecting)');
      return;
    }
    this.send({ context_id: this.activeContextId, flush: true });
    this.log.debug('ElevenLabs flush sent');
  }

  /**
   * Barge-in: instantly close the active context. The server stops generating
   * and discards buffered audio. The socket stays open for the next turn.
   */
  abort(): void {
    this.textQueue.length = 0;
    this.pendingFlush = false;

    if (!this.activeContextId) return;
    const ctx = this.activeContextId;
    this.activeContextId = null;
    this.contextInitialized = false;

    this.send({ context_id: ctx, close_context: true });
    this.log.info('TTSCancelled', { contextId: ctx });
  }

  /** Call ended — close the socket for good. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.activeContextId = null;
    this.textQueue.length = 0;

    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.send({ close_socket: true });
          this.ws.close(1000, 'Call ended');
        } else if (this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close(1000, 'Call ended');
        }
      } catch { /* ignore */ }
      this.ws = null;
    }
    this.state = 'closed';
    this.log.info('ElevenLabs persistent WS destroyed (call end)');
  }

  // ─── Message Handling ─────────────────────────────────────────────────────

  private sendContextInit(contextId: string): void {
    this.send({
      text: ' ',
      voice_settings: {
        stability:        Env.elevenlabs.stability,
        similarity_boost: Env.elevenlabs.similarityBoost,
        speed:            Env.elevenlabs.speed,
      },
      generation_config: {
        // Start streaming audio after this many chars accumulate; flush()
        // at end of LLM response forces whatever remains.
        chunk_length_schedule: [50, 120, 200],
      },
      context_id: contextId,
    });
    this.contextInitialized = true;
  }

  private handleMessage(data: {
    audio?: string;
    isFinal?: boolean;
    contextId?: string;
    message?: string;
    error?: string;
  }): void {
    if (data.error || data.message) {
      this.log.warn('ElevenLabs API message', { message: data.message, error: data.error });
      return;
    }

    // Audio/done from a cancelled or stale context — drop silently.
    const ctx = data.contextId;
    if (!ctx || ctx !== this.activeContextId) return;

    if (data.audio) {
      this.onAudioChunk?.(data.audio, ctx);
    }

    if (data.isFinal) {
      this.activeContextId = null;
      this.contextInitialized = false;
      this.log.debug('ElevenLabs context complete', { contextId: ctx });
      this.onComplete?.(ctx);
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
  get isActive(): boolean { return !this.destroyed && (this.state === 'open' || this.state === 'connecting'); }
}
