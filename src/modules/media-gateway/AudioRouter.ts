/**
 * AudioRouter: routes audio between Twilio ↔ Krisp ↔ Nova Sonic.
 *
 * Inbound pipeline (caller → agent):
 *   1. Raw telephony audio (PCMU @ 8kHz) from Twilio
 *   2. AudioProcessor → PCM16 @ 16kHz
 *   3. KrispService → noise suppressed PCM16
 *   4. NovaSessionManager → Nova Sonic
 *
 * Outbound pipeline (agent → caller):
 *   1. PCM16 @ Nova output rate (24kHz native) from Nova Sonic
 *   2. AudioProcessor → downsample to 8kHz → telephony codec (PCMU @ 8kHz)
 *   3. Base64-encode → TwilioService
 */

import { Env } from '../../config';
import { AppEvent } from '../../events/EventTypes';
import { eventBus } from '../../shared/EventBus';
import { Logger } from '../../shared/Logger';
import { fromBase64, toBase64, nowMs } from '../../utils/helpers';
import { latencyRegistry, detectSpeechEnd } from '../../shared/LatencyRegistry';
import { AudioProcessor } from '../audio/AudioProcessor';
import { KrispService } from '../krisp/KrispService';
import { NovaSessionManager } from '../nova/NovaSessionManager';
// import { KnowlarityService } from '../knowlarity/KnowlarityService'; // ← commented out: replaced by Twilio
import { TwilioService } from '../twilio/TwilioService';
import { SessionManager } from '../session/SessionManager';

export class AudioRouter {
  private readonly audioProcessor: AudioProcessor;
  private readonly krispService: KrispService;
  private readonly novaSessionManager: NovaSessionManager;
  // private readonly knowlarityService: KnowlarityService; // ← commented out
  private readonly twilioService: TwilioService;
  private readonly sessionManager: SessionManager;
  private readonly log: Logger;

  /**
   * Per-session: last Twilio sequence number seen.
   * Used to deduplicate inbound frames — a frame with seqNum ≤ lastSeqNum is
   * a re-delivery and must be ignored to prevent double-processing.
   */
  private readonly lastSeqNums = new Map<string, number>();

  /**
   * Per-session: epoch-ms of the last proactive barge-in we triggered.
   * Guards against firing handleInterruption() on every high-energy frame
   * while the agent is speaking — one trigger per 2-second window is enough.
   */
  private readonly lastBargeInAt = new Map<string, number>();

  /** Minimum RMS energy (PCM16) that counts as "caller is speaking". */
  private static readonly BARGE_IN_RMS_THRESHOLD = Env.audio.vadRmsThreshold;

  /** Minimum ms between consecutive proactive barge-in triggers for the same session. */
  private static readonly BARGE_IN_COOLDOWN_MS = 2_000;

  constructor(
    audioProcessor: AudioProcessor,
    krispService: KrispService,
    novaSessionManager: NovaSessionManager,
    // knowlarityService: KnowlarityService, // ← commented out
    twilioService: TwilioService,
    sessionManager: SessionManager,
  ) {
    this.audioProcessor = audioProcessor;
    this.krispService = krispService;
    this.novaSessionManager = novaSessionManager;
    // this.knowlarityService = knowlarityService; // ← commented out
    this.twilioService = twilioService;
    this.sessionManager = sessionManager;
    this.log = Logger.root('AudioRouter');
  }

  // ─── RMS helper ───────────────────────────────────────────────────────────

  /**
   * Compute root-mean-square energy of a PCM16-LE buffer.
   * Used for proactive barge-in detection: if the caller's RMS is above the VAD
   * threshold while the agent is speaking, we immediately interrupt playback.
   */
  private static computeRms(pcm16: Buffer): number {
    const samples = pcm16.length >> 1; // 2 bytes per sample
    if (samples === 0) return 0;
    let sumSq = 0;
    for (let i = 0; i < samples; i++) {
      const s = pcm16.readInt16LE(i * 2);
      sumSq += s * s;
    }
    return Math.sqrt(sumSq / samples);
  }

