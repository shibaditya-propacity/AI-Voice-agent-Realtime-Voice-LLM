/**
 * DeepgramSTT: per-call streaming speech-to-text via Deepgram WebSocket API.
 *
 * - Sends raw PCMU (μ-law, 8 kHz) bytes directly — no codec conversion needed.
 * - Emits `onSpeechStarted` immediately when Deepgram VAD fires (for barge-in).
 * - Emits `onFinalTranscript` only on speech_final=true events (complete utterances).
 * - Reconnects on unexpected close with exponential backoff.
 */

import WebSocket from 'ws';
import { Env } from '../config/env';
import { Logger } from '../shared/logger';
import type {
  DeepgramMessage,
  DeepgramResult,
  OnFinalTranscript,
  OnSpeechStarted,
  OnSTTError,
} from './types';

const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_MS = 500;

export class DeepgramSTT {
  private ws: WebSocket | null = null;
  private readonly callSid: string;
  private readonly log: Logger;

  private onFinalTranscript?: OnFinalTranscript;
  private onSpeechStarted?: OnSpeechStarted;
  private onError?: OnSTTError;

  /** Audio chunks buffered while WS is not yet open */
  private readonly pendingAudio: Buffer[] = [];
  private closed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Accumulates is_final transcript segments within an utterance.
   * Flushed to onFinalTranscript when speech_final OR UtteranceEnd fires.
   * Deepgram does not always send speech_final — especially on outbound calls
   * where endpointing may not fire cleanly. UtteranceEnd is the reliable signal.
   */
  private isFinalBuffer: string[] = [];
  private isFinalConfidence = 0;

  constructor(callSid: string) {
    this.callSid = callSid;
    this.log = Logger.forCall(callSid, 'DeepgramSTT');
  }

  // ─── Callback Registration ────────────────────────────────────────────────

  onTranscript(cb: OnFinalTranscript): this { this.onFinalTranscript = cb; return this; }
  onSpeech(cb: OnSpeechStarted): this       { this.onSpeechStarted = cb;  return this; }
  onErr(cb: OnSTTError): this               { this.onError = cb;          return this; }

  // ─── Connection ───────────────────────────────────────────────────────────

