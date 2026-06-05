/**
 * Minimal WAV (RIFF/PCM) loader for the static opening greeting.
 *
 * Parses a 16-bit PCM WAV, downmixes to mono, and linear-resamples to a target
 * rate. Used to load a pre-recorded greeting clip at boot so the agent can speak
 * immediately on call connect — Nova 2 Sonic does not speak first on its own
 * (it responds to caller audio), so the opening greeting must be supplied here.
 */

import fs from 'fs';

export interface DecodedWav {
  pcm16: Buffer;
  sampleRate: number;
  channels: number;
}

/** Decode a 16-bit PCM WAV buffer. Throws on unsupported formats. */
export function decodeWav(buf: Buffer): DecodedWav {
  if (
    buf.length < 44 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('Not a RIFF/WAVE file');
  }

  let offset = 12;
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let data: Buffer | null = null;

  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (chunkId === 'data') {
      data = buf.subarray(body, Math.min(buf.length, body + chunkSize));
    }
    // Chunks are word-aligned (padded to even length).
    offset = body + chunkSize + (chunkSize % 2);
  }

  if (!fmt) throw new Error('WAV missing "fmt " chunk');
  if (!data) throw new Error('WAV missing "data" chunk');
  if (fmt.audioFormat !== 1) throw new Error(`WAV must be uncompressed PCM (audioFormat=1), got ${fmt.audioFormat}`);
  if (fmt.bitsPerSample !== 16) throw new Error(`WAV must be 16-bit PCM, got ${fmt.bitsPerSample}-bit`);
  if (fmt.channels < 1) throw new Error(`WAV has invalid channel count ${fmt.channels}`);

  return { pcm16: data, sampleRate: fmt.sampleRate, channels: fmt.channels };
}

/** Downmix interleaved PCM16 to mono by averaging channels. */
export function toMono(pcm16: Buffer, channels: number): Buffer {
  if (channels <= 1) return pcm16;
  const frames = Math.floor(pcm16.length / (2 * channels));
  const out = Buffer.allocUnsafe(frames * 2);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += pcm16.readInt16LE((i * channels + c) * 2);
    out.writeInt16LE(Math.round(sum / channels), i * 2);
  }
  return out;
}

/** Linear-interpolation resample of mono PCM16 from srcRate → dstRate. */
export function resampleLinearMono(pcm16: Buffer, srcRate: number, dstRate: number): Buffer {
  if (srcRate === dstRate) return pcm16;
  const inSamples = pcm16.length >> 1;
  if (inSamples === 0) return Buffer.alloc(0);
  const outSamples = Math.max(1, Math.round((inSamples * dstRate) / srcRate));
  const out = Buffer.allocUnsafe(outSamples * 2);
  const denom = Math.max(1, outSamples - 1);
  for (let i = 0; i < outSamples; i++) {
    const srcPos = (i * (inSamples - 1)) / denom;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(inSamples - 1, i0 + 1);
    const frac = srcPos - i0;
    const s0 = pcm16.readInt16LE(i0 * 2);
    const s1 = pcm16.readInt16LE(i1 * 2);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i * 2);
  }
  return out;
}

/**
 * Load a greeting WAV from disk → mono PCM16 at `targetRate`.
 * Returns the resampled PCM and its duration in ms. Throws on read/parse error.
 */
export function loadGreetingWav(path: string, targetRate: number): { pcm16: Buffer; durationMs: number } {
  const raw = fs.readFileSync(path);
  const wav = decodeWav(raw);
  const mono = toMono(wav.pcm16, wav.channels);
  const pcm16 = resampleLinearMono(mono, wav.sampleRate, targetRate);
  const durationMs = Math.round((pcm16.length / 2 / targetRate) * 1000);
  return { pcm16, durationMs };
}