  // ─── Inbound: Caller → Nova Sonic ─────────────────────────────────────────

  async routeInbound(
    callId: string,
    sessionId: string,
    audioBase64: string,
    seqNum: number,
  ): Promise<void> {
    // ── Deduplication ────────────────────────────────────────────────────────
    // Twilio can occasionally re-deliver a frame on reconnect or network blip.
    // Sequence numbers are strictly ascending; anything ≤ last seen is a duplicate.
    if (seqNum > 0) {
      const lastSeq = this.lastSeqNums.get(sessionId) ?? 0;
      if (seqNum <= lastSeq) {
        this.log.warn('DUPLICATE UTTERANCE IGNORED — duplicate inbound sequence number', {
          sessionId,
          callId,
          seqNum,
          lastSeq,
        });
        return;
      }
      this.lastSeqNums.set(sessionId, seqNum);
    }

    const raw = fromBase64(audioBase64);
    if (raw.length === 0) return;

    const codec = Env.audio.telephonyCodec;
    const tStart = process.hrtime.bigint();

    // Step 1: Decode + resample to PCM16 @ 16kHz
    let pcm16: Buffer;
    try {
      pcm16 = await this.audioProcessor.processInbound(raw, codec);
    } catch (err) {
      this.log.error('Inbound audio conversion failed', err as Error, { sessionId, callId });
      return;
    }
    const tDecoded = process.hrtime.bigint();

    // ── Proactive barge-in detection ─────────────────────────────────────────
    // If the agent is currently speaking (AI_SPEAKING) and the caller's energy
    // is above the VAD threshold, interrupt immediately — don't wait for Nova's
    // own endpointing. This gives true instant barge-in:
    //   1. Twilio's outbound buffer is cleared (caller hears silence instantly).
    //   2. Nova's in-flight audio content block is marked cancelled.
    //   3. State transitions to INTERRUPTED.
    // Nova's native VAD will then emit a new completionStart for the caller's
    // speech, at which point the state transitions to AI_THINKING → AI_SPEAKING.
    if (this.novaSessionManager.isAgentSpeaking(sessionId)) {
      const rms = AudioRouter.computeRms(pcm16);
      if (rms >= AudioRouter.BARGE_IN_RMS_THRESHOLD) {
        const now = Date.now();
        const lastBarge = this.lastBargeInAt.get(sessionId) ?? 0;
        if (now - lastBarge >= AudioRouter.BARGE_IN_COOLDOWN_MS) {
          this.lastBargeInAt.set(sessionId, now);
          this.log.warn('⚡ BARGE-IN DETECTED — caller speech during AI playback — stopping output immediately', {
            sessionId,
            callId,
            rms: Math.round(rms),
            threshold: AudioRouter.BARGE_IN_RMS_THRESHOLD,
            seqNum,
          });
          this.handleInterruption(callId, sessionId);
        }
      }
    }

    // Energy VAD (measurement only): timestamp when the caller stops speaking so we
    // can measure Nova's endpointing latency. Does not alter the audio path.
    const speechEndAt = detectSpeechEnd(sessionId, pcm16);
    if (speechEndAt !== null) latencyRegistry.setSpeechEnd(sessionId, speechEndAt);

    eventBus.emit(AppEvent.AUDIO_RECEIVED, {
      sessionId,
      callId,
      timestamp: nowMs(),
      chunk: raw,
      codec,
      sampleRate: Env.audio.telephonySampleRate,
      sequenceNumber: seqNum,
    });

    // Step 2: Noise suppression via Krisp
    let cleanPcm16: Buffer;
    try {
      cleanPcm16 = this.krispService.process(sessionId, pcm16);
    } catch (err) {
      this.log.warn('Krisp processing error — using unprocessed audio', {
        sessionId,
        error: (err as Error).message,
      });
      cleanPcm16 = pcm16;
    }
    const tKrisp = process.hrtime.bigint();

    eventBus.emit(AppEvent.AUDIO_PROCESSED, {
      sessionId,
      callId,
      timestamp: nowMs(),
      chunk: cleanPcm16,
      sampleRate: Env.audio.internalSampleRate,
      source: 'krisp',
    });

    // Step 3: Stream to Nova Sonic
    this.novaSessionManager.pushAudio(sessionId, cleanPcm16);

    // Per-frame inbound cost (microseconds): decode, krisp, total.
    const decodeUs = Number(tDecoded - tStart) / 1000;
    const krispUs = Number(tKrisp - tDecoded) / 1000;
    const totalUs = Number(process.hrtime.bigint() - tStart) / 1000;
    latencyRegistry.recordInbound(sessionId, decodeUs, krispUs, totalUs);

    this.sessionManager.recordAudioStats(sessionId, {
      framesReceived: 1,
      framesProcessed: 1,
      bytesReceived: raw.length,
    });
  }

