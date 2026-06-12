import { Logger } from '../shared/logger';

export type LatencyEvent =
  | 'call_start'
  | 'speech_started'
  | 'tts_prewarm_start'
  | 'tts_open'
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
  speech_started:        'SpeechEnd',
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
  'speech_started', 'tts_prewarm_start', 'tts_open',
  'speech_final', 'llm_start', 'llm_first_token', 'llm_complete',
  'tts_first_text', 'tts_first_audio', 'twilio_playback_start', 'tts_complete',
];

export class LatencyTracker {
  private readonly marks = new Map<LatencyEvent, number>();
  private readonly bargeInEvents: number[] = [];
  private readonly log: Logger;
  private readonly callSid: string;

  constructor(callSid: string) {
    this.callSid = callSid;
    this.log = Logger.forCall(callSid, 'Latency');
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
    const prewarmToOpen      = this.ms('tts_prewarm_start', 'tts_open');
    const speechStartToFinal = this.ms('speech_started', 'speech_final');
    const speechToLlm        = this.ms('speech_final', 'llm_start');
    const llmFirstToken      = this.ms('llm_start', 'llm_first_token');
    const llmTotal           = this.ms('llm_start', 'llm_complete');
    const llmFirstToText     = this.ms('llm_first_token', 'tts_first_text');
    const textToAudio        = this.ms('tts_first_text', 'tts_first_audio');
    const firstTokenToAudio  = this.ms('llm_first_token', 'tts_first_audio');
    const firstAudioToTwilio = this.ms('tts_first_audio', 'twilio_playback_start');
    const e2e                = this.ms('speech_final', 'tts_first_audio');
    const e2eTwilio          = this.ms('speech_final', 'twilio_playback_start');
    const ttsTotal           = this.ms('tts_first_audio', 'tts_complete');

    // Was TTS ready before or after speech_final?
    const openAt     = this.marks.get('tts_open');
    const finalAt    = this.marks.get('speech_final');
    const ttsWasPrewarmed = openAt !== undefined && finalAt !== undefined && openAt <= finalAt;
    const openLeadMs = (openAt !== undefined && finalAt !== undefined)
      ? finalAt - openAt   // positive = TTS opened X ms before transcript, negative = opened after
      : null;

    this.log.info('TURN LATENCY', {
      turn:                             turnIndex,
      // ── STT ──────────────────────────────────────────────────────────────────
      speech_start_to_final_ms:         speechStartToFinal,
      tts_prewarm_to_open_ms:           prewarmToOpen,
      tts_was_ready_before_transcript:  ttsWasPrewarmed,
      tts_open_lead_over_transcript_ms: openLeadMs,
      // ── LLM ──────────────────────────────────────────────────────────────────
      speech_final_to_llm_start_ms:     speechToLlm,
      llm_first_token_ms:               llmFirstToken,
      llm_first_token_to_tts_text_ms:   llmFirstToText,
      llm_total_ms:                     llmTotal,
      // ── TTS ──────────────────────────────────────────────────────────────────
      tts_text_to_first_audio_ms:       textToAudio,
      first_token_to_first_audio_ms:    firstTokenToAudio,
      first_audio_to_twilio_ms:         firstAudioToTwilio,
      tts_total_ms:                     ttsTotal,
      // ── E2E ──────────────────────────────────────────────────────────────────
      '★ e2e_speech_final_to_audio_ms':  e2e,
      '★ e2e_speech_final_to_twilio_ms': e2eTwilio,
    });

    // Log a concise one-line pipeline breakdown for quick scanning
    this.log.info('PIPELINE BREAKDOWN', {
      turn: turnIndex,
      pipeline: `SpeechStart→FinalTranscript:${speechStartToFinal ?? '?'}ms → LLMStart:${speechToLlm ?? '?'}ms → FirstToken:${llmFirstToken ?? '?'}ms → TTSStart:${llmFirstToText ?? '?'}ms → FirstAudio:${textToAudio ?? '?'}ms → Twilio:${firstAudioToTwilio ?? '?'}ms = E2E:${e2eTwilio ?? '?'}ms`,
    });

    for (const event of TURN_RESET_EVENTS) this.marks.delete(event);
  }

  logCallSummary(): void {
    this.log.info('CALL SUMMARY', {
      callSid: this.callSid,
      duration_ms: this.ms('call_start', 'call_end'),
      barge_in_count: this.bargeInEvents.length,
    });
  }
}
