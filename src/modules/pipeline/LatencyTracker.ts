/**
 * LatencyTracker: per-call latency measurement.
 */

import { Logger } from '../../shared/Logger';

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

  private speculationAttempts = 0;
  private speculationConfirmedExact = 0;
  private speculationConfirmedPrefix = 0;
  private speculationInvalidated = 0;

  constructor(callSid: string) {
    this.log = Logger.forCall(callSid, 'Latency');
  }

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

  logTurnSummary(turn: number): void {
    const speechStart = this.marks.get('speech_started');
    const speechFinal = this.marks.get('speech_final');
    const llmStart = this.marks.get('llm_start');
    const llmFirst = this.marks.get('llm_first_token');
    const ttsFirst = this.marks.get('tts_first_audio');

    this.log.info('TurnSummary', {
      turn,
      stt_ms: speechStart && speechFinal ? speechFinal - speechStart : null,
      llm_ttft_ms: llmStart && llmFirst ? llmFirst - llmStart : null,
      e2e_ms: speechStart && ttsFirst ? ttsFirst - speechStart : null,
    });

    // Reset per-turn marks
    for (const e of TURN_RESET_EVENTS) {
      this.marks.delete(e);
    }
  }

  logCallSummary(): void {
    const callStart = this.marks.get('call_start');
    const callEnd = this.marks.get('call_end') ?? Date.now();

    this.log.info('CallSummary', {
      duration_ms: callStart ? callEnd - callStart : null,
      bargeIns: this.bargeInEvents.length,
      speculation: {
        attempts: this.speculationAttempts,
        confirmedExact: this.speculationConfirmedExact,
        confirmedPrefix: this.speculationConfirmedPrefix,
        invalidated: this.speculationInvalidated,
      },
    });
  }
}
