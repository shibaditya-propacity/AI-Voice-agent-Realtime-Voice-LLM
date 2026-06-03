/**
 * AudioProcessor: stateless conversion layer between telephony and internal formats.
 *
 * Inbound:  PCMU/PCMA @ 8kHz  →  PCM16 @ 16kHz   (for Krisp + Nova Sonic)
 * Outbound: PCM16 @ 16kHz     →  PCMU/PCMA @ 8kHz (for Knowlarity playback)
 */

import { Env } from '../../config';
import { Logger } from '../../shared/Logger';
import { AudioCodec } from '../../types';
import { IAudioProcessor } from './AudioTypes';
import { CodecConverter } from './CodecConverter';

const log = Logger.root('AudioProcessor');

export class AudioProcessor implements IAudioProcessor {
  private readonly converter: CodecConverter;
  private readonly telephonyCodec: AudioCodec;

  constructor(converter: CodecConverter) {
    this.converter = converter;
    this.telephonyCodec = Env.audio.telephonyCodec;
  }

  /**
   * Convert raw telephony audio → internal PCM16 @ 16kHz.
   *
   * Pipeline:
   *   PCMU/PCMA (8kHz, 8-bit) → PCM16 (8kHz, 16-bit) → PCM16 (16kHz, 16-bit)
   */
  async processInbound(raw: Buffer, sourceCodec: AudioCodec): Promise<Buffer> {
    if (raw.length === 0) return raw;

    let pcm16_8k: Buffer;

    switch (sourceCodec) {
      case 'pcmu':
        pcm16_8k = this.converter.pcmuToPcm16(raw);
        break;
      case 'pcma':
        pcm16_8k = this.converter.pcmaToPcm16(raw);
        break;
      case 'pcm16':
        // Already 16-bit; assume 8kHz from telephony
        pcm16_8k = raw;
        break;
      default:
        log.warn(`Unknown source codec: ${sourceCodec}; passing through unchanged`);
        return raw;
    }

    // Upsample from telephony rate (8kHz) to internal rate (16kHz)
    if (Env.audio.telephonySampleRate !== Env.audio.internalSampleRate) {
      return this.converter.resample8kTo16k(pcm16_8k);
    }

    return pcm16_8k;
  }

  /**
   * Convert internal PCM16 @ 16kHz → telephony audio.
   *
   * Pipeline:
   *   PCM16 (16kHz, 16-bit) → PCM16 (8kHz, 16-bit) → PCMU/PCMA (8kHz, 8-bit)
   */
  async processOutbound(pcm16: Buffer, targetCodec: AudioCodec): Promise<Buffer> {
    if (pcm16.length === 0) return pcm16;

    // Downsample from internal rate (16kHz) to telephony rate (8kHz)
    let pcm16_8k: Buffer = pcm16;
    if (Env.audio.telephonySampleRate !== Env.audio.internalSampleRate) {
      pcm16_8k = this.converter.resample16kTo8k(pcm16);
    }

    switch (targetCodec) {
      case 'pcmu':
        return this.converter.pcm16ToPcmu(pcm16_8k);
      case 'pcma':
        return this.converter.pcm16ToPcma(pcm16_8k);
      case 'pcm16':
        return pcm16_8k;
      default:
        log.warn(`Unknown target codec: ${targetCodec}; returning PCM16`);
        return pcm16_8k;
    }
  }
}
