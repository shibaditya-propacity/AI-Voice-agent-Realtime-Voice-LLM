/**
 * G.711 μ-law / A-law ↔ PCM16 codec conversion + PCM resampling.
 *
 * Implements the standard ITU-T G.711 algorithm in pure TypeScript.
 * No native addons required.
 *
 * Reference:
 *   https://www.itu.int/rec/T-REC-G.711/en
 */

import { ICodecConverter } from './AudioTypes';

// ─── μ-law (PCMU) lookup tables ──────────────────────────────────────────────

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

/** Precomputed μ-law → linear 16-bit PCM decode table (256 entries). */
const MULAW_DECODE_TABLE: Int16Array = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    let ulawByte = ~i & 0xff;
    const sign = ulawByte & 0x80;
    const exponent = (ulawByte >> 4) & 0x07;
    const mantissa = ulawByte & 0x0f;
    let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
    sample -= MULAW_BIAS;
    table[i] = sign !== 0 ? -sample : sample;
  }
  return table;
})();

/** Encode a signed 16-bit linear PCM sample to μ-law. */
function encodeMulaw(sample: number): number {
  let s = sample;
  let sign = 0;
  if (s < 0) {
    s = -s;
    sign = 0x80;
  }
  if (s > MULAW_CLIP) s = MULAW_CLIP;
  s += MULAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (s & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {
    // intentionally empty
  }
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// ─── A-law (PCMA) lookup tables ───────────────────────────────────────────────

/** Precomputed A-law → linear 16-bit PCM decode table (256 entries). */
const ALAW_DECODE_TABLE: Int16Array = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const alaw = i ^ 0x55;
    const sign = alaw & 0x80;
    const exponent = (alaw & 0x70) >> 4;
    let data = alaw & 0x0f;
    data <<= 1;
    data |= 1;
    if (exponent !== 0) {
      data |= 0x20;
      data <<= exponent - 1;
    }
    table[i] = sign !== 0 ? data : -data;
  }
  return table;
})();

/** Encode a signed 16-bit linear PCM sample to A-law. */
function encodeAlaw(sample: number): number {
  let s = sample;
  let mask = 0xd5;
  if (s < 0) {
    s = -s;
    mask = 0x55;
  }
  if (s > 32767) s = 32767;

  let encoded: number;
  if (s >= 256) {
    let exponent = 7;
    for (let expMask = 0x4000; (s & expMask) === 0; exponent--, expMask >>= 1) {
      // intentionally empty
    }
    const mantissa = (s >> (exponent + 3)) & 0x0f;
    encoded = (exponent << 4) | mantissa;
  } else {
    encoded = s >> 4;
  }
  return encoded ^ mask;
}

// ─── CodecConverter ───────────────────────────────────────────────────────────

export class CodecConverter implements ICodecConverter {
  // ─── PCMU → PCM16 ────────────────────────────────────────────────────────

  pcmuToPcm16(pcmu: Buffer): Buffer {
    const out = Buffer.allocUnsafe(pcmu.length * 2);
    for (let i = 0; i < pcmu.length; i++) {
      out.writeInt16LE(MULAW_DECODE_TABLE[pcmu[i]!]!, i * 2);
    }
    return out;
  }

  // ─── PCMA → PCM16 ────────────────────────────────────────────────────────

  pcmaToPcm16(pcma: Buffer): Buffer {
    const out = Buffer.allocUnsafe(pcma.length * 2);
    for (let i = 0; i < pcma.length; i++) {
      out.writeInt16LE(ALAW_DECODE_TABLE[pcma[i]!]!, i * 2);
    }
    return out;
  }

  // ─── PCM16 → PCMU ────────────────────────────────────────────────────────

  pcm16ToPcmu(pcm16: Buffer): Buffer {
    const sampleCount = pcm16.length >> 1; // divide by 2 (bytes per sample)
    const out = Buffer.allocUnsafe(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      out[i] = encodeMulaw(pcm16.readInt16LE(i * 2));
    }
    return out;
  }

  // ─── PCM16 → PCMA ────────────────────────────────────────────────────────

  pcm16ToPcma(pcm16: Buffer): Buffer {
    const sampleCount = pcm16.length >> 1;
    const out = Buffer.allocUnsafe(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      out[i] = encodeAlaw(pcm16.readInt16LE(i * 2));
    }
    return out;
  }

  // ─── Resampling: 8kHz → 16kHz (linear interpolation) ────────────────────

  resample8kTo16k(pcm16_8k: Buffer): Buffer {
    const inputSamples = pcm16_8k.length >> 1;
    const outputSamples = inputSamples * 2;
    const out = Buffer.allocUnsafe(outputSamples * 2);

    for (let i = 0; i < inputSamples; i++) {
      const s0 = pcm16_8k.readInt16LE(i * 2);
      const s1 = i + 1 < inputSamples ? pcm16_8k.readInt16LE((i + 1) * 2) : s0;

      out.writeInt16LE(s0, i * 4);
      // Interpolate midpoint
      out.writeInt16LE(Math.round((s0 + s1) / 2), i * 4 + 2);
    }

    return out;
  }

  // ─── Resampling: 16kHz → 8kHz (decimate every other sample) ─────────────

  resample16kTo8k(pcm16_16k: Buffer): Buffer {
    const inputSamples = pcm16_16k.length >> 1;
    const outputSamples = Math.floor(inputSamples / 2);
    const out = Buffer.allocUnsafe(outputSamples * 2);

    for (let i = 0; i < outputSamples; i++) {
      // Average two consecutive samples (anti-aliasing)
      const s0 = pcm16_16k.readInt16LE(i * 4);
      const s1 = pcm16_16k.readInt16LE(i * 4 + 2);
      out.writeInt16LE(Math.round((s0 + s1) / 2), i * 2);
    }

    return out;
  }
}
