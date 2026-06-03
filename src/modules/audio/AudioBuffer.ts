/**
 * Fixed-size circular audio buffer with backpressure signalling.
 * Prevents memory growth during slow consumers (Nova Sonic, Krisp).
 */

import { Logger } from '../../shared/Logger';

const log = Logger.root('AudioBuffer');

export interface AudioBufferOptions {
  maxBytes: number;
  sessionId?: string;
  callId?: string;
}

export class AudioBuffer {
  private readonly maxBytes: number;
  private chunks: Buffer[] = [];
  private totalBytes: number = 0;
  private readonly sessionId: string;
  private readonly callId: string;

  /** Number of bytes that have been dropped due to overflow. */
  private droppedBytes: number = 0;

  constructor(opts: AudioBufferOptions) {
    this.maxBytes = opts.maxBytes;
    this.sessionId = opts.sessionId ?? 'unknown';
    this.callId = opts.callId ?? 'unknown';
  }

  /**
   * Push a chunk into the buffer.
   * If adding the chunk would exceed maxBytes, the oldest chunks are evicted
   * to make room, and a warning is logged.
   */
  push(chunk: Buffer): void {
    // Evict oldest chunks to make room
    while (this.totalBytes + chunk.length > this.maxBytes && this.chunks.length > 0) {
      const evicted = this.chunks.shift()!;
      this.totalBytes -= evicted.length;
      this.droppedBytes += evicted.length;
    }

    if (chunk.length > this.maxBytes) {
      // Single chunk larger than entire buffer — drop it
      this.droppedBytes += chunk.length;
      log.warn('Audio chunk larger than buffer capacity — dropped', {
        sessionId: this.sessionId,
        callId: this.callId,
        chunkBytes: chunk.length,
        maxBytes: this.maxBytes,
      });
      return;
    }

    if (this.droppedBytes > 0) {
      log.warn('Audio buffer overflow — older audio dropped', {
        sessionId: this.sessionId,
        callId: this.callId,
        droppedBytes: this.droppedBytes,
      });
      this.droppedBytes = 0;
    }

    this.chunks.push(chunk);
    this.totalBytes += chunk.length;
  }

  /**
   * Read up to `byteCount` bytes from the front of the buffer.
   * Returns fewer bytes if the buffer has less than `byteCount` available.
   */
  read(byteCount: number): Buffer {
    if (this.totalBytes === 0) return Buffer.alloc(0);

    const target = Math.min(byteCount, this.totalBytes);
    const parts: Buffer[] = [];
    let remaining = target;

    while (remaining > 0 && this.chunks.length > 0) {
      const chunk = this.chunks[0]!;
      if (chunk.length <= remaining) {
        parts.push(chunk);
        remaining -= chunk.length;
        this.totalBytes -= chunk.length;
        this.chunks.shift();
      } else {
        // Partial consume from front chunk
        parts.push(chunk.subarray(0, remaining));
        this.chunks[0] = chunk.subarray(remaining);
        this.totalBytes -= remaining;
        remaining = 0;
      }
    }

    return Buffer.concat(parts);
  }

  /**
   * Drain all buffered audio as a single Buffer.
   */
  drain(): Buffer {
    if (this.chunks.length === 0) return Buffer.alloc(0);
    const result = Buffer.concat(this.chunks);
    this.chunks = [];
    this.totalBytes = 0;
    return result;
  }

  /**
   * Check if the buffer contains at least `byteCount` bytes.
   */
  hasBytes(byteCount: number): boolean {
    return this.totalBytes >= byteCount;
  }

  get availableBytes(): number {
    return this.totalBytes;
  }

  get isFull(): boolean {
    return this.totalBytes >= this.maxBytes;
  }

  get isEmpty(): boolean {
    return this.totalBytes === 0;
  }

  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }
}
