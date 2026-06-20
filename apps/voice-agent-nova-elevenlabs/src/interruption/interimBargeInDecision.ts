/**
 * Pure decision logic for interim-transcript barge-in during agent speech.
 *
 * Extracted from CallOrchestrator so the false-barge-in gating — the part that
 * must NEVER cancel a valid response because Deepgram echoed or slightly
 * reworded the same interim — is unit-testable in isolation. The orchestrator
 * owns all state, timers, logging and side-effects; this function only decides.
 *
 * Outcomes:
 *   - 'accept' : high-confidence new caller speech → interrupt the agent.
 *   - 'reject' : genuine false positive (echo / filler / noise / low quality).
 *                Counted in the FALSE_BARGEIN_REJECTED metric.
 *   - 'defer'  : plausibly real speech, not yet confirmed (anchor just set, or
 *                not sustained long enough). NOT a false positive.
 */

export type BargeInDecisionKind = 'accept' | 'reject' | 'defer';

export interface InterimBargeInConfig {
  /** Min total words in the interim to be eligible. */
  minWords: number;
  /** Min genuinely-new words vs. the previous interim (transcript growth). */
  minNewWords: number;
  /** Min Deepgram confidence (0 disables the gate; echo decodes low). */
  minConfidence: number;
  /** Echo-burst window after TTS audio start during which barge-in is blocked. */
  minTtsPlayMs: number;
  /** Sustained age the anchor must reach before a barge-in fires. */
  minInterimAgeMs: number;
  /** Filler/echo-only words ("mhmm", "haan", "okay") that never barge in. */
  echoFillerPattern: RegExp;
}

export interface InterimBargeInInput {
  /** Current interim text (already trimmed). */
  trimmed: string;
  /** Previous interim text this SPEAKING phase ('' if none). */
  previousText: string;
  /** Deepgram confidence for this interim (0 if unknown). */
  confidence: number;
  /** ms since first TTS audio chunk for this turn, or null if none yet. */
  msSinceTTSStart: number | null;
  /** Age of the barge-in anchor, or null if no anchor is set yet. */
  interimAnchorAge: number | null;
  config: InterimBargeInConfig;
}

export interface TranscriptDelta {
  newWords: string[];
  newWordCount: number;
  wordCount: number;
}

export interface BargeInDecision {
  decision: BargeInDecisionKind;
  reason: string;
  delta: TranscriptDelta;
}

export function computeTranscriptDelta(trimmed: string, previousText: string): TranscriptDelta {
  const previousWords = previousText ? previousText.split(/\s+/) : [];
  const currentWords = trimmed ? trimmed.split(/\s+/) : [];
  const previousWordSet = new Set(previousWords.map((w) => w.toLowerCase()));
  const newWords = currentWords.filter((w) => !previousWordSet.has(w.toLowerCase()));
  return { newWords, newWordCount: newWords.length, wordCount: currentWords.length };
}

export function evaluateInterimBargeIn(input: InterimBargeInInput): BargeInDecision {
  const { trimmed, previousText, confidence, msSinceTTSStart, interimAnchorAge, config } = input;
  const delta = computeTranscriptDelta(trimmed, previousText);

  const make = (decision: BargeInDecisionKind, reason: string): BargeInDecision => ({ decision, reason, delta });

  // 1. Duplicate echo — Deepgram repeats the same interim as PSTN echo.
  if (trimmed === previousText) return make('reject', 'duplicate_interim_echo');

  // 2. Filler/echo-only words.
  if (config.echoFillerPattern.test(trimmed)) return make('reject', 'echo_filler');

  // 3. Too few words total.
  if (delta.wordCount < config.minWords) return make('reject', 'too_few_words');

  // 4. Low confidence — likely echo of our own TTS. (0 disables the gate.)
  if (confidence > 0 && confidence < config.minConfidence) return make('reject', 'low_confidence');

  // 5. Too early after TTS start (echo-burst window).
  if (msSinceTTSStart !== null && msSinceTTSStart < config.minTtsPlayMs) {
    return make('reject', 'too_early_after_tts');
  }

  // 6. Insufficient NEW words — a reworded echo, not new speech.
  if (delta.newWordCount < config.minNewWords) return make('reject', 'insufficient_new_words');

  // 7. First meaningful interim — set the anchor and wait for sustained speech.
  if (interimAnchorAge === null) return make('defer', 'anchor_set_awaiting_sustained_speech');

  // 8. Not sustained long enough yet.
  if (interimAnchorAge < config.minInterimAgeMs) return make('defer', 'interim_too_young');

  // 9. Sustained, growing, confident new speech.
  return make('accept', 'sustained_new_speech');
}
