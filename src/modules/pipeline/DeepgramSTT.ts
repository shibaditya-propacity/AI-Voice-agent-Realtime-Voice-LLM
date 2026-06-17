/**
 * DeepgramSTT: per-call streaming speech-to-text via Deepgram WebSocket API.
 *
 * - Sends raw PCMU (μ-law, 8 kHz) bytes directly — no codec conversion needed.
 * - Emits `onSpeechStarted` immediately when Deepgram VAD fires (for barge-in).
 * - Emits `onFinalTranscript` only on speech_final=true events (complete utterances).
 * - Reconnects on unexpected close with exponential backoff.
 */

import WebSocket from 'ws';
import { Env } from '../../config';
import { Logger } from '../../shared/Logger';
import type {
  DeepgramMessage,
  DeepgramResult,
  OnFinalTranscript,
  OnSpeechStarted,
  OnSTTError,
} from './DeepgramTypes';

const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_MS = 500;

export class DeepgramSTT {
  private ws: WebSocket | null = null;
  private readonly callSid: string;
  private readonly log: Logger;

  private onFinalTranscript?: OnFinalTranscript;
  private onInterimTranscript?: OnFinalTranscript;
  private onStableInterimCb?: OnFinalTranscript;
  private onSpeechStarted?: OnSpeechStarted;
  private onNoSpeechCb?: () => void;
  private onError?: OnSTTError;

  private readonly pendingAudio: Buffer[] = [];
  private closed = false;

  private muted = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private isFinalBuffer: string[] = [];
  private isFinalConfidence = 0;

  private lastInterimText = '';
  private lastInterimConfidence = 0;
  private lastInterimAt = 0;
  private readonly INTERIM_FALLBACK_MAX_AGE_MS = 3000;

  private stableInterimText = '';
  private stableInterimSince = 0;
  private stableInterimFired = false;
  private stableInterimTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly STABLE_INTERIM_MS_BASE = Env.deepgram.stableInterimBaseMs;
  private readonly STABLE_INTERIM_MS_SHORT = Env.deepgram.stableInterimShortMs;
  private readonly STABLE_SHORT_CHAR_THRESHOLD = Env.deepgram.stableShortCharThreshold;

  private isFinalFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly IS_FINAL_FLUSH_MS = 150;

  constructor(callSid: string) {
    this.callSid = callSid;
    this.log = Logger.forCall(callSid, 'DeepgramSTT');
  }

  onTranscript(cb: OnFinalTranscript): this { this.onFinalTranscript = cb; return this; }
  onInterim(cb: OnFinalTranscript): this    { this.onInterimTranscript = cb; return this; }
  onStableInterim(cb: OnFinalTranscript): this { this.onStableInterimCb = cb; return this; }
  onSpeech(cb: OnSpeechStarted): this       { this.onSpeechStarted = cb;  return this; }
  onNoSpeech(cb: () => void): this          { this.onNoSpeechCb = cb;     return this; }
  onErr(cb: OnSTTError): this               { this.onError = cb;          return this; }

  mute(): void   { this.muted = true; }
  unmute(): void { this.muted = false; }

