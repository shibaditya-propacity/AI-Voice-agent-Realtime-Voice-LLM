/**
 * BargeInDetector: dual-path interruption detection (VAD + RMS).
 */

import { Logger } from '../../shared/Logger';
import { Env } from '../../config';

export type BargeInCallback = () => void;

export class BargeInDetector {
  private readonly log: Logger;
  private readonly rmsThreshold: number;
  private readonly confirmMs: number;
  private readonly cooldownMs: number;

  private lastBargeInAt = 0;

  private energySpeechStartAt: number | null = null;
  private lastEnergyAboveAt   = 0;
  private readonly GAP_TOLERANCE_MS = 80;

  private armedAt = 0;
  private readonly ARM_GRACE_MS: number;

  private onBargeIn?: BargeInCallback;
  private active = false;

  constructor(callSid: string) {
    this.log           = Logger.forCall(callSid, 'BargeInDetector');
    this.rmsThreshold  = Env.bargeIn.rmsThreshold;
    this.confirmMs     = Env.bargeIn.confirmMs;
    this.cooldownMs    = Env.bargeIn.cooldownMs;
    this.ARM_GRACE_MS  = Env.bargeIn.graceMs;
  }

  onInterruption(cb: BargeInCallback): this { this.onBargeIn = cb; return this; }

  arm(): void {
    this.active = true;
    this.armedAt = Date.now();
    this.energySpeechStartAt = null;
  }

  disarm(): void {
    this.active = false;
    this.energySpeechStartAt = null;
  }

  /** Deepgram VAD path — instant, already confirmed by STT engine. */
  handleSpeechStarted(): void {
    if (!this.active) return;
    const now = Date.now();
    if (now - this.armedAt < this.ARM_GRACE_MS) return;
    if (now - this.lastBargeInAt < this.cooldownMs) return;

    this.lastBargeInAt = now;
    this.log.info('Barge-in triggered (VAD path)');
    this.onBargeIn?.();
  }

  /** RMS energy path — backup when VAD is slow. */
  handleEnergy(rms: number): void {
    if (!this.active) return;
    const now = Date.now();
    if (now - this.armedAt < this.ARM_GRACE_MS) return;

    if (rms >= this.rmsThreshold) {
      this.lastEnergyAboveAt = now;
      if (this.energySpeechStartAt === null) {
        this.energySpeechStartAt = now;
      } else if (now - this.energySpeechStartAt >= this.confirmMs) {
        if (now - this.lastBargeInAt < this.cooldownMs) return;
        this.lastBargeInAt = now;
        this.energySpeechStartAt = null;
        this.log.info('Barge-in triggered (RMS path)', { rms });
        this.onBargeIn?.();
      }
    } else {
      if (this.energySpeechStartAt !== null && now - this.lastEnergyAboveAt > this.GAP_TOLERANCE_MS) {
        this.energySpeechStartAt = null;
      }
    }
  }
}
