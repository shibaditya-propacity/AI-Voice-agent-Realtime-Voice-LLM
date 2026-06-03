/**
 * Stateless utility functions.
 */

import { v4 as uuidv4 } from 'uuid';

// ─── ID Generation ────────────────────────────────────────────────────────────

export function generateSessionId(): string {
  return `sess_${uuidv4().replace(/-/g, '')}`;
}

export function generateCallId(): string {
  return `call_${uuidv4().replace(/-/g, '')}`;
}

// ─── Time ─────────────────────────────────────────────────────────────────────

export function nowMs(): number {
  return Date.now();
}

export function nowNs(): bigint {
  return process.hrtime.bigint();
}

/** Returns elapsed milliseconds since a hrtime start. */
export function elapsedMs(startNs: bigint): number {
  return Number(process.hrtime.bigint() - startNs) / 1_000_000;
}

// ─── Buffer ───────────────────────────────────────────────────────────────────

/** Safely create a Buffer from a base64 string. */
export function fromBase64(b64: string): Buffer {
  return Buffer.from(b64, 'base64');
}

/** Encode a Buffer to a base64 string. */
export function toBase64(buf: Buffer): string {
  return buf.toString('base64');
}

/** Concatenate multiple Buffers efficiently. */
export function concatBuffers(buffers: Buffer[]): Buffer {
  return Buffer.concat(buffers);
}

/** Split a buffer into chunks of `size` bytes. */
export function* chunkBuffer(buf: Buffer, size: number): Generator<Buffer> {
  for (let offset = 0; offset < buf.length; offset += size) {
    yield buf.subarray(offset, offset + size);
  }
}

// ─── Audio ────────────────────────────────────────────────────────────────────

/**
 * Compute expected frame byte length for raw PCM.
 * @param durationMs  Frame duration in milliseconds
 * @param sampleRate  Samples per second
 * @param bitDepth    Bits per sample (8 | 16 | 32)
 * @param channels    Channel count
 */
export function pcmFrameBytes(
  durationMs: number,
  sampleRate: number,
  bitDepth: 8 | 16 | 32,
  channels: number = 1,
): number {
  return Math.floor((durationMs / 1000) * sampleRate * (bitDepth / 8) * channels);
}

/**
 * Compute duration of a PCM buffer.
 */
export function pcmDurationMs(
  byteLength: number,
  sampleRate: number,
  bitDepth: 8 | 16 | 32,
  channels: number = 1,
): number {
  return (byteLength / ((bitDepth / 8) * channels * sampleRate)) * 1000;
}

// ─── Retry ────────────────────────────────────────────────────────────────────

export interface RetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
  onAttempt?: (attempt: number, error: Error) => void;
}

/**
 * Retry an async operation with exponential backoff.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let delayMs = opts.initialDelayMs;
  let lastError: Error = new Error('No attempts made');

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (opts.onAttempt) opts.onAttempt(attempt, lastError);
      if (attempt < opts.maxAttempts) {
        await sleep(delayMs);
        delayMs = Math.min(delayMs * opts.backoffFactor, opts.maxDelayMs);
      }
    }
  }

  throw lastError;
}

// ─── Async ────────────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps a promise with a timeout.
 * Rejects with a descriptive error if not resolved within `timeoutMs`.
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

export function isValidPhoneNumber(number: string): boolean {
  // E.164 format: + followed by 7-15 digits
  return /^\+[1-9]\d{6,14}$/.test(number);
}

export function sanitizePhoneNumber(number: string): string {
  // Strip everything except digits and leading +
  return number.replace(/[^\d+]/g, '');
}