  connect(): void {
    if (this.closed) return;

    // When multilingual=true, use language=hi — Nova-3's Hindi model.
    // Reasons for 'hi' over 'multi':
    //   - 'multi' causes excessive SpeechStarted events for background noise,
    //     resetting the UtteranceEnd timer repeatedly → 7+ second transcript delays
    //   - 'hi' is trained on Indian speech (Hindi + English loanwords), handles
    //     Hinglish naturally, fires speech_final reliably on 200ms silence
    //   - 'detect_language' returns HTTP 400 on the streaming WebSocket endpoint
    const effectiveLanguage = Env.deepgram.multilingual ? 'hi' : Env.deepgram.language;

    const params = new URLSearchParams({
      model:            Env.deepgram.model,
      language:         effectiveLanguage,
      encoding:         'mulaw',
      sample_rate:      '8000',
      channels:         '1',
      interim_results:  'true',
      smart_format:     'true',
      vad_events:       'true',
      endpointing:      String(Env.deepgram.endpointingMs),
      utterance_end_ms: String(Env.deepgram.utteranceEndMs),
    });

    const url = `${DEEPGRAM_WS_URL}?${params.toString()}`;

    this.log.info('Connecting to Deepgram', {
      model:        Env.deepgram.model,
      language:     effectiveLanguage,
      multilingual: Env.deepgram.multilingual,
    });

    const ws = new WebSocket(url, {
      headers: { Authorization: `Token ${Env.deepgram.apiKey}` },
    });

    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.log.info('Deepgram connected');

      // Flush buffered audio
      if (this.pendingAudio.length > 0) {
        this.log.debug(`Flushing ${this.pendingAudio.length} buffered audio chunks`);
        for (const chunk of this.pendingAudio) {
          if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
        }
        this.pendingAudio.length = 0;
      }
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as DeepgramMessage;
        this.handleMessage(msg);
      } catch (err) {
        this.log.warn('Unparseable Deepgram message', { error: (err as Error).message });
      }
    });

    ws.on('error', (err: Error) => {
      this.log.error('Deepgram WS error', err);
      this.onError?.(err);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.log.warn('Deepgram WS closed', { code, reason: reason.toString() });
      if (!this.closed) this.scheduleReconnect();
    });
  }

  // ─── Audio Ingestion ──────────────────────────────────────────────────────

  /** Send raw PCMU (base64-decoded) bytes to Deepgram. */
  sendAudio(pcmuBuffer: Buffer): void {
    if (this.closed) return;

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcmuBuffer);
    } else {
      // Buffer until WS is ready (reconnect in progress or slow open)
      if (this.pendingAudio.length < 500) { // cap to avoid unbounded growth
        this.pendingAudio.push(pcmuBuffer);
      }
    }
  }

  /** Signal end of utterance manually (used when call ends). */
  finalize(): void {
    // Flush any buffered is_final segments before closing
    this.flushIsFinalBuffer('finalize');
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'Finalize' }));
      } catch { /* ignore */ }
    }
  }

  // ─── Event Handling ───────────────────────────────────────────────────────

  private handleMessage(msg: DeepgramMessage): void {
    switch (msg.type) {
      case 'SpeechStarted':
        this.log.info('Deepgram: SpeechStarted (VAD)');
        this.onSpeechStarted?.();
        break;

      case 'Results':
        this.handleResults(msg);
        break;

      case 'UtteranceEnd':
        this.log.info('Deepgram: UtteranceEnd', { lastWordEnd: msg.last_word_end, bufferedSegments: this.isFinalBuffer.length });
        this.flushIsFinalBuffer('UtteranceEnd');
        break;

      case 'Metadata':
        this.log.info('Deepgram: Metadata', { requestId: msg.request_id, model: msg.model_info?.name });
        break;

      default:
        this.log.debug('Deepgram: unknown message type', { type: (msg as Record<string, unknown>).type });
        break;
    }
  }

  private handleResults(msg: DeepgramResult): void {
    const alt = msg.channel.alternatives[0];
    if (!alt) return;

    const { transcript, confidence } = alt;

    // Log all interim (partial) results for visibility — these show Deepgram
    // is actively recognizing audio. Absence of these in logs = recognition failure.
    if (!msg.is_final && !msg.speech_final) {
      if (transcript.trim()) {
        this.log.debug('Deepgram: interim transcript', { transcript, confidence });
      }
      return;
    }

    // Empty is_final/speech_final = Deepgram heard audio but couldn't decode it.
    // Common cause: language mismatch (e.g. Hindi audio with language=en-IN).
    if (!transcript.trim()) {
      this.log.warn('Deepgram: empty transcript on finalization', {
        is_final: msg.is_final,
        speech_final: msg.speech_final,
        bufferedSegments: this.isFinalBuffer.length,
      });
      return;
    }

    if (msg.speech_final) {
      // speech_final: Deepgram's endpointing fired — emit immediately,
      // prepending any buffered is_final segments from earlier in the utterance.
      const full = [...this.isFinalBuffer, transcript.trim()].join(' ').trim();
      this.isFinalBuffer = [];
      this.isFinalConfidence = 0;
      this.log.info('Deepgram: speech_final transcript', {
        transcript: full,
        confidence,
        detectedLanguage: msg.detected_language,
        languageConfidence: msg.language_confidence,
      });
      this.onFinalTranscript?.(full, confidence);
    } else if (msg.is_final) {
      // is_final without speech_final: accumulate — UtteranceEnd will flush.
      this.isFinalBuffer.push(transcript.trim());
      this.isFinalConfidence = confidence;
      this.log.info('Deepgram: is_final (buffered, awaiting UtteranceEnd)', {
        transcript,
        segments: this.isFinalBuffer.length,
        detectedLanguage: msg.detected_language,
        languageConfidence: msg.language_confidence,
      });
    }
  }

  /**
   * Emit accumulated is_final segments as a final transcript.
   * Called on UtteranceEnd (silence-based) or manually on call finalize.
   */
  private flushIsFinalBuffer(trigger: string): void {
    if (this.isFinalBuffer.length === 0) {
      this.log.debug('Deepgram: UtteranceEnd with empty buffer (no recognized speech)', { trigger });
      return;
    }
    const full = this.isFinalBuffer.join(' ').trim();
    const conf = this.isFinalConfidence;
    this.isFinalBuffer = [];
    this.isFinalConfidence = 0;
    if (!full) return;
    this.log.info('Deepgram: final transcript (from ' + trigger + ')', { transcript: full, confidence: conf });
    this.onFinalTranscript?.(full, conf);
  }

  // ─── Reconnect ────────────────────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        this.log.error('Deepgram max reconnect attempts reached', new Error('Max reconnects'));
        this.onError?.(new Error('Deepgram connection lost after max retries'));
      }
      return;
    }

    const delayMs = RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;
    this.log.info(`Reconnecting to Deepgram in ${delayMs}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.connect();
    }, delayMs);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  close(): void {
    this.closed = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'CloseStream' }));
          this.ws.close(1000, 'Call ended');
        }
      } catch { /* ignore */ }
      this.ws = null;
    }

    this.pendingAudio.length = 0;
    this.log.info('DeepgramSTT closed');
  }
}
