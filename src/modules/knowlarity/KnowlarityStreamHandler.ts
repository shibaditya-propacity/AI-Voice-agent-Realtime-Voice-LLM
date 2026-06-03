/**
 * KnowlarityStreamHandler: manages a single Knowlarity media stream WebSocket.
 *
 * Knowlarity's realtime media stream protocol (similar to Twilio Media Streams):
 * - Knowlarity dials your WebSocket endpoint when a call connects
 * - Sends "start" event with stream metadata and codec info
 * - Sends "media" events with base64-encoded audio chunks (inbound)
 * - We send "media" events back to play audio to the caller (outbound)
 * - Sends "stop" event when the call ends
 */

import WebSocket from 'ws';
import { Logger } from '../../shared/Logger';
import {
  KnowlarityMediaSend,
  KnowlarityClearSend,
  KnowlarityMarkSend,
  KnowlarityStreamMessage,
  KnowlarityStreamSession,
  KnowlarityStreamStart,
} from './KnowlarityTypes';

export type OnAudioReceived = (callId: string, audioBase64: string, sequenceNumber: number) => void;
export type OnStreamStarted = (callId: string, session: KnowlarityStreamSession) => void;
export type OnStreamStopped = (callId: string) => void;

export class KnowlarityStreamHandler {
  private readonly ws: WebSocket;
  private readonly log: Logger;
  private streamSession: KnowlarityStreamSession | null = null;

  // Callbacks wired by KnowlarityService
  private onAudioReceived: OnAudioReceived;
  private onStreamStarted: OnStreamStarted;
  private onStreamStopped: OnStreamStopped;

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
    this.log = Logger.root('KnowlarityStreamHandler');

    this.attachWebSocketListeners();
  }

  // ─── WebSocket Listeners ──────────────────────────────────────────────────

  private attachWebSocketListeners(): void {
    this.ws.on('message', (data: WebSocket.RawData) => this.handleMessage(data));
    this.ws.on('close', (code: number, reason: Buffer) => this.handleClose(code, reason.toString()));
    this.ws.on('error', (err: Error) => {
      this.log.error('Knowlarity WebSocket error', err);
    });
    this.ws.on('ping', () => {
      try { this.ws.pong(); } catch { /* ignore */ }
    });
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let message: KnowlarityStreamMessage;
    try {
      message = JSON.parse(raw.toString()) as KnowlarityStreamMessage;
    } catch (err) {
      this.log.warn('Unparseable WebSocket message', { error: (err as Error).message });
      return;
    }

    switch (message.event) {
      case 'connected':
        this.log.info('Knowlarity stream connected', {
          protocol: message.protocol,
          version: message.version,
        });
        break;

      case 'start':
        this.handleStart(message.start, message.sequenceNumber);
        break;

      case 'media':
        if (message.media.track === 'inbound') {
          this.handleInboundAudio(
            message.media.payload,
            parseInt(message.media.chunk, 10),
          );
        }
        break;

      case 'stop':
        this.handleStop(message.stop.callSid);
        break;

      case 'dtmf':
        this.log.debug('DTMF received', { digit: message.dtmf.digit });
        break;

      case 'mark':
        this.log.debug('Mark received', { name: message.mark.name });
        break;

      default:
        this.log.debug('Unknown stream event', { event: (message as { event: string }).event });
    }
  }

  private handleStart(
    startData: KnowlarityStreamStart['start'],
    _sequenceNumber: string,
  ): void {
    const encoding = startData.mediaFormat.encoding;
    const codec =
      encoding === 'audio/x-mulaw'
        ? 'audio/x-mulaw'
        : encoding === 'audio/x-alaw'
        ? 'audio/x-alaw'
        : 'audio/basic';

    this.streamSession = {
      streamSid: startData.streamSid,
      callSid: startData.callSid,
      encoding: codec as KnowlarityStreamSession['encoding'],
      sampleRate: startData.mediaFormat.sampleRate,
      channels: startData.mediaFormat.channels,
      startedAt: Date.now(),
      sequenceNumber: 0,
    };

    const childLog = Logger.forSession('unknown', startData.callSid, 'KnowlarityStreamHandler');
    childLog.info('Stream started', {
      streamSid: startData.streamSid,
      encoding,
      sampleRate: startData.mediaFormat.sampleRate,
    });

    this.onStreamStarted(startData.callSid, this.streamSession);
  }

  private handleInboundAudio(audioBase64: string, sequenceNumber: number): void {
    if (!this.streamSession) return;

    this.streamSession.sequenceNumber = sequenceNumber;
    this.onAudioReceived(this.streamSession.callSid, audioBase64, sequenceNumber);
  }

  private handleClose(code: number, reason: string): void {
    const callId = this.streamSession?.callSid ?? 'unknown';
    this.log.info('Knowlarity WebSocket closed', { callId, code, reason });
    if (this.streamSession) {
      this.onStreamStopped(callId);
    }
  }

  private handleStop(callSid: string): void {
    this.log.info('Knowlarity stream stopped', { callId: callSid });
    this.onStreamStopped(callSid);
  }

  // ─── Outbound Methods ──────────────────────────────────────────────────────

  /**
   * Send audio to the caller's phone.
   * @param streamSid  Knowlarity stream identifier
   * @param audioBase64  base64-encoded audio in the telephony codec (PCMU/PCMA)
   */
  sendAudio(streamSid: string, audioBase64: string): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;

    const msg: KnowlarityMediaSend = {
      event: 'media',
      streamSid,
      media: { payload: audioBase64 },
    };

    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      this.log.error('Failed to send audio to Knowlarity', err as Error);
      return false;
    }
  }

  /**
   * Clear any queued outbound audio (e.g., when user interrupts agent).
   */
  clearAudio(streamSid: string): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const msg: KnowlarityClearSend = { event: 'clear', streamSid };
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      this.log.error('Failed to send clear to Knowlarity', err as Error);
    }
  }

  /**
   * Send a mark event (for synchronisation with Knowlarity's playback queue).
   */
  sendMark(streamSid: string, name: string): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const msg: KnowlarityMarkSend = { event: 'mark', streamSid, mark: { name } };
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      this.log.error('Failed to send mark to Knowlarity', err as Error);
    }
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(1000, 'Call ended');
    }
  }

  get currentStreamSession(): KnowlarityStreamSession | null {
    return this.streamSession;
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }
}
