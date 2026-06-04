/**
 * Audio module data structures and interfaces.
 */

import { AudioCodec } from '../../types';

// ─── Codec Profile ────────────────────────────────────────────────────────────

export interface CodecProfile {
  codec: AudioCodec;
  sampleRate: number;
  bitDepth: 8 | 16 | 32;
  channels: number;
  /** Bytes per sample (bitDepth / 8). */
  bytesPerSample: number;
  /** Bytes per millisecond of audio. */
  bytesPerMs: number;
}

export const CODEC_PROFILES: Record<AudioCodec, CodecProfile> = {
  pcmu: {
    codec: 'pcmu',
    sampleRate: 8000,
    bitDepth: 8,
    channels: 1,
    bytesPerSample: 1,
    bytesPerMs: 8, // 8000 samples/s * 1 byte / 1000ms
  },
  pcma: {
    codec: 'pcma',
    sampleRate: 8000,
    bitDepth: 8,
    channels: 1,
    bytesPerSample: 1,
    bytesPerMs: 8,
  },
  pcm16: {
    codec: 'pcm16',
    sampleRate: 16000,
    bitDepth: 16,
    channels: 1,
    bytesPerSample: 2,
    bytesPerMs: 32, // 16000 * 2 / 1000
  },
  pcm32: {
    codec: 'pcm32',
    sampleRate: 44100,
    bitDepth: 32,
    channels: 1,
    bytesPerSample: 4,
    bytesPerMs: Math.round(44100 * 4 / 1000),
  },
  opus: {
    codec: 'opus',
    sampleRate: 48000,
    bitDepth: 16,
    channels: 1,
    bytesPerSample: 2,
    bytesPerMs: Math.round(48000 * 2 / 1000),
  },
};

// ─── Buffer State ─────────────────────────────────────────────────────────────

export interface BufferState {
  chunks: Buffer[];
  totalBytes: number;
  chunkCount: number;
  oldestChunkAt: number;
  newestChunkAt: number;
}

// ─── Audio Processor Interface ────────────────────────────────────────────────

export interface IAudioProcessor {
  /**
   * Convert an inbound telephony audio frame into the internal PCM16 format
   * used by Krisp and Nova Sonic.
   */
  processInbound(raw: Buffer, sourceCodec: AudioCodec): Promise<Buffer>;

  /**
   * Convert an internal PCM16 response buffer back into the telephony codec
   * expected by Knowlarity.
   */
  processOutbound(pcm16: Buffer, targetCodec: AudioCodec): Promise<Buffer>;
}

// ─── Codec Converter Interface ────────────────────────────────────────────────

export interface ICodecConverter {
  /** Decode a G.711 μ-law (PCMU) buffer to signed 16-bit PCM at 8kHz. */
  pcmuToPcm16(pcmu: Buffer): Buffer;

  /** Decode a G.711 A-law (PCMA) buffer to signed 16-bit PCM at 8kHz. */
  pcmaToPcm16(pcma: Buffer): Buffer;

  /** Encode signed 16-bit PCM at 8kHz to G.711 μ-law (PCMU). */
  pcm16ToPcmu(pcm16: Buffer): Buffer;

  /** Encode signed 16-bit PCM at 8kHz to G.711 A-law (PCMA). */
  pcm16ToPcma(pcm16: Buffer): Buffer;

  /** Upsample a 16-bit mono PCM buffer from 8kHz to 16kHz. */
  resample8kTo16k(pcm16_8k: Buffer): Buffer;

  /** Downsample a 16-bit mono PCM buffer from 16kHz to 8kHz. */
  resample16kTo8k(pcm16_16k: Buffer): Buffer;

  /** Downsample a 16-bit mono PCM buffer from 24kHz to 8kHz (Nova Sonic output). */
  resample24kTo8k(pcm16_24k: Buffer): Buffer;
}
