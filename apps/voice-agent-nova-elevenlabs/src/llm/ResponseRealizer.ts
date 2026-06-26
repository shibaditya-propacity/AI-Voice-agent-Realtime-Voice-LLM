/**
 * ResponseRealizer: LLM-based language realization for factual responses.
 *
 * Architecture:
 *   Application layer  → decides WHAT (intent, facts, constraints)
 *   ResponseRealizer   → decides HOW (natural phrasing via LLM)
 *
 * Input:  ResponseContext  (structured facts + metadata from KnowledgeRouter)
 * Output: AsyncGenerator<string>  (token stream, ready for TTS)
 *
 * Prompt is minimal and structured — no conversation history, no system-prompt
 * overhead. Token budget: 50-70 tokens. Groq TTFT: ~50-150ms.
 *
 * Caller-side guarantees preserved:
 *  - All facts in ResponseContext.facts appear in the output
 *  - Output language matches caller's detected language
 *  - Transition / follow-up / scheduling re-prompt are honoured
 *  - Site visit is never mentioned unless schedulingReprompt contains it
 *  - Output is validated by SessionState.validateOutput() before history commit
 */

import { streamOnce } from './BedrockLLM';
import type { ResponseContext } from './KnowledgeRouter';
import { Logger } from '../shared/logger';

// ─── Realization System Prompt ───────────────────────────────────────────────
// Keep this short — the per-turn user prompt carries all the specifics.

const REALIZER_SYSTEM =
  'You are Nova, a real estate sales consultant on a live phone call for ' +
  'Akshay Vista, Pune. You speak naturally in Hinglish (Hindi-English mix). ' +
  'Your ONLY job right now is to phrase the provided facts naturally — ' +
  'never invent, add, or change any fact.';

// ─── Prompt Builder ──────────────────────────────────────────────────────────

function buildRealizationPrompt(ctx: ResponseContext): string {
  // Always Hinglish — even Hindi-dominant callers use English for real estate terms
  // (gym, pool, clubhouse, EV charging). Requesting "Devanagari preferred" causes
  // the LLM to transliterate English words like "गym" which TTS mangles.
  const langLabel =
    ctx.language === 'en' ? 'English' :
    'Hinglish — Hindi words in Devanagari, English property terms in English script (e.g. "Gym", "Swimming Pool", "EV charging")';

  const lines: string[] = [
    `Task: Express the following property facts naturally in ${ctx.maxSentences} sentence(s), ` +
      `max ${ctx.maxWords} words.`,
    '',
    'Facts to express (include ALL):',
    ...ctx.facts.map(f => `- ${f}`),
  ];

  if (ctx.transition) {
    lines.push('', `After the facts, close naturally with: "${ctx.transition}"`);
  }

  if (ctx.followUp) {
    lines.push('', `End with this question: "${ctx.followUp}"`);
  }

  if (ctx.schedulingReprompt) {
    lines.push('', `After answering, also add: "${ctx.schedulingReprompt}"`);
  }

  lines.push(
    '',
    `Language: ${langLabel}`,
    '',
    'Strict rules:',
    `- Max ${ctx.maxSentences} sentence(s) and ${ctx.maxWords} words total`,
    '- Express ONLY the listed facts — never add or invent anything',
    '- Sound helpful and consultative, not salesy',
    '- Do NOT mention a site visit unless it appears in the instructions above',
    '- Do NOT ask questions beyond what is instructed above',
    '- Output the spoken response only — no labels, no quotes, no preamble',
  );

  return lines.join('\n');
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Streams a naturally phrased response from the given ResponseContext.
 *
 * Uses the LLM (via streamOnce) only for language realization.
 * All facts, constraints, language, and closing phrases are pre-supplied.
 *
 * @param ctx      Structured facts + constraints from KnowledgeRouter
 * @param callSid  For per-call logging
 * @param abort    AbortSignal — stops streaming on barge-in
 * @yields         Text chunks ready for TTS streaming
 */
export async function* realizeResponse(
  ctx: ResponseContext,
  callSid: string,
  abort?: AbortSignal,
): AsyncGenerator<string> {
  const log = Logger.forCall(callSid, 'Realizer');
  const prompt = buildRealizationPrompt(ctx);

  // Generous token budget: words → tokens conversion with 60% buffer.
  // At 35 words max → ~56 tokens budget. Groq handles this in one fast hop.
  const tokenBudget = Math.ceil(ctx.maxWords * 1.6) + 15;

  log.debug('Realizing response', {
    intent:   ctx.intent,
    language: ctx.language,
    facts:    ctx.facts.length,
    budget:   tokenBudget,
  });

  for await (const event of streamOnce(
    REALIZER_SYSTEM,
    prompt,
    tokenBudget,
    callSid,
    abort,
  )) {
    if (event.type === 'text') yield event.text;
  }
}
