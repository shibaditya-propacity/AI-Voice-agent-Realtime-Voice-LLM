import { Logger } from '../shared/logger';

export type LatencyEvent =
  | 'call_start'
  | 'speech_started'
  | 'first_interim'
  | 'tts_prewarm_start'
  | 'tts_open'
  | 'stable_interim'
  | 'speech_final'
  | 'llm_start'
  | 'llm_first_token'
  | 'llm_complete'
  | 'tts_first_text'
  | 'tts_first_audio'
  | 'twilio_playback_start'
  | 'tts_complete'
  | 'greeting_start'
  | 'barge_in'
  | 'llm_cancelled'
  | 'tts_cancelled'
  | 'call_end';

/** Human-readable event names logged on every mark (one line per event). */
const EVENT_LABELS: Partial<Record<LatencyEvent, string>> = {
  speech_started:        'SpeechStarted',
  first_interim:         'FirstInterim',
  stable_interim:        'StableInterim',
  speech_final:          'FinalTranscript',
  llm_start:             'LLMStart',
  llm_first_token:       'FirstToken',
  tts_first_text:        'TTSStart',
  tts_first_audio:       'FirstAudio',
  twilio_playback_start: 'PlaybackStart',
  barge_in:              'BargeInDetected',
  llm_cancelled:         'LLMCancelled',
  tts_cancelled:         'TTSCancelled',
};

const TURN_RESET_EVENTS: LatencyEvent[] = [
  'speech_started', 'first_interim', 'tts_prewarm_start', 'tts_open',
  'stable_interim', 'speech_final', 'llm_start', 'llm_first_token', 'llm_complete',
  'tts_first_text', 'tts_first_audio', 'twilio_playback_start', 'tts_complete',
];

export class LatencyTracker {
  private readonly marks = new Map<LatencyEvent, number>();
  private readonly bargeInEvents: number[] = [];
  private readonly log: Logger;
  private readonly callSid: string;

  // ─── Speculation Tracking ─────────────────────────────────────────────
  private speculationAttempts = 0;
  private speculationConfirmedExact = 0;
  private speculationConfirmedPrefix = 0;
  private speculationInvalidated = 0;

  constructor(callSid: string) {
    this.callSid = callSid;
    this.log = Logger.forCall(callSid, 'Latency');
  }

  /** Record a speculation outcome for call-level summary. */
  recordSpeculation(result: 'confirmed_exact' | 'confirmed_prefix' | 'invalidated'): void {
    this.speculationAttempts++;
    if (result === 'confirmed_exact') this.speculationConfirmedExact++;
    else if (result === 'confirmed_prefix') this.speculationConfirmedPrefix++;
    else this.speculationInvalidated++;
  }

  mark(event: LatencyEvent, at = Date.now()): void {
    const label = EVENT_LABELS[event];
    if (label) this.log.info(label, { at });

    if (event === 'barge_in') {
      this.bargeInEvents.push(at);
      return;
    }
    this.marks.set(event, at);
  }

  hasMarked(event: LatencyEvent): boolean {
    return this.marks.has(event);
  }

  ms(from: LatencyEvent, to: LatencyEvent): number | null {
    const a = this.marks.get(from);
    const b = this.marks.get(to);
    if (a === undefined || b === undefined) return null;
    return b - a;
  }

