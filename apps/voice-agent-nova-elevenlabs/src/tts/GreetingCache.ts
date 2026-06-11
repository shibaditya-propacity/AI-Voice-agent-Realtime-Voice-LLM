/**
 * GreetingCache: loads a pre-recorded greeting audio file at startup and
 * serves it as base64-encoded ulaw_8000 chunks ready for Twilio.
 *
 * Why: eliminates the LLM+TTS round-trip (~2-3s) for the opening greeting.
 * The greeting is always identical, so generating it live is pure waste.
 * While the cached audio plays (~3s), all services warm up in parallel.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../shared/logger';

const log = Logger.root('GreetingCache');

/** Twilio media stream expects chunks of ~160 bytes (20ms at 8kHz ulaw) */
const CHUNK_SIZE = 160;

/** Pre-chunked greeting audio: array of base64-encoded ulaw_8000 frames */
let greetingChunks: string[] = [];

/**
 * Load the pre-recorded greeting from disk and chunk it for Twilio streaming.
 * Called once at server startup. File must be raw ulaw 8kHz mono.
 *
 * @param filePath Path to the raw ulaw audio file (e.g. assets/greet.raw)
 */
export function loadGreetingAudio(filePath: string): void {
  const resolved = path.resolve(filePath);

  if (!fs.existsSync(resolved)) {
    log.warn('Greeting audio file not found — will fall back to LLM greeting', { path: resolved });
    return;
  }

  const raw = fs.readFileSync(resolved);
  const chunks: string[] = [];

  for (let offset = 0; offset < raw.length; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, raw.length);
    chunks.push(raw.subarray(offset, end).toString('base64'));
  }

  greetingChunks = chunks;
  const durationMs = Math.round((raw.length / 8000) * 1000);
  log.info('Greeting audio loaded', {
    path: resolved,
    bytes: raw.length,
    chunks: chunks.length,
    durationMs,
  });
}

/** Returns true if a pre-recorded greeting is available */
export function hasGreetingAudio(): boolean {
  return greetingChunks.length > 0;
}

/** Returns the pre-chunked base64 ulaw frames */
export function getGreetingChunks(): string[] {
  return greetingChunks;
}
