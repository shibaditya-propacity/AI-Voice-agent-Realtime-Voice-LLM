/**
 * ResponseEnrichment: injects contextual insight directives into the LLM prompt.
 *
 * When the user's message matches a known FactIntent, this module builds a
 * [RESPONSE INSIGHT] block that instructs the LLM to weave in an additional
 * value-add insight naturally — beyond just answering the raw fact.
 *
 * This is only used when the query goes to the LLM (i.e., KnowledgeRouter
 * did NOT handle it directly — e.g., repeat-skip, comparison, objection context).
 */

import { probeFactIntent } from './KnowledgeRouter';
import type { FactIntent } from './KnowledgeRouter';
import { getInsight } from './InsightLibrary';

/**
 * Builds an enrichment directive to append to the LLM system/user prompt.
 *
 * @param userText          The user's raw utterance
 * @param turnIndex         Optional conversation turn index (rotates insight templates)
 * @param isSchedulingStep  If true, skip enrichment — scheduling flow should not be interrupted
 * @returns  The `[RESPONSE INSIGHT]` block, or empty string if no enrichment applies
 */
export function buildEnrichmentDirective(
  userText: string,
  turnIndex?: number,
  isSchedulingStep?: boolean,
): string {
  // During scheduling steps, do not inject insights — keep the LLM focused
  // on extracting date/time from the user.
  if (isSchedulingStep) return '';

  const intent: FactIntent | null = probeFactIntent(userText);
  if (!intent) return '';

  const insight = getInsight(intent, turnIndex);
  if (!insight) return '';

  return [
    '[RESPONSE INSIGHT]',
    `After answering the fact, add this insight naturally: "${insight}"`,
    'Keep total response under 2 sentences and 20 words per sentence.',
  ].join('\n');
}
