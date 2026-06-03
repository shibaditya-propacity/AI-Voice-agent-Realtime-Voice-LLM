/**
 * KrispProcessor: thin adapter around the Krisp SDK.
 *
 * The Krisp Server SDK is a native Node.js addon distributed by Krisp.
 * It processes PCM16 audio frames and returns noise-suppressed PCM16 audio.
 * No runtime API key is required — the SDK is activated via local model files
 * (and optionally a license file) bundled from the Krisp SDK package.
 *
 * SDK contract (adjust the require() path to match your installed package):
 *   const krisp = require('@krisp/krisp-sdk');          // or your package name
 *   krisp.init({ modelPath, sampleRate, frameSize });
 *   krisp.processFrame(inputBuffer: Buffer): Buffer;
 *   krisp.destroy();
 *
 * If the SDK is unavailable (not yet installed, CI environment, etc.) the
 * processor silently falls back to pass-through so the rest of the pipeline
 * keeps working.
 */

import path from 'path';
import { Env } from '../../config';
import { Logger } from '../../shared/Logger';

const log = Logger.root('KrispProcessor');

// ─── Krisp SDK Type Shim ─────────────────────────────────────────────────────
// Adjust this interface to match the exact API of your Krisp SDK version.

interface KrispSDK {
  init(options: {
    modelPath: string;
    sampleRate: number;
    frameSize: number;
    /** Optional path to a Krisp license file (required by some SDK editions). */
    licensePath?: string;
  }): void;
  processFrame(input: Buffer): Buffer;
  destroy(): void;
}

// ─── KrispProcessor ──────────────────────────────────────────────────────────

export class KrispProcessor {
  private sdk: KrispSDK | null = null;
  private initialized: boolean = false;
  private passThrough: boolean = false;

  /** Frame size in bytes: PCM16 = 2 bytes per sample. */
  private readonly frameSizeBytes: number;

  constructor() {
    this.frameSizeBytes = Env.krisp.frameSizeSamples * 2;
  }

  async initialize(): Promise<void> {
    try {
      // Dynamic require keeps the codebase compilable before the SDK is installed.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const krispModule = require('@krisp/krisp-sdk') as KrispSDK;

      const initOptions: Parameters<KrispSDK['init']>[0] = {
        modelPath: path.resolve(Env.krisp.modelPath),
        sampleRate: Env.audio.internalSampleRate,
        frameSize: Env.krisp.frameSizeSamples,
      };

      // Only pass licensePath if one has been configured
      if (Env.krisp.licensePath) {
        initOptions.licensePath = path.resolve(Env.krisp.licensePath);
      }

      krispModule.init(initOptions);

      this.sdk = krispModule;
      this.initialized = true;

      log.info('Krisp SDK initialized', {
        modelPath: initOptions.modelPath,
        sampleRate: initOptions.sampleRate,
        frameSizeSamples: Env.krisp.frameSizeSamples,
        licenseConfigured: !!Env.krisp.licensePath,
      });
    } catch (err) {
      log.warn(
        'Krisp SDK unavailable — noise suppression disabled (pass-through mode)',
        { error: (err as Error).message },
      );
      this.passThrough = true;
    }
  }

  /**
   * Process a buffer of PCM16 audio @ 16 kHz through Krisp noise suppression.
   *
   * The SDK operates on fixed-size frames. We slice the input into frames,
   * process each one, and concatenate the results. Any trailing bytes shorter
   * than a full frame are passed through unchanged.
   *
   * In pass-through mode the input is returned as-is.
   */
  processAudio(input: Buffer): Buffer {
    if (this.passThrough || !this.sdk) return input;
    if (input.length === 0) return input;

    const frameSize = this.frameSizeBytes;
    const outputParts: Buffer[] = [];
    let offset = 0;

    while (offset + frameSize <= input.length) {
      const frame = input.subarray(offset, offset + frameSize);
      try {
        outputParts.push(this.sdk.processFrame(frame));
      } catch (err) {
        log.warn('Krisp frame processing error — using raw frame', {
          error: (err as Error).message,
        });
        outputParts.push(frame);
      }
      offset += frameSize;
    }

    // Trailing partial frame — pass through unchanged
    if (offset < input.length) {
      outputParts.push(input.subarray(offset));
    }

    return Buffer.concat(outputParts);
  }

  get isActive(): boolean {
    return this.initialized && !this.passThrough;
  }

  destroy(): void {
    if (this.sdk) {
      try {
        this.sdk.destroy();
      } catch (err) {
        log.warn('Error destroying Krisp SDK', { error: (err as Error).message });
      }
      this.sdk = null;
      this.initialized = false;
    }
  }
}
