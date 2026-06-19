/**
 * AckCache: loads pre-generated acknowledgement audio clips at startup.
 *
 * Used for latency masking — when LLM+TTS takes >1.5s, a short ack clip
 * plays to fill the silence ("बस एक moment", "देखता हूँ", etc.).
 *
 * Clips are raw ulaw 8kHz mono, chunked identically to GreetingCache.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../shared/logger';

const log = Logger.root('AckCache');

/** Twilio media stream expects chunks of ~160 bytes (20ms at 8kHz ulaw) */
const CHUNK_SIZE = 160;

interface AckClip {
  name: string;
  chunks: string[];        // base64-encoded ulaw frames
  durationMs: number;
}

let clips: AckClip[] = [];

/**
 * Load all .raw files from the ack directory and chunk them for Twilio.
 * Called once at server startup.
 */
export function loadAckClips(dirPath: string): void {
  const resolved = path.resolve(dirPath);

  if (!fs.existsSync(resolved)) {
    log.warn('Ack clips directory not found — latency masking disabled', { path: resolved });
    return;
  }

  const files = fs.readdirSync(resolved).filter(f => f.endsWith('.raw')).sort();
  if (files.length === 0) {
    log.warn('No .raw files in ack directory — latency masking disabled', { path: resolved });
    return;
  }

  const loaded: AckClip[] = [];
  for (const file of files) {
    const filePath = path.join(resolved, file);
    const raw = fs.readFileSync(filePath);
    const chunks: string[] = [];

    for (let offset = 0; offset < raw.length; offset += CHUNK_SIZE) {
      const end = Math.min(offset + CHUNK_SIZE, raw.length);
      chunks.push(raw.subarray(offset, end).toString('base64'));
    }

    const durationMs = Math.round((raw.length / 8000) * 1000);
    const name = path.basename(file, '.raw');
    loaded.push({ name, chunks, durationMs });

    log.info('Ack clip loaded', { name, bytes: raw.length, chunks: chunks.length, durationMs });
  }

  clips = loaded;
  log.info('Ack cache ready', { clipCount: clips.length });
}

/** Returns true if any ack clips are available. */
export function hasAckClips(): boolean {
  return clips.length > 0;
}

/** Returns a random ack clip (round-robin could be added later). */
export function getRandomAckClip(): AckClip | null {
  if (clips.length === 0) return null;
  return clips[Math.floor(Math.random() * clips.length)];
}

export type { AckClip };
