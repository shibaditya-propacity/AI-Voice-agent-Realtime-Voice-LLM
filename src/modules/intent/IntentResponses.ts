/**
 * IntentResponses: deterministic response builders for property-information intents.
 *
 * Each builder reads from PropertyFacts (single source of truth) and returns
 * a consultative 2-sentence response: FACT + CONTEXTUAL INSIGHT.
 *
 * Rules:
 *  - Max 2 sentences, max 20 words per sentence.
 *  - Never invent facts — only use PropertyFacts data.
 *  - Sound like a knowledgeable consultant, not a database.
 *  - No sales pitches, no hype.
 */

import { PropertyFacts } from '../conversation/ConversationTypes';
import { Intent } from './IntentClassifier';

// ─── Response Builder Type ──────────────────────────────────────────────────

type ResponseBuilder = (facts: PropertyFacts, turnIndex: number) => string;

// ─── Insight Pools (rotated by turn index) ──────────────────────────────────

function pick<T>(pool: T[], turnIndex: number): T {
  return pool[turnIndex % pool.length];
}

// ─── Price Response ─────────────────────────────────────────────────────────

function buildPriceResponse(facts: PropertyFacts, turnIndex: number): string {
  const fact = `${facts.price} hai.`;
  const insights = [
    `${facts.bhkOptions.length} configurations available hain, budget flexibility milti hai.`,
    `${facts.projectName} ka pricing competitive segment mein aata hai.`,
    `${facts.builder} ke projects mein pricing transparent rehti hai.`,
  ];
  return `${fact} ${pick(insights, turnIndex)}`;
}

// ─── Location Response ──────────────────────────────────────────────────────

function buildLocationResponse(facts: PropertyFacts, turnIndex: number): string {
  // Extract the primary area from the location string
  const primaryArea = facts.location.split(',')[0]?.trim() || facts.location;
  const fact = `${primaryArea} mein hai.`;

  const hasIT = facts.location.toLowerCase().includes('it park') ||
                facts.location.toLowerCase().includes('hinjewadi');
  const insights = hasIT
    ? [
        'Daily commute ke liye IT professionals ke liye convenient location hai.',
        `${facts.projectName} ka location connectivity ke liye well-suited hai.`,
        'Residential aur commercial areas dono accessible hain yahan se.',
      ]
    : [
        'Daily commute ke liye location kaafi convenient hai.',
        `${facts.projectName} ka location connectivity ke liye well-suited hai.`,
        'Residential aur commercial areas dono accessible hain yahan se.',
      ];
  return `${fact} ${pick(insights, turnIndex)}`;
}

// ─── Amenities Response ─────────────────────────────────────────────────────

function buildAmenitiesResponse(facts: PropertyFacts, turnIndex: number): string {
  const amenityList = facts.amenities.join(', ');
  const fact = `${amenityList} available hain.`;
  const insights = [
    `${facts.amenities.length} key amenities hain, family living ke liye balanced setup hai.`,
    'Day-to-day lifestyle ke liye practical amenities cover hain.',
    `${facts.projectName} mein essential amenities well-planned hain.`,
  ];
  return `${fact} ${pick(insights, turnIndex)}`;
}

// ─── BHK Response ───────────────────────────────────────────────────────────

function buildBhkResponse(facts: PropertyFacts, turnIndex: number): string {
  const bhkList = facts.bhkOptions.join(', ');
  const fact = `${bhkList} options available hain.`;
  const insights = [
    `${facts.bhkOptions.length} options hain, family size ke hisaab se flexibility milti hai.`,
    'Different family sizes ke liye configurations available hain.',
    `${facts.projectName} mein space planning practical hai.`,
  ];
  return `${fact} ${pick(insights, turnIndex)}`;
}

// ─── Possession Response ────────────────────────────────────────────────────

function buildPossessionResponse(facts: PropertyFacts, turnIndex: number): string {
  const fact = `${facts.possession} possession expected hai.`;
  const insights = [
    'Planning perspective se comfortable timeline hai.',
    `${facts.projectName} ka construction schedule track par hai.`,
    'Home loan aur financial planning ke liye sufficient time milega.',
  ];
  return `${fact} ${pick(insights, turnIndex)}`;
}

// ─── Developer Response ─────────────────────────────────────────────────────

function buildDeveloperResponse(facts: PropertyFacts, turnIndex: number): string {
  // Use builder name without dots to avoid sentence-splitting issues (e.g. "R. R." → "R R")
  const builderClean = facts.builder.replace(/\.\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const fact = `${builderClean} ka project hai.`;
  // Extract city from location for market context
  const parts = facts.location.split(',');
  const city = parts[parts.length - 1]?.trim() || 'market';
  const insights = [
    `${city} market mein established developer hain.`,
    `${builderClean} ke projects mein quality construction ka track record hai.`,
    `${builderClean} ka ${facts.projectName} unke experienced portfolio ka hissa hai.`,
  ];
  return `${fact} ${pick(insights, turnIndex)}`;
}

// ─── Units Response ─────────────────────────────────────────────────────────

function buildUnitsResponse(facts: PropertyFacts, turnIndex: number): string {
  const fact = `Total ${facts.units} units hain.`;
  const insights: string[] = [];
  if (facts.units <= 100) {
    insights.push('Limited units hain, community living ka feel rahega.');
  } else if (facts.units <= 300) {
    insights.push('Mid-size project hai, manageable community hoga.');
  } else {
    insights.push('Large-scale project hai, comprehensive facilities milenge.');
  }
  insights.push(`${facts.projectName} mein well-planned unit distribution hai.`);
  return `${fact} ${pick(insights, turnIndex)}`;
}

// ─── Response Builder Registry ──────────────────────────────────────────────

const RESPONSE_BUILDERS: Partial<Record<Intent, ResponseBuilder>> = {
  [Intent.PRICE]:      buildPriceResponse,
  [Intent.LOCATION]:   buildLocationResponse,
  [Intent.AMENITIES]:  buildAmenitiesResponse,
  [Intent.BHK]:        buildBhkResponse,
  [Intent.POSSESSION]: buildPossessionResponse,
  [Intent.DEVELOPER]:  buildDeveloperResponse,
  [Intent.UNITS]:      buildUnitsResponse,
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Build a deterministic response for a locally-routable intent.
 * Returns null if no builder exists for the given intent.
 */
export function buildLocalResponse(
  intent: Intent,
  facts: PropertyFacts,
  turnIndex: number = 0,
): string | null {
  const builder = RESPONSE_BUILDERS[intent];
  if (!builder) return null;
  return builder(facts, turnIndex);
}
