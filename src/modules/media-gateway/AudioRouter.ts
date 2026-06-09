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
import { callTrace } from '../../shared/CallTraceLogger';
import { eventBus } from '../../shared/EventBus';
import { Logger } from '../../shared/Logger';
import { fromBase64, toBase64, nowMs, pcmFrameBytes, chunkBuffer } from '../../utils/helpers';
import { latencyRegistry, detectSpeechEnd } from '../../shared/LatencyRegistry';
import { AudioProcessor } from '../audio/AudioProcessor';
import { KrispService } from '../krisp/KrispService';
import { NovaSessionManager } from '../nova/NovaSessionManager';
// import { KnowlarityService } from '../knowlarity/KnowlarityService'; // ← commented out: replaced by Twilio
import { TelephonyProvider } from '../telephony/TelephonyProvider';
import { SessionManager } from '../session/SessionManager';

export class AudioRouter {
  private readonly audioProcessor: AudioProcessor;
  private readonly krispService: KrispService;
  private readonly novaSessionManager: NovaSessionManager;
  // private readonly knowlarityService: KnowlarityService; // ← commented out
  private readonly twilioService: TelephonyProvider;
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
   * while the agent is speaking — one trigger per cooldown window is enough.
   */
  private readonly lastBargeInAt = new Map<string, number>();

  /**
   * Per-session: monotonically increasing counter bumped on every interruption.
   * routeOutbound() captures the generation at entry; if it changes during the
   * async processOutbound(), the chunk is discarded instead of being sent to
   * Twilio. This closes the race condition where audio chunks that were already
   * dispatched to routeOutbound (past NovaSessionManager's guard) complete their
   * async encoding and arrive at Twilio AFTER the clearAudio call.
   */
  private readonly outboundGeneration = new Map<string, number>();

  /** Minimum RMS energy (PCM16) that counts as "caller is speaking". */
  private static readonly BARGE_IN_RMS_THRESHOLD = Env.audio.vadRmsThreshold;

  /** Minimum ms between consecutive proactive barge-in triggers for the same session. */
  private static readonly BARGE_IN_COOLDOWN_MS = 300;

  /**
   * Sustained-speech duration (ms) required to CONFIRM a proactive barge-in. The
   * caller must stay above the RMS threshold this long (brief inter-word dips up to
   * BARGE_IN_GAP_MS are tolerated) before playback is interrupted. Noise, echo,
   * breathing and handset artifacts do not sustain this long, so they no longer
   * interrupt the agent. A word-bearing Nova transcript also confirms instantly
   * (NovaSessionManager.onTextOutput), so genuine speech still interrupts fast.
   */
  private static readonly BARGE_IN_CONFIRM_MS = Env.audio.bargeInConfirmMs;

  /**
   * Max gap (ms) of sub-threshold audio tolerated inside a pending speech run
   * before it is treated as ended. A burst that stops for longer than this without
   * reaching the confirm window is discarded — short bursts (< confirm window)
   * never interrupt.
   */
  private static readonly BARGE_IN_GAP_MS = Env.audio.vadSilenceHangoverMs;

  /**
   * Per-session PENDING interruption. When the caller's post-Krisp RMS first
   * crosses the threshold while the agent is speaking, we start a pending run
   * instead of interrupting immediately. `startMs` = when the run began;
   * `lastSpeechMs` = most recent above-threshold frame. Confirmed once
   * (lastSpeechMs - startMs) >= BARGE_IN_CONFIRM_MS.
   */
  private readonly bargeInPending = new Map<string, { startMs: number; lastSpeechMs: number }>();

  /**
   * Whether the proactive client-side RMS barge-in is enabled. Runs on post-Krisp
   * (noise-suppressed) audio to avoid false positives from agent echo. Complements
   * Nova's native barge-in (completionStart-while-AI_SPEAKING in NovaSessionManager)
   * with faster client-side interruption. See Env.audio.proactiveBargeIn.
   */
  private static readonly PROACTIVE_BARGE_IN_ENABLED = Env.audio.proactiveBargeIn;

