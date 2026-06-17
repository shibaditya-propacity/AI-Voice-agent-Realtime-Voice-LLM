/**
 * Lightweight humanization — adds subtle conversational openers to ~7% of responses.
 */

const OPENERS = ['Hmm... ', 'Right... ', 'Okay... '] as const;
const OPENER_PROBABILITY = 0.07;

export function humanizeResponse(text: string): string {
  if (!text || text.length < 10) return text;
  if (Math.random() > OPENER_PROBABILITY) return text;
  const opener = OPENERS[Math.floor(Math.random() * OPENERS.length)];
  return opener + text;
}

export function maybeGetOpener(): string {
  if (Math.random() > OPENER_PROBABILITY) return '';
  return OPENERS[Math.floor(Math.random() * OPENERS.length)];
}
