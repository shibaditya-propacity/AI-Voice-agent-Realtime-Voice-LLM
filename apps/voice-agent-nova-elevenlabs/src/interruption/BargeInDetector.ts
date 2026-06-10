/**
 * BargeInDetector: dual-path interruption detection.
 *
 * Path 1 (primary)   — Deepgram VAD: `SpeechStarted` event fires the moment
 *                       the STT engine detects voice activity. Fastest signal,
 *                       no energy computation needed.
 *
 * Path 2 (secondary) — RMS energy: computed on raw PCMU audio. Fires if
 *                       sustained energy exceeds the configured threshold.
 *                       Provides a backup when Deepgram VAD is slow.
 *
 * Both paths are subject to a cooldown period to prevent repeated triggers
 * from the same utterance.
 */

import { Logger } from '../shared/logger';
import { Env } from '../config/env';

export type BargeInCallback = () => void;

export class BargeInDetector {
  private readonly log: Logger;
  private readonly rmsThreshold: number;
  private readonly confirmMs: number;
  private readonly cooldownMs: number;

  private lastBargeInAt = 0;

  // RMS path state
  private energySpeechStartAt: number | null = null;
  private lastEnergyAboveAt   = 0;
  private readonly GAP_TOLERANCE_MS = 80; // tolerate brief dips below threshold

  /**
   * Timestamp when arm() was last called.
   * Barge-in is suppressed for ARM_GRACE_MS after arming to avoid
   * false positives from PSTN echo and call-connect noise.
   * Default 1500ms: PSTN echo of TTS audio (RMS ~32512) can sustain for
   * 600ms+ — a 600ms grace was too short and caused false barge-ins.
   */
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

  /** Call this when the AI starts speaking to arm the detector. */
  arm(): void {
    this.active = true;
    this.armedAt = Date.now();
    this.energySpeechStartAt = null;
    this.lastEnergyAboveAt   = 0;
    this.log.debug('BargeInDetector armed');
  }

  /** Call when the AI stops speaking (TTS complete). */
  disarm(): void {
    this.active = false;
    this.energySpeechStartAt = null;
    this.log.debug('BargeInDetector disarmed');
  }

  // ─── Path 1: Deepgram VAD ─────────────────────────────────────────────────

  /** Called by orchestrator when Deepgram fires `SpeechStarted`. */
  handleSpeechStarted(): void {
    if (!this.active) return;

    const now = Date.now();

    if (now - this.armedAt < this.ARM_GRACE_MS) {
      this.log.debug('Barge-in suppressed (arm grace)', { graceRemainingMs: this.ARM_GRACE_MS - (now - this.armedAt) });
      return;
    }

    if (now - this.lastBargeInAt < this.cooldownMs) {
      this.log.debug('Barge-in suppressed (cooldown)', { remainingMs: this.cooldownMs - (now - this.lastBargeInAt) });
      return;
    }

    this.log.info('Barge-in detected (Deepgram VAD)');
    this.trigger(now);
  }

  // ─── Path 2: RMS Energy ───────────────────────────────────────────────────

  /** Process a raw PCMU (μ-law) buffer and check for energy-based barge-in. */
  processAudio(pcmuBuffer: Buffer): void {
    if (!this.active) return;

    const now = Date.now();
    const rms  = this.computePcmuRms(pcmuBuffer);

    if (rms > this.rmsThreshold) {
      this.lastEnergyAboveAt = now;

      if (this.energySpeechStartAt === null) {
        this.energySpeechStartAt = now;
      }

      const duration = now - this.energySpeechStartAt;
      if (duration >= this.confirmMs) {
        if (now - this.armedAt < this.ARM_GRACE_MS) return; // grace period
        if (now - this.lastBargeInAt < this.cooldownMs) return;
        this.log.info('Barge-in detected (RMS energy)', { rms, durationMs: duration });
        this.trigger(now);
      }
    } else {
      // Energy dipped below threshold — allow a short gap before resetting
      if (this.energySpeechStartAt !== null && now - this.lastEnergyAboveAt > this.GAP_TOLERANCE_MS) {
        this.energySpeechStartAt = null;
      }
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private trigger(at: number): void {
    this.lastBargeInAt = at;
    this.active = false; // disarm — orchestrator will re-arm on next AI turn
    this.energySpeechStartAt = null;
    this.onBargeIn?.();
  }

  /**
   * Approximate RMS on μ-law samples by expanding to int8 first.
   * Full G.711 decode is unnecessary for energy detection; a simple
   * unsigned-to-signed conversion on the raw byte values is sufficient.
   */
  private computePcmuRms(pcmu: Buffer): number {
    if (pcmu.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < pcmu.length; i++) {
      // μ-law bytes in [0,255]; mid-point 127 represents silence.
      const s = (pcmu[i]! - 127) * 256; // scale to int16 range
      sum += s * s;
    }
    return Math.sqrt(sum / pcmu.length);
  }
}