  constructor(
    audioProcessor: AudioProcessor,
    krispService: KrispService,
    novaSessionManager: NovaSessionManager,
    // knowlarityService: KnowlarityService, // ← commented out
    twilioService: TelephonyProvider,
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

    // Energy VAD (measurement only): timestamp when the caller stops speaking so we
    // can measure Nova's endpointing latency. Does not alter the audio path.
    const speechEndAt = detectSpeechEnd(sessionId, pcm16);
    if (speechEndAt !== null) {
      latencyRegistry.setSpeechEnd(sessionId, speechEndAt);
      const convState = this.novaSessionManager.getConversationState(sessionId);
      callTrace.event(callId, sessionId, 'vad.speech.end', { state: convState, seqNum });
      // Recovery: if we are stuck INTERRUPTED but the speech that triggered it
      // produced no real transcript (noise / echo / breathing), exit immediately
      // instead of waiting for the watchdog — never remain stuck waiting for a
      // transcript that will never arrive.
      if (convState === 'INTERRUPTED') {
        this.bargeInPending.delete(sessionId);
        this.novaSessionManager.handleVadEndDuringInterruption(sessionId);
      }
    }

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

    // ── Proactive barge-in detection (post-Krisp) ───────────────────────────
    // Fast client-side interruption: if the agent is speaking and the caller's
    // RMS energy (measured on noise-suppressed audio) exceeds the threshold,
    // interrupt immediately rather than waiting for Nova's endpointing. Running
    // on cleanPcm16 (post-Krisp) eliminates false positives from telephony echo
    // of the agent's own voice while preserving real caller speech.
    if (AudioRouter.PROACTIVE_BARGE_IN_ENABLED && this.novaSessionManager.isAgentSpeaking(sessionId)) {
      // Never interrupt the opening greeting — early telephony line noise / echo
      // of the agent's own audio can exceed the RMS threshold before the caller
      // has actually spoken, killing the greeting mid-playback. Barge-in is only
      // enabled once the greeting turn completes (turnCount >= 1).
      if (this.novaSessionManager.isGreetingPhase(sessionId)) {
        // Silently skip — greeting must play to completion.
      } else {
        const rms = AudioRouter.computeRms(cleanPcm16);
        const now = Date.now();
        const pending = this.bargeInPending.get(sessionId);
        if (rms >= AudioRouter.BARGE_IN_RMS_THRESHOLD) {
          if (!pending) {
            // Speech-start: enter PENDING — do NOT interrupt yet.
            this.bargeInPending.set(sessionId, { startMs: now, lastSpeechMs: now });
          } else {
            pending.lastSpeechMs = now;
            const speechMs = now - pending.startMs;
            // Confirm only after sustained speech ≥ the confirm window.
            if (speechMs >= AudioRouter.BARGE_IN_CONFIRM_MS) {
              const lastBarge = this.lastBargeInAt.get(sessionId) ?? 0;
              if (now - lastBarge >= AudioRouter.BARGE_IN_COOLDOWN_MS) {
                this.lastBargeInAt.set(sessionId, now);
                this.bargeInPending.delete(sessionId);
                callTrace.event(callId, sessionId, 'bargein.user-speech-start', {
                  rms: Math.round(rms),
                  threshold: AudioRouter.BARGE_IN_RMS_THRESHOLD,
                  reason: 'sustained-speech',
                  speechMs,
                  seqNum,
                });
                this.log.warn('⚡ BARGE-IN DETECTED — sustained caller speech during AI playback — stopping output', {
                  sessionId,
                  callId,
                  rms: Math.round(rms),
                  speechMs,
                  seqNum,
                });
                this.handleInterruption(callId, sessionId);
              }
            }
          }
        } else if (pending && now - pending.lastSpeechMs > AudioRouter.BARGE_IN_GAP_MS) {
          // Pending speech run ended before reaching the confirm window → short
          // burst / noise spike. Discard it; the agent is never interrupted.
          const burstMs = pending.lastSpeechMs - pending.startMs;
          this.bargeInPending.delete(sessionId);
          callTrace.event(callId, sessionId, 'bargein.pending.cleared', {
            reason: 'short-burst',
            burstMs,
            seqNum,
          });
        }
      }
    } else if (this.bargeInPending.has(sessionId)) {
      // Agent is no longer speaking — drop any pending run.
      this.bargeInPending.delete(sessionId);
    }

    eventBus.emit(AppEvent.AUDIO_PROCESSED, {
      sessionId,
      callId,
      timestamp: nowMs(),
      chunk: cleanPcm16,
      sampleRate: Env.audio.internalSampleRate,
      source: 'krisp',
    });

    // Step 3: Stream to Nova Sonic
    latencyRegistry.markStartup(sessionId, 'firstCallerAudio');
    callTrace.eventOnce(callId, sessionId, 'caller.audio.first', {
      seqNum,
      pcmBytes: cleanPcm16.length,
    });
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

  // ─── Instant greeting ──────────────────────────────────────────────────────

  /**
   * Stream a pre-rendered greeting (PCM16 @ Nova output rate, cached at boot) to the
   * caller as fast as possible. Used for the instant opening greeting so Nova stays
   * off the critical path — the caller hears audio within ~1s of the stream opening
   * instead of after a 5–7s cold Nova bootstrap.
   *
   * The whole clip is downsampled + codec-encoded once, then framed into ~20ms
   * telephony frames so the first frame plays immediately and the caller can barge
   * in. Deliberately bypasses the per-turn latencyRegistry — this is not a model turn.
   */
  async playGreeting(callId: string, sessionId: string, pcm16: Buffer): Promise<void> {
    this.log.info('[GREETING] step4 — playGreeting() entered', { sessionId, callId, pcm16Bytes: pcm16.length });
    callTrace.event(callId, sessionId, 'greeting.play.start', { pcm16Bytes: pcm16.length });
    if (pcm16.length === 0) {
      this.log.warn('[GREETING] step4 — empty greeting buffer, nothing to play', { sessionId, callId });
      return;
    }

    const codec = Env.audio.telephonyCodec;

    let encoded: Buffer;
    try {
      // processOutbound downsamples from Nova's output rate to 8kHz and encodes to
      // the telephony codec — exactly the same path Nova's live audio takes.
      encoded = await this.audioProcessor.processOutbound(pcm16, codec);
    } catch (err) {
      this.log.error('[GREETING] step4 — greeting conversion FAILED — caller gets the live Nova greeting instead', err as Error, {
        sessionId, callId,
      });
      return;
    }

    // 20ms frames at the telephony rate: pcmu/pcma = 1 byte/sample, pcm16 = 2.
    const frameBytes =
      codec === 'pcm16'
        ? pcmFrameBytes(20, Env.audio.telephonySampleRate, 16, 1)
        : pcmFrameBytes(20, Env.audio.telephonySampleRate, 8, 1);

    let framesSent = 0;
    let framesFailed = 0;
    for (const frame of chunkBuffer(encoded, frameBytes)) {
      // sendAudio returns false if the Twilio WS isn't OPEN / no stream registered —
      // i.e. step 6 (Twilio receives the frame) did NOT happen for that frame.
      if (this.twilioService.sendAudio(callId, toBase64(frame))) {
        if (framesSent === 0) latencyRegistry.markStartup(sessionId, 'greetingFirstFrame');
        framesSent++;
      } else framesFailed++;
    }
    latencyRegistry.markStartup(sessionId, 'greetingLastFrame');
    // First audible audio reached the caller — emit the startup latency breakdown.
    latencyRegistry.reportStartup(sessionId, callId);

    callTrace.event(callId, sessionId, 'greeting.play.end', {
      framesSent,
      framesFailed,
      encodedBytes: encoded.length,
    });

    if (framesSent > 0 && framesFailed === 0) {
      this.log.info('[GREETING] step5/6 — ✅ all greeting frames accepted by Twilio WS', {
        sessionId, callId, framesSent, encodedBytes: encoded.length, codec,
      });
    } else {
      this.log.error(
        '[GREETING] step5/6 — greeting frames NOT delivered to Twilio (WS not OPEN or stream not registered). Caller heard nothing.',
        new Error('twilio sendAudio returned false'),
        { sessionId, callId, framesSent, framesFailed },
      );
    }
  }

  // ─── Outbound: Nova Sonic → Caller ────────────────────────────────────────

  async routeOutbound(callId: string, sessionId: string, pcm16: Buffer): Promise<void> {
    if (pcm16.length === 0) return;

    // Capture the outbound generation BEFORE the async encoding step. If an
    // interruption bumps the generation while processOutbound() is running, the
    // post-check below will discard the chunk — closing the race where stale
    // audio arrives at Twilio after the clearAudio call.
    const genAtEntry = this.outboundGeneration.get(sessionId) ?? 0;

    const targetCodec = Env.audio.telephonyCodec;

    // Step 1: Downsample + encode to telephony codec
    let encoded: Buffer;
    try {
      encoded = await this.audioProcessor.processOutbound(pcm16, targetCodec);
    } catch (err) {
      this.log.error('Outbound audio conversion failed', err as Error, { sessionId, callId });
      return;
    }

    // ── Post-async generation check ─────────────────────────────────────────
    // An interruption may have occurred while processOutbound() was running.
    // If so, outboundGeneration was bumped and clearAudio was already sent —
    // sending this chunk now would re-fill Twilio's buffer with stale audio.
    const genNow = this.outboundGeneration.get(sessionId) ?? 0;
    if (genNow !== genAtEntry) {
      this.log.debug('🚫 Outbound chunk discarded — interruption during encoding', {
        sessionId,
        callId,
        genAtEntry,
        genNow,
        chunkBytes: encoded.length,
      });
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
      callTrace.eventOnce(callId, sessionId, 'agent.audio.routed', {
        encodedBytes: encoded.length,
      });
      latencyRegistry.report(sessionId, callId);

      // Startup timeline: first AGENT audio to the caller. In the fallback (no cached
      // greeting) path this is the greeting itself, so emit the startup breakdown here
      // too — reportStartup is idempotent, so it prints once regardless of path.
      latencyRegistry.markStartup(sessionId, 'firstAgentAudio');
      latencyRegistry.reportStartup(sessionId, callId);

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
    callTrace.event(callId, sessionId, 'interruption', {});
    this.log.info('⚡ Stopping agent playback — flushing Twilio outbound buffer', { sessionId, callId });

    // Bump outbound generation FIRST — any in-flight routeOutbound() calls that
    // resume after an await will see the new generation and discard their chunk
    // instead of re-filling Twilio's buffer after the clear.
    this.outboundGeneration.set(sessionId, (this.outboundGeneration.get(sessionId) ?? 0) + 1);

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
   * Reset the per-session barge-in cooldown. Called when a new Nova response
   * generation starts (completionStart fired), ensuring each new response cycle
   * gets fresh barge-in detection. Without this, the 2-second cooldown from the
   * previous barge-in would block detection on the next response if it starts
   * within 2 seconds — causing the "agent finishes speaking before processing
   * the user" symptom.
   */
  resetBargeInCooldown(sessionId: string): void {
    this.lastBargeInAt.delete(sessionId);
    this.bargeInPending.delete(sessionId);
  }

  /**
   * Clean up per-session maps when a call ends. Called from MediaSessionCoordinator
   * teardown so Maps don't grow unbounded across many calls.
   */
  cleanupSession(sessionId: string): void {
    this.lastSeqNums.delete(sessionId);
    this.lastBargeInAt.delete(sessionId);
    this.outboundGeneration.delete(sessionId);
    this.bargeInPending.delete(sessionId);
  }
}
