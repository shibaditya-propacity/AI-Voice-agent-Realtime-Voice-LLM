/**
 * Lightweight humanization layer — adds subtle conversational openers
 * to ~7% of responses. Synchronous, <1ms, zero network calls.
 *
 * Feature flag: ENABLE_HUMANIZATION (default: true)
 */

const OPENERS = ['Hmm... ', 'Right... ', 'Okay... '] as const;

/** Probability of adding an opener (0.0 - 1.0). ~7% of responses. */
const OPENER_PROBABILITY = 0.07;


export function humanizeResponse(text: string): string {
  if (!text || text.length < 10) return text;
  if (Math.random() > OPENER_PROBABILITY) return text;

  const opener = OPENERS[Math.floor(Math.random() * OPENERS.length)];
  return opener + text;
}

/**
 * Roll the dice for humanization and return an opener prefix (or empty string).
 * Use this when text is streamed token-by-token and you need to prepend
 * before the first token arrives.
 */
export function maybeGetOpener(): string {
  if (Math.random() > OPENER_PROBABILITY) return '';
  return OPENERS[Math.floor(Math.random() * OPENERS.length)];
}
