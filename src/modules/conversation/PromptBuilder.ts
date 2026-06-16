/**
 * PromptBuilder: constructs the [PROPERTY FACTS] + [SESSION STATE] + [NEXT ACTION]
 * context block injected before every LLM response.
 *
 * Injected as a USER text block into the open Nova prompt so the LLM sees
 * current state and a deterministic directive for what to do next.
 */

import { SessionState, ConversationStep, PropertyFacts } from './ConversationTypes';

// ─── Next Action Directives ──────────────────────────────────────────────────

const NEXT_ACTIONS: Record<ConversationStep, (s: SessionState) => string> = {
  GET_NAME: () =>
    'Acknowledge naturally. Ask their name if not given.',

  ANSWERING: (s) =>
    `Address ${s.customerName}'s question briefly. Steer toward a site visit. Ask if they want to visit.`,

  ASK_DAY: (s) =>
    `${s.customerName} is interested. Ask which day works for a site visit.`,

  ASK_TIME: (s) =>
    `Day: ${s.siteVisitDay}. Ask what time works for ${s.customerName}.`,

  CONFIRMING: (s) =>
    `Confirm: ${s.siteVisitDay} at ${s.siteVisitTime}. Read it back. Ask "${s.customerName}, shall I book this?"`,

  BOOKED: (s) =>
    `Visit booked: ${s.siteVisitDay} at ${s.siteVisitTime}. Thank ${s.customerName}, say goodbye. Keep it short.`,
};

// ─── Context Block Builder ───────────────────────────────────────────────────

/**
 * Build the full context block for injection. Under 200 tokens typically.
 */
export function buildContextBlock(
  state: SessionState,
  facts: PropertyFacts,
): string {
  const lines: string[] = [];

  // [PROPERTY FACTS] — static, so the LLM never needs to guess
  lines.push('[PROPERTY FACTS]');
  lines.push(`Project: ${facts.projectName} by ${facts.builder}`);
  lines.push(`Location: ${facts.location}`);
  lines.push(`Price: ${facts.price}`);
  lines.push(`BHK: ${facts.bhkOptions.join(', ')}`);
  lines.push(`Possession: ${facts.possession}`);
  lines.push(`Units: ${facts.units}`);
  lines.push(`Amenities: ${facts.amenities.join(', ')}`);

  // [SESSION STATE] — what we know about this caller
  lines.push('');
  lines.push('[SESSION STATE]');
  lines.push(`Step: ${state.currentStep}`);
  if (state.customerName) lines.push(`Name: ${state.customerName}`);
  if (state.bhkPreference) lines.push(`BHK: ${state.bhkPreference}`);
  if (state.budget) lines.push(`Budget: ${state.budget}`);
  if (state.siteVisitDay) lines.push(`Day: ${state.siteVisitDay}`);
  if (state.siteVisitTime) lines.push(`Time: ${state.siteVisitTime}`);
  if (state.visitBooked) lines.push('Status: BOOKED');

  // [NEXT ACTION] — deterministic directive
  lines.push('');
  lines.push('[NEXT ACTION]');
  lines.push(NEXT_ACTIONS[state.currentStep](state));
  lines.push('Reply in under 12 words. One sentence. No questions already answered.');

  return lines.join('\n');
}