  logTurnSummary(turnIndex: number): void {
    // ── STT Phase ──────────────────────────────────────────────────────────
    const vadToFirstInterim  = this.ms('speech_started', 'first_interim');
    const speechStartToFinal = this.ms('speech_started', 'speech_final');
    const prewarmToOpen      = this.ms('tts_prewarm_start', 'tts_open');

    // ── Speculative Phase ──────────────────────────────────────────────────
    const interimToStable    = this.ms('first_interim', 'stable_interim');
    const stableToLlm        = this.ms('stable_interim', 'llm_start');
    const stableToFinal      = this.ms('stable_interim', 'speech_final');

    // ── LLM Phase ──────────────────────────────────────────────────────────
    const speechToLlm        = this.ms('speech_final', 'llm_start');
    const llmFirstToken      = this.ms('llm_start', 'llm_first_token');
    const llmTotal           = this.ms('llm_start', 'llm_complete');
    const llmFirstToText     = this.ms('llm_first_token', 'tts_first_text');

    // ── TTS Phase ──────────────────────────────────────────────────────────
    const textToAudio        = this.ms('tts_first_text', 'tts_first_audio');
    const firstTokenToAudio  = this.ms('llm_first_token', 'tts_first_audio');
    const firstAudioToTwilio = this.ms('tts_first_audio', 'twilio_playback_start');
    const ttsTotal           = this.ms('tts_first_audio', 'tts_complete');

    // ── E2E Metrics ────────────────────────────────────────────────────────
    const e2eFromFinal       = this.ms('speech_final', 'twilio_playback_start');
    const e2eFromStable      = this.ms('stable_interim', 'twilio_playback_start');

    // Perceived latency: for speculative turns, it's stable_interim → twilio.
    // If speculation ran, that's the real user-perceived delay.
    // If negative, audio was already playing when final arrived (best case).
    const perceivedMs = e2eFromStable ?? e2eFromFinal;

    // Was TTS ready before or after speech_final?
    const openAt     = this.marks.get('tts_open');
    const finalAt    = this.marks.get('speech_final');
    const ttsWasPrewarmed = openAt !== undefined && finalAt !== undefined && openAt <= finalAt;

    this.log.info('TURN LATENCY', {
      turn:                           turnIndex,
      // ── STT ───────────────────────────────────────────────────────────
      vad_to_first_interim_ms:        vadToFirstInterim,
      speech_start_to_final_ms:       speechStartToFinal,
      tts_prewarm_to_open_ms:         prewarmToOpen,
      tts_was_prewarmed:              ttsWasPrewarmed,
      // ── Speculation ───────────────────────────────────────────────────
      first_interim_to_stable_ms:     interimToStable,
      stable_interim_to_llm_start_ms: stableToLlm,
      stable_interim_to_final_ms:     stableToFinal,
      // ── LLM ───────────────────────────────────────────────────────────
      speech_final_to_llm_start_ms:   speechToLlm,
      llm_ttft_ms:                    llmFirstToken,
      llm_total_ms:                   llmTotal,
      // ── TTS ───────────────────────────────────────────────────────────
      llm_token_to_tts_text_ms:       llmFirstToText,
      tts_text_to_first_audio_ms:     textToAudio,
      tts_first_token_to_audio_ms:    firstTokenToAudio,
      first_audio_to_twilio_ms:       firstAudioToTwilio,
      tts_total_ms:                   ttsTotal,
      // ── E2E ───────────────────────────────────────────────────────────
      e2e_from_final_ms:              e2eFromFinal,
      e2e_from_stable_interim_ms:     e2eFromStable,
      '★ perceived_latency_ms':       perceivedMs,
    });

    // Concise one-line pipeline for quick log scanning
    const specLabel = stableToFinal !== null
      ? ` [spec: stable→final=${stableToFinal}ms, LLM head-start=${stableToLlm ?? '?'}ms]`
      : '';
    this.log.info('PIPELINE BREAKDOWN', {
      turn: turnIndex,
      pipeline: `VAD→Interim:${vadToFirstInterim ?? '?'}ms → Final:${speechStartToFinal ?? '?'}ms → LLM:${llmFirstToken ?? '?'}ms → TTS:${textToAudio ?? '?'}ms → Twilio:${firstAudioToTwilio ?? '?'}ms = Perceived:${perceivedMs ?? '?'}ms${specLabel}`,
    });

    for (const event of TURN_RESET_EVENTS) this.marks.delete(event);
  }

  logCallSummary(): void {
    const hitRate = this.speculationAttempts > 0
      ? Math.round(((this.speculationConfirmedExact + this.speculationConfirmedPrefix) / this.speculationAttempts) * 100)
      : 0;
    this.log.info('CALL SUMMARY', {
      callSid: this.callSid,
      duration_ms: this.ms('call_start', 'call_end'),
      barge_in_count: this.bargeInEvents.length,
      speculation_attempts: this.speculationAttempts,
      speculation_confirmed_exact: this.speculationConfirmedExact,
      speculation_confirmed_prefix: this.speculationConfirmedPrefix,
      speculation_invalidated: this.speculationInvalidated,
      speculation_hit_rate_pct: hitRate,
    });
  }
}