  connect(): void {
    if (this.closed) return;

    const effectiveLanguage = Env.deepgram.multilingual ? 'hi' : Env.deepgram.language;

    const params = new URLSearchParams({
      model:            Env.deepgram.model,
      language:         effectiveLanguage,
      encoding:         'mulaw',
      sample_rate:      '8000',
      channels:         '1',
      interim_results:  'true',
      vad_events:       'true',
      endpointing:      String(Env.deepgram.endpointingMs),
      utterance_end_ms: String(Env.deepgram.utteranceEndMs),
    });

    const url = `${DEEPGRAM_WS_URL}?${params.toString()}`;

    this.log.info('Connecting to Deepgram', {
      model:        Env.deepgram.model,
      language:     effectiveLanguage,
      multilingual: Env.deepgram.multilingual,
      endpointing:  Env.deepgram.endpointingMs,
      utteranceEnd: Env.deepgram.utteranceEndMs,
    });

    const ws = new WebSocket(url, {
      headers: { Authorization: `Token ${Env.deepgram.apiKey}` },
    });

    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.log.info('Deepgram connected');

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
      if (err.message?.includes('400')) {
        this.log.error('Deepgram rejected params (HTTP 400) — stopping reconnect attempts');
        this.closed = true;
      }
      this.onError?.(err);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.log.warn('Deepgram WS closed', { code, reason: reason.toString() });
      if (!this.closed) this.scheduleReconnect();
    });
  }

  sendAudio(pcmuBuffer: Buffer): void {
    if (this.closed || this.muted) return;

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcmuBuffer);
    } else {
      if (this.pendingAudio.length < 500) {
        this.pendingAudio.push(pcmuBuffer);
      }
    }
  }

  finalize(): void {
    this.flushIsFinalBuffer('finalize');
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'Finalize' }));
      } catch { /* ignore */ }
    }
  }

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
        if (this.isFinalFlushTimer) {
          clearTimeout(this.isFinalFlushTimer);
          this.isFinalFlushTimer = null;
        }
        this.log.info('SpeechEnd (UtteranceEnd)', { lastWordEnd: msg.last_word_end, bufferedSegments: this.isFinalBuffer.length });
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

    if (!msg.is_final && !msg.speech_final) {
      if (transcript.trim()) {
        this.log.debug('Deepgram: interim transcript', { transcript, confidence });
        const trimmed = transcript.trim();
        this.lastInterimText = trimmed;
        this.lastInterimConfidence = confidence;
        this.lastInterimAt = Date.now();
        this.onInterimTranscript?.(trimmed, confidence);

        if (trimmed === this.stableInterimText) {
          // Same text — timer is already running
        } else {
          this.stableInterimText = trimmed;
          this.stableInterimSince = Date.now();
          this.stableInterimFired = false;
          if (this.stableInterimTimer) {
            clearTimeout(this.stableInterimTimer);
          }
          const stableMs = trimmed.length <= this.STABLE_SHORT_CHAR_THRESHOLD
            ? this.STABLE_INTERIM_MS_SHORT
            : this.STABLE_INTERIM_MS_BASE;

          this.stableInterimTimer = setTimeout(() => {
            this.stableInterimTimer = null;
            if (!this.stableInterimFired && this.stableInterimText === trimmed) {
              this.stableInterimFired = true;
              this.log.info('Deepgram: stable interim detected', {
                text: trimmed,
                confidence,
                stableForMs: Date.now() - this.stableInterimSince,
                windowMs: stableMs,
              });
              this.onStableInterimCb?.(trimmed, confidence);
            }
          }, stableMs);
        }
      }
      return;
    }

    if (!transcript.trim()) {
      const interimFresh = Date.now() - this.lastInterimAt < this.INTERIM_FALLBACK_MAX_AGE_MS;
      if (msg.speech_final && this.lastInterimText && interimFresh) {
        const fallbackText = [...this.isFinalBuffer, this.lastInterimText].join(' ').trim();
        const fallbackConf = this.lastInterimConfidence;
        this.isFinalBuffer = [];
        this.isFinalConfidence = 0;
        this.lastInterimText = '';
        this.lastInterimConfidence = 0;
        this.log.warn('Deepgram: empty speech_final — using interim fallback', {
          fallbackText,
          fallbackConfidence: fallbackConf,
        });
        if (fallbackText) {
          this.onFinalTranscript?.(fallbackText, fallbackConf);
        }
        return;
      }

      this.log.warn('Deepgram: empty transcript on finalization', {
        is_final: msg.is_final,
        speech_final: msg.speech_final,
        bufferedSegments: this.isFinalBuffer.length,
      });
      if (msg.speech_final && this.isFinalBuffer.length === 0) {
        this.onNoSpeechCb?.();
      }
      return;
    }

    this.lastInterimText = '';
    this.lastInterimConfidence = 0;
    this.resetStableInterim();

    if (confidence < Env.deepgram.minConfidence) {
      this.log.warn('Deepgram: low-confidence transcript discarded', {
        transcript: transcript.trim(),
        confidence,
        threshold: Env.deepgram.minConfidence,
        is_final: msg.is_final,
        speech_final: msg.speech_final,
      });
      if (msg.speech_final) {
        this.isFinalBuffer = [];
        this.isFinalConfidence = 0;
        this.onNoSpeechCb?.();
      }
      return;
    }

    if (msg.speech_final) {
      if (this.isFinalFlushTimer) {
        clearTimeout(this.isFinalFlushTimer);
        this.isFinalFlushTimer = null;
      }
      const full = [...this.isFinalBuffer, transcript.trim()].join(' ').trim();
      this.isFinalBuffer = [];
      this.isFinalConfidence = 0;
      this.log.info('SpeechEnd (speech_final)');
      this.log.info('Deepgram: speech_final transcript', {
        transcript: full,
        confidence,
        detectedLanguage: msg.detected_language,
        languageConfidence: msg.language_confidence,
      });
      this.onFinalTranscript?.(full, confidence);
    } else if (msg.is_final) {
      this.isFinalBuffer.push(transcript.trim());
      this.isFinalConfidence = confidence;
      this.log.info('Deepgram: is_final (buffered, awaiting UtteranceEnd)', {
        transcript,
        segments: this.isFinalBuffer.length,
        detectedLanguage: msg.detected_language,
        languageConfidence: msg.language_confidence,
      });

      if (this.isFinalFlushTimer) clearTimeout(this.isFinalFlushTimer);
      this.isFinalFlushTimer = setTimeout(() => {
        this.isFinalFlushTimer = null;
        if (this.isFinalBuffer.length > 0) {
          this.log.info('Deepgram: auto-flushing is_final buffer (UtteranceEnd timeout)');
          this.flushIsFinalBuffer('auto_flush');
        }
      }, this.IS_FINAL_FLUSH_MS);
    }
  }

  private resetStableInterim(): void {
    this.stableInterimText = '';
    this.stableInterimSince = 0;
    this.stableInterimFired = false;
    if (this.stableInterimTimer) {
      clearTimeout(this.stableInterimTimer);
      this.stableInterimTimer = null;
    }
  }

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

  close(): void {
    this.closed = true;

    if (this.isFinalFlushTimer) {
      clearTimeout(this.isFinalFlushTimer);
      this.isFinalFlushTimer = null;
    }
    this.resetStableInterim();
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
