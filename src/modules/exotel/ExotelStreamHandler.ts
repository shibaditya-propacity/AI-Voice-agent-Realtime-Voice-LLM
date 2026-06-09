/**
 * ExotelStreamHandler: manages one Exotel Media Stream WebSocket connection.
 *
 * Exotel's WebSocket streaming protocol is identical to Twilio Media Streams.
 * Inbound events:  connected → start → media* → stop
 * Outbound events: media (play audio), clear (interrupt), mark
 *
 * Uses TwilioStreamSession type for callback compatibility with downstream
 * MediaGatewayService and MediaSessionCoordinator without requiring changes there.
 */

import WebSocket from 'ws';
import { Logger } from '../../shared/Logger';
import {
  ExotelStreamMessage,
  ExotelStreamStart,
  ExotelMediaSend,
  ExotelMarkSend,
  ExotelClearSend,
} from './ExotelTypes';
import { TwilioStreamSession } from '../twilio/TwilioTypes';
import {
  OnAudioReceived,
  OnStreamStarted,
  OnStreamStopped,
} from '../twilio/TwilioStreamHandler';

interface QueuedMedia {
  payload: string;
  chunk: string;
}

export class ExotelStreamHandler {
  private readonly ws: WebSocket;
  private readonly log: Logger;
  private streamSession: TwilioStreamSession | null = null;

  private readonly onAudioReceived: OnAudioReceived;
  private readonly onStreamStarted: OnStreamStarted;
  private readonly onStreamStopped: OnStreamStopped;

  private readonly preStartQueue: QueuedMedia[] = [];
  private sessionInitialised: boolean = false;

  private readonly _onMessage: (raw: WebSocket.RawData) => void;
  private readonly _onClose: (code: number, reason: Buffer) => void;
  private readonly _onError: (err: Error) => void;
  private readonly _onPing: () => void;

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
    this.log = Logger.root('ExotelStreamHandler');

    this._onMessage = (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as ExotelStreamMessage;
        this.handleMessage(msg);
      } catch (err) {
        this.log.warn('Unparseable WebSocket message', { error: (err as Error).message });
      }
    };

    this._onClose = (code: number, reason: Buffer) => {
      const callSid = this.streamSession?.callSid ?? 'unknown';
      this.log.info('Exotel WebSocket closed', { callSid, code, reason: reason.toString() });
      this.detachListeners();
      if (this.streamSession) {
        this.onStreamStopped(callSid);
      }
    };

    this._onError = (err: Error) => {
      this.log.error('Exotel WebSocket error', err);
    };

    this._onPing = () => {
      try { this.ws.pong(); } catch { /* ignore */ }
    };

    this.attachListeners();
  }

  private attachListeners(): void {
    this.ws.on('message', this._onMessage);
    this.ws.on('close', this._onClose);
    this.ws.on('error', this._onError);
    this.ws.on('ping', this._onPing);
  }

  private detachListeners(): void {
    this.ws.removeListener('message', this._onMessage);
    this.ws.removeListener('close', this._onClose);
    this.ws.removeListener('error', this._onError);
    this.ws.removeListener('ping', this._onPing);
  }

  private handleMessage(msg: ExotelStreamMessage): void {
    switch (msg.event) {
      case 'connected':
        this.log.info('Exotel stream connected', {
          protocol: msg.protocol,
          version: msg.version,
        });
        break;

      case 'start':
        this.handleStart(msg);
        break;

      case 'media':
        if (msg.media.track === 'inbound') {
          if (!this.sessionInitialised) {
            this.log.debug('Queuing media before session init', { chunk: msg.media.chunk });
            this.preStartQueue.push({ payload: msg.media.payload, chunk: msg.media.chunk });
          } else if (this.streamSession) {
            const seqNum = parseInt(msg.media.chunk, 10);
            this.streamSession.sequenceNumber = seqNum;
            this.onAudioReceived(this.streamSession.callSid, msg.media.payload, seqNum);
          }
        }
        break;

      case 'stop':
        this.log.info('Exotel stream stop event', { callSid: msg.stop.callSid });
        this.detachListeners();
        this.onStreamStopped(msg.stop.callSid);
        break;

      case 'dtmf':
        this.log.debug('DTMF received', { digit: msg.dtmf.digit });
        break;

      case 'mark':
        this.log.debug('Mark received', { name: msg.mark.name });
        break;
    }
  }

  private handleStart(msg: ExotelStreamStart): void {
    const { streamSid, callSid, accountSid, mediaFormat, customParameters } = msg.start;

    // Build a TwilioStreamSession-compatible object so downstream MediaGatewayService
    // and MediaSessionCoordinator need no changes.
    this.streamSession = {
      streamSid,
      callSid,
      accountSid,
      encoding: mediaFormat.encoding,
      sampleRate: mediaFormat.sampleRate,
      channels: mediaFormat.channels,
      callerNumber: customParameters['callerNumber'] ?? '',
      startedAt: Date.now(),
      sequenceNumber: 0,
    };

    this.sessionInitialised = true;

    Logger.forSession('pending', callSid, 'ExotelStreamHandler').info('Stream started', {
      streamSid,
      encoding: mediaFormat.encoding,
      sampleRate: mediaFormat.sampleRate,
      callerNumber: this.streamSession.callerNumber,
      queuedFrames: this.preStartQueue.length,
    });

    this.onStreamStarted(callSid, this.streamSession);

    if (this.preStartQueue.length > 0) {
      this.log.debug(`Replaying ${this.preStartQueue.length} queued media frames`);
      for (const queued of this.preStartQueue) {
        const seqNum = parseInt(queued.chunk, 10);
        this.streamSession.sequenceNumber = seqNum;
        this.onAudioReceived(callSid, queued.payload, seqNum);
      }
      this.preStartQueue.length = 0;
    }
  }

  sendAudio(streamSid: string, audioBase64: string): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    const msg: ExotelMediaSend = {
      event: 'media',
      streamSid,
      media: { payload: audioBase64 },
    };
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      this.log.error('Failed to send audio to Exotel', err as Error);
      return false;
    }
  }

  clearAudio(streamSid: string): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const msg: ExotelClearSend = { event: 'clear', streamSid };
    try { this.ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
  }

  sendMark(streamSid: string, name: string): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const msg: ExotelMarkSend = { event: 'mark', streamSid, mark: { name } };
    try { this.ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
  }

  close(): void {
    this.detachListeners();
    if (
      this.ws.readyState === WebSocket.OPEN ||
      this.ws.readyState === WebSocket.CONNECTING
    ) {
      this.ws.close(1000, 'Call ended');
    }
  }

  get currentStreamSession(): TwilioStreamSession | null {
    return this.streamSession;
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }
}
