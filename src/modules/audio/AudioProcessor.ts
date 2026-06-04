/**
 * AudioProcessor: stateless conversion layer between telephony and internal formats.
 *
 * Inbound:  PCMU/PCMA @ 8kHz       →  PCM16 @ 16kHz   (for Krisp + Nova Sonic input)
 * Outbound: PCM16 @ Nova rate (24k) →  PCMU/PCMA @ 8kHz (for Twilio playback)
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
   * Convert Nova Sonic PCM16 output → telephony audio.
   *
   * Nova emits PCM16 at Env.nova.audioOutputSampleRate (24kHz by default — its
   * native rate). Telephony needs 8kHz. We downsample from Nova's ACTUAL output
   * rate, not from a fixed assumption — using the wrong rate is what made playback
   * sound slow/garbled ("harsh").
   *
   * Pipeline:
   *   PCM16 (Nova rate) → PCM16 (8kHz) → PCMU/PCMA (8kHz, 8-bit)
   */
  async processOutbound(pcm16: Buffer, targetCodec: AudioCodec): Promise<Buffer> {
    if (pcm16.length === 0) return pcm16;

    const srcRate = Env.nova.audioOutputSampleRate;
    const dstRate = Env.audio.telephonySampleRate; // 8000

    // Downsample from Nova's output rate to telephony rate (8kHz)
    let pcm16_8k: Buffer = pcm16;
    if (srcRate !== dstRate) {
      if (srcRate === 24000) {
        pcm16_8k = this.converter.resample24kTo8k(pcm16);
      } else if (srcRate === 16000) {
        pcm16_8k = this.converter.resample16kTo8k(pcm16);
      } else {
        log.warn(
          `Unsupported Nova output rate ${srcRate}Hz → ${dstRate}Hz; sending without resample (audio may sound wrong)`,
        );
      }
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