  // ─── Outbound: Nova Sonic → Caller ────────────────────────────────────────

  async routeOutbound(callId: string, sessionId: string, pcm16: Buffer): Promise<void> {
    if (pcm16.length === 0) return;

    const targetCodec = Env.audio.telephonyCodec;

    // Step 1: Downsample + encode to telephony codec
    let encoded: Buffer;
    try {
      encoded = await this.audioProcessor.processOutbound(pcm16, targetCodec);
    } catch (err) {
      this.log.error('Outbound audio conversion failed', err as Error, { sessionId, callId });
      return;
    }

    // Step 2: Send to Twilio
    // (was: this.knowlarityService.sendAudio(callId, toBase64(encoded)))
    const base64 = toBase64(encoded);
    const sent = this.twilioService.sendAudio(callId, base64);

    if (sent) {
      // Mark first audio chunk reaching Twilio for this turn → completes the
      // latency breakdown table.
      latencyRegistry.mark(sessionId, 'firstTwilioAudio');
      latencyRegistry.report(sessionId, callId);

      eventBus.emit(AppEvent.AUDIO_SENT, {
        sessionId,
        callId,
        timestamp: nowMs(),
        bytesSent: encoded.length,
        destination: 'twilio',
      });

      this.sessionManager.recordAudioStats(sessionId, {
        framesSent: 1,
        bytesSent: encoded.length,
      });
    }
  }

  // ─── Interruption ──────────────────────────────────────────────────────────

  /**
   * Immediately interrupt agent playback:
   *   1. Send Twilio "clear" event — flushes Twilio's outbound audio queue so
   *      the caller hears silence instead of the remainder of the agent's speech.
   *   2. Mark the active Nova content block as cancelled in NovaSessionManager so
   *      any buffered audio chunks from the interrupted response are discarded.
   *   3. Emit INTERRUPTION_DETECTED for observability.
   *
   * Safe to call multiple times — Twilio clearAudio is idempotent and
   * NovaSessionManager guards against double-cancellation.
   */
  handleInterruption(callId: string, sessionId: string): void {
    this.log.info('⚡ Stopping agent playback — flushing Twilio outbound buffer', { sessionId, callId });

    // this.knowlarityService.clearAudio(callId); // ← commented out
    this.twilioService.clearAudio(callId);
    this.novaSessionManager.handleInterruption(sessionId);

    eventBus.emit(AppEvent.INTERRUPTION_DETECTED, {
      sessionId,
      callId,
      timestamp: nowMs(),
      confidence: 1.0,
    });
  }

  /**
   * Clean up per-session maps when a call ends. Called from MediaSessionCoordinator
   * teardown so Maps don't grow unbounded across many calls.
   */
  cleanupSession(sessionId: string): void {
    this.lastSeqNums.delete(sessionId);
    this.lastBargeInAt.delete(sessionId);
  }
}
