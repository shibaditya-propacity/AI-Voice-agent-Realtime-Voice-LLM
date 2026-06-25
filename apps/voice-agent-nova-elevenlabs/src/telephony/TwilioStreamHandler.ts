/**
 * TwilioStreamHandler: manages one Twilio Media Stream WebSocket connection.
 *
 * Inbound events:  connected → start → media* → stop
 * Outbound events: media (play audio), clear (interrupt), mark (timing)
 *
 * Fixes:
 *  - All WS listeners stored and removed on close() to prevent listener leaks.
 *  - Media events arriving before 'start' are queued and replayed after init.
 */

import WebSocket from 'ws';
import { Logger } from '../shared/logger';
import {
  TwilioInboundMessage,
  TwilioStartMessage,
  TwilioStreamSession,
  TwilioMediaSend,
  TwilioClearSend,
  TwilioMarkSend,
} from './types';

export type OnAudioReceived  = (callSid: string, audioBase64: string, seqNum: number) => void;
export type OnStreamStarted  = (callSid: string, session: TwilioStreamSession) => void;
export type OnStreamStopped  = (callSid: string) => void;

interface QueuedMedia { payload: string; chunk: string }

export class TwilioStreamHandler {
  private readonly ws: WebSocket;
  private readonly log: Logger;
  private streamSession: TwilioStreamSession | null = null;
  private sessionInitialised = false;
  private readonly preStartQueue: QueuedMedia[] = [];

  private readonly onAudioReceived: OnAudioReceived;
  private readonly onStreamStarted: OnStreamStarted;
  private readonly onStreamStopped: OnStreamStopped;

  // Bound references so we can detach them exactly
  private readonly _onMessage: (raw: WebSocket.RawData) => void;
  private readonly _onClose:   (code: number, reason: Buffer) => void;
  private readonly _onError:   (err: Error) => void;
  private readonly _onPing:    () => void;

  constructor(
    ws: WebSocket,
    onAudioReceived: OnAudioReceived,
    onStreamStarted: OnStreamStarted,
    onStreamStopped: OnStreamStopped,
  ) {
    this.ws = ws;
    this.onAudioReceived = onAudioReceived;
    this.onStreamStarted = onStreamStarted;
    this.onStreamStopped = onStreamStopped;
    this.log = Logger.root('TwilioStreamHandler');

    this._onMessage = (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as TwilioInboundMessage;
        this.handleMessage(msg);
      } catch (err) {
        this.log.warn('Unparseable WebSocket message', { error: (err as Error).message });
      }
    };

    this._onClose = (code: number, reason: Buffer) => {
      const callSid = this.streamSession?.callSid ?? 'unknown';
      this.log.info('Twilio WS closed', { callSid, code, reason: reason.toString() });
      this.detachListeners();
      if (this.streamSession) this.onStreamStopped(callSid);
    };

    this._onError = (err: Error) => {
      this.log.error('Twilio WS error', err);
    };

    this._onPing = () => {
      try { this.ws.pong(); } catch { /* ignore */ }
    };

    this.attachListeners();
  }

  // ─── Listener Management ──────────────────────────────────────────────────

  private attachListeners(): void {
    this.ws.on('message', this._onMessage);
    this.ws.on('close',   this._onClose);
    this.ws.on('error',   this._onError);
    this.ws.on('ping',    this._onPing);
  }

  private detachListeners(): void {
    this.ws.removeListener('message', this._onMessage);
    this.ws.removeListener('close',   this._onClose);
    this.ws.removeListener('error',   this._onError);
    this.ws.removeListener('ping',    this._onPing);
  }

  // ─── Inbound Dispatch ─────────────────────────────────────────────────────

  private handleMessage(msg: TwilioInboundMessage): void {
    switch (msg.event) {
      case 'connected':
        this.log.info('Stream connected', { protocol: msg.protocol, version: msg.version });
        break;

      case 'start':
        this.handleStart(msg);
        break;

      case 'media':
        if (msg.media.track === 'inbound') {
          if (!this.sessionInitialised) {
            this.preStartQueue.push({ payload: msg.media.payload, chunk: msg.media.chunk });
          } else if (this.streamSession) {
            const seqNum = parseInt(msg.media.chunk, 10);
            this.streamSession.sequenceNumber = seqNum;
            this.onAudioReceived(this.streamSession.callSid, msg.media.payload, seqNum);
          }
        }
        break;

      case 'stop':
        this.log.info('Stream stop', { callSid: msg.stop.callSid });
        this.detachListeners();
        this.onStreamStopped(msg.stop.callSid);
        break;

      case 'dtmf':
        this.log.debug('DTMF', { digit: msg.dtmf.digit });
        break;

      case 'mark':
        this.log.debug('Mark', { name: msg.mark.name });
        break;
    }
  }

  private handleStart(msg: TwilioStartMessage): void {
    const { streamSid, callSid, accountSid, mediaFormat, customParameters } = msg.start;

    this.streamSession = {
      streamSid,
      callSid,
      accountSid,
      encoding: mediaFormat.encoding,
      sampleRate: mediaFormat.sampleRate,
      channels: mediaFormat.channels,
      callerNumber: customParameters['callerNumber'] ?? '',
      callDirection: customParameters['callDirection'] === 'outbound' ? 'outbound' : 'inbound',
      startedAt: Date.now(),
      sequenceNumber: 0,
    };

    this.sessionInitialised = true;

    Logger.forCall(callSid, 'TwilioStreamHandler').info('Stream started', {
      streamSid,
      encoding: mediaFormat.encoding,
      sampleRate: mediaFormat.sampleRate,
      callerNumber: this.streamSession.callerNumber,
      queuedFrames: this.preStartQueue.length,
    });

    this.onStreamStarted(callSid, this.streamSession);

    // Replay frames that arrived before 'start'
    if (this.preStartQueue.length > 0) {
      for (const queued of this.preStartQueue) {
        const seqNum = parseInt(queued.chunk, 10);
        this.streamSession.sequenceNumber = seqNum;
        this.onAudioReceived(callSid, queued.payload, seqNum);
      }
      this.preStartQueue.length = 0;
    }
  }

  // ─── Outbound ─────────────────────────────────────────────────────────────

  sendAudio(streamSid: string, audioBase64: string): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    const msg: TwilioMediaSend = { event: 'media', streamSid, media: { payload: audioBase64 } };
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      this.log.error('sendAudio failed', err as Error);
      return false;
    }
  }

  clearAudio(streamSid: string): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const msg: TwilioClearSend = { event: 'clear', streamSid };
    try { this.ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
  }

  sendMark(streamSid: string, name: string): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const msg: TwilioMarkSend = { event: 'mark', streamSid, mark: { name } };
    try { this.ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
  }

  close(): void {
    this.detachListeners();
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(1000, 'Call ended');
    }
  }

  get session(): TwilioStreamSession | null { return this.streamSession; }
  get isOpen(): boolean { return this.ws.readyState === WebSocket.OPEN; }
}
