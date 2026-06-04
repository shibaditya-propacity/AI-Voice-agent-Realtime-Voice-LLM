/**
 * LatencyRegistry: correlates per-turn timestamps across the pipeline modules
 * (AudioRouter ↔ NovaClient ↔ NovaSessionManager) and prints an end-to-end
 * response-latency breakdown table per turn.
 *
 * A "turn" = one agent response. Timeline of marks (in order they occur):
 *
 *   speechEnd          caller stopped speaking (energy VAD transition, inbound)
 *   completionStart    Nova decided to respond            (endpointing latency)
 *   firstUserText      Nova emitted the ASR transcript    (USER role)
 *   firstAssistantText Nova emitted the reply text        (ASSISTANT role)
 *   firstNovaAudio     Nova emitted first audio chunk     (model time-to-first-audio)
 *   firstTwilioAudio   first audio chunk sent to Twilio   (our outbound overhead)
 *
 * The dominant numbers are usually speechEnd→completionStart (Nova VAD/endpointing)
 * and completionStart→firstNovaAudio (Nova model TTFA + Bedrock RTT). Everything we
 * control (decode, krisp, resample, encode, send) sits between firstNovaAudio and
 * firstTwilioAudio and in the per-frame inbound path.
 */

import { Env } from '../config';
import { Logger } from './Logger';

const log = Logger.root('Latency');

export type TurnMark =
  | 'speechEnd'
  | 'completionStart'
  | 'firstUserText'
  | 'firstAssistantText'
  | 'firstNovaAudio'
  | 'firstTwilioAudio';

interface TurnTiming {
  speechEnd?: number;
  completionStart?: number;
  firstUserText?: number;
  firstAssistantText?: number;
  firstNovaAudio?: number;
  firstTwilioAudio?: number;
  reported?: boolean;
}

interface InboundStats {
  frames: number;
  decodeUs: number;
  krispUs: number;
  totalUs: number;
}

class LatencyRegistry {
  private turns = new Map<string, TurnTiming>();
  private inbound = new Map<string, InboundStats>();

  /** Record a turn mark. First write of each mark per turn wins (idempotent). */
  mark(sessionId: string, m: TurnMark, ts = Date.now()): void {
    const t = this.turns.get(sessionId) ?? {};
    if (t[m] === undefined) {
      t[m] = ts;
      this.turns.set(sessionId, t);
    }
  }

  /** Begin a new turn (called on completionStart). Preserves the most recent speechEnd. */
  startTurn(sessionId: string, ts = Date.now()): void {
    const prev = this.turns.get(sessionId);
    this.turns.set(sessionId, { speechEnd: prev?.speechEnd, completionStart: ts });
  }

  /** Update the latest speechEnd while listening (before completionStart). */
  setSpeechEnd(sessionId: string, ts = Date.now()): void {
    const t = this.turns.get(sessionId) ?? {};
    t.speechEnd = ts;
    this.turns.set(sessionId, t);
  }

  /** Accumulate per-frame inbound processing cost (microseconds). */
  recordInbound(sessionId: string, decodeUs: number, krispUs: number, totalUs: number): void {
    const s = this.inbound.get(sessionId) ?? { frames: 0, decodeUs: 0, krispUs: 0, totalUs: 0 };
    s.frames += 1;
    s.decodeUs += decodeUs;
    s.krispUs += krispUs;
    s.totalUs += totalUs;
    this.inbound.set(sessionId, s);
  }

  /**
   * Emit the breakdown table for the turn. Called once firstTwilioAudio is set.
   * Safe to call repeatedly — only reports once per turn.
   */
  report(sessionId: string, callId: string): void {
    const t = this.turns.get(sessionId);
    if (!t || t.reported || t.completionStart === undefined || t.firstTwilioAudio === undefined) return;
    t.reported = true;

    const cs = t.completionStart;
    const rows: Array<[string, number | undefined, number | undefined]> = [
      ['VAD/endpointing  (speechEnd→completionStart)', t.speechEnd, cs],
      ['ASR transcript   (completionStart→firstUserText)', cs, t.firstUserText],
      ['LLM first token  (completionStart→firstAssistantText)', cs, t.firstAssistantText],
      ['Nova first audio (completionStart→firstNovaAudio)', cs, t.firstNovaAudio],
      ['Outbound→Twilio  (firstNovaAudio→firstTwilioAudio)', t.firstNovaAudio, t.firstTwilioAudio],
    ];

    // Total response latency = caller-stop → first audio out (falls back to
    // completionStart→firstTwilioAudio when no speechEnd was captured).
    const totalFrom = t.speechEnd ?? cs;
    const totalMs = t.firstTwilioAudio - totalFrom;

    const inb = this.inbound.get(sessionId);
    const inbAvg = inb && inb.frames > 0
      ? {
          frames: inb.frames,
          avgDecodeUs: +(inb.decodeUs / inb.frames).toFixed(2),
          avgKrispUs: +(inb.krispUs / inb.frames).toFixed(2),
          avgTotalUs: +(inb.totalUs / inb.frames).toFixed(2),
        }
      : undefined;

    const table = rows.map(([label, from, to]) => {
      const ms = from !== undefined && to !== undefined ? to - from : null;
      const pct = ms !== null && totalMs > 0 ? `${((ms / totalMs) * 100).toFixed(1)}%` : '—';
      return { stage: label, ms: ms ?? '—', pct };
    });

    log.info(`⏱  RESPONSE LATENCY BREAKDOWN  (total ${totalMs} ms)`, {
      sessionId,
      callId,
      totalResponseMs: totalMs,
      target: '<1000ms',
      withinTarget: totalMs < 1000,
      stages: table,
      inboundPerFrame: inbAvg,
    });
  }

  clear(sessionId: string): void {
    this.turns.delete(sessionId);
    this.inbound.delete(sessionId);
  }
}

export const latencyRegistry = new LatencyRegistry();

// ─── Energy VAD (measurement only) ────────────────────────────────────────────
// Lightweight RMS speech/silence detector used solely to timestamp when the caller
// stops speaking, so we can measure Nova's endpointing latency. NOT in the audio
// path — it only reads frames.

interface VadState {
  inSpeech: boolean;
  silenceStartedAt: number;
}

const vadState = new Map<string, VadState>();

/** Returns the timestamp speech ended if this frame completed a speech→silence transition, else null. */
export function detectSpeechEnd(sessionId: string, pcm16: Buffer, now = Date.now()): number | null {
  const samples = pcm16.length >> 1;
  if (samples === 0) return null;

  let sumSq = 0;
  for (let i = 0; i < samples; i++) {
    const s = pcm16.readInt16LE(i * 2);
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / samples);

  const st = vadState.get(sessionId) ?? { inSpeech: false, silenceStartedAt: 0 };
  const isSpeech = rms >= Env.audio.vadRmsThreshold;

  let speechEndAt: number | null = null;
  if (isSpeech) {
    st.inSpeech = true;
    st.silenceStartedAt = 0;
  } else if (st.inSpeech) {
    if (st.silenceStartedAt === 0) {
      st.silenceStartedAt = now;
    } else if (now - st.silenceStartedAt >= Env.audio.vadSilenceHangoverMs) {
      st.inSpeech = false;
      speechEndAt = now;
    }
  }
  vadState.set(sessionId, st);
  return speechEndAt;
}

export function clearVad(sessionId: string): void {
  vadState.delete(sessionId);
}
