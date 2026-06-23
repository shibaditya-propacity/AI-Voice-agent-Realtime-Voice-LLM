/**
 * VisitPitches: interest-score-gated visit invitation templates.
 *
 * Visit invitations are only triggered when the caller has shown
 * sufficient interest (interestScore >= threshold). They are never
 * repeated within a call and never feel pushy.
 *
 * Rules:
 *  - One visit invite per call maximum.
 *  - Only after genuine interest signals.
 *  - Sound natural, not scripted.
 *  - Max 1 sentence, 15 words.
 */

import { PropertyFacts } from '../conversation/ConversationTypes';

// ─── Visit Pitch Templates ──────────────────────────────────────────────────

type PitchBuilder = (facts: PropertyFacts, callerName?: string) => string;

const PITCHES: PitchBuilder[] = [
  (_f, name) =>
    name
      ? `${name} ji, project personally dekhna chahenge ek baar?`
      : 'Project personally dekhna chahenge ek baar?',

  (_f, name) =>
    name
      ? `${name} ji, site visit karke better idea milega.`
      : 'Site visit karke better idea milega.',

  (f, name) =>
    name
      ? `${name} ji, ${f.projectName} directly dekhna helpful rahega.`
      : `${f.projectName} directly dekhna helpful rahega.`,
];

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Get a visit invitation pitch. Rotated by turn index.
 */
export function getVisitPitch(
  facts: PropertyFacts,
  turnIndex: number = 0,
  callerName?: string,
): string {
  const builder = PITCHES[turnIndex % PITCHES.length];
  return builder(facts, callerName);
}
