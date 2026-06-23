/**
 * PropertyAdvantages: derives selling advantages from PROPERTY_FACTS.
 *
 * Uses PROPERTY_FACTS directly (Sarvam infra — module-level constant).
 * `deriveAdvantages()` takes no arguments.
 */

import { PROPERTY_FACTS } from '../llm/PropertyFacts';

// ─── Types ──────────────────────────────────────────────────────────────────

export type AdvantageCategory =
  | 'LOCATION'
  | 'BUILDER'
  | 'CONFIGURATION'
  | 'AMENITIES'
  | 'PRICE_VALUE'
  | 'CONNECTIVITY'
  | 'SCALE';

export interface Advantage {
  category: AdvantageCategory;
  headline: string;
  detail: string;
  /** Strength score 1-5 (higher = stronger selling point). */
  strength: number;
}

// ─── Derivation ─────────────────────────────────────────────────────────────

/**
 * Derive advantages from PROPERTY_FACTS. No arguments needed —
 * reads directly from the module-level PROPERTY_FACTS constant.
 *
 * Returns a sorted array (strongest first).
 */
export function deriveAdvantages(): Advantage[] {
  const advantages: Advantage[] = [];

  // ── Location ────────────────────────────────────────────────────────────
  if (PROPERTY_FACTS.location) {
    advantages.push({
      category: 'LOCATION',
      headline: `Prime location in ${PROPERTY_FACTS.location}`,
      detail: `Situated in ${PROPERTY_FACTS.location} with excellent connectivity. ${PROPERTY_FACTS.landmarks?.slice(0, 3).join(', ') ?? ''}`,
      strength: 4,
    });
  }

  // ── Metro Proximity (check landmarks) ──────────────────────────────────
  const metroLandmark = PROPERTY_FACTS.landmarks?.find((l) => /metro/i.test(l));
  if (metroLandmark) {
    advantages.push({
      category: 'CONNECTIVITY',
      headline: 'Metro walking distance',
      detail: `${metroLandmark} — daily commute becomes effortless.`,
      strength: 5,
    });
  }

  // ── Builder ─────────────────────────────────────────────────────────────
  if (PROPERTY_FACTS.developer) {
    advantages.push({
      category: 'BUILDER',
      headline: `Trusted developer: ${PROPERTY_FACTS.developer}`,
      detail: PROPERTY_FACTS.developerTrackRecord ?? `Developed by ${PROPERTY_FACTS.developer}.`,
      strength: 4,
    });
  }

  // ── Configuration Variety ──────────────────────────────────────────────
  const bhkOptions = PROPERTY_FACTS.bhk;
  if (bhkOptions && bhkOptions.length > 1) {
    advantages.push({
      category: 'CONFIGURATION',
      headline: `Multiple configurations: ${bhkOptions.join(', ')} BHK`,
      detail: `Choose from ${bhkOptions.length} configurations to match your family size and budget.`,
      strength: 3,
    });
  }

  // ── Amenities ──────────────────────────────────────────────────────────
  const amenities = PROPERTY_FACTS.amenities;
  if (amenities && amenities.length > 0) {
    const hasPool = amenities.some((a) => /pool|swimming/i.test(a));
    const hasGym = amenities.some((a) => /gym/i.test(a));
    const hasEV = amenities.some((a) => /ev|charging/i.test(a));

    let detail = `${amenities.length}+ amenities including ${amenities.slice(0, 4).join(', ')}`;
    if (hasEV) detail += ' — future-ready with EV charging';

    advantages.push({
      category: 'AMENITIES',
      headline: 'World-class amenities',
      detail,
      strength: hasPool && hasGym ? 4 : 3,
    });
  }

  // ── Price Value ────────────────────────────────────────────────────────
  if (PROPERTY_FACTS.priceRange) {
    advantages.push({
      category: 'PRICE_VALUE',
      headline: `Competitive pricing: ${PROPERTY_FACTS.priceRange}`,
      detail: `Starting range ${PROPERTY_FACTS.priceRange} with ${PROPERTY_FACTS.paymentPlan ?? '20:80 payment plan'}.`,
      strength: 4,
    });
  }

  // ── Scale (units/towers) ───────────────────────────────────────────────
  const units = PROPERTY_FACTS.units;
  if (units && units > 0) {
    const isExclusive = units <= 100;
    advantages.push({
      category: 'SCALE',
      headline: isExclusive
        ? `Exclusive community: only ${units} units`
        : `Large community: ${units} units`,
      detail: isExclusive
        ? `Only ${units} units across ${PROPERTY_FACTS.towers ?? 'multiple'} towers — low density, more privacy.`
        : `${units} units across ${PROPERTY_FACTS.towers ?? 'multiple'} towers — vibrant community with full amenities.`,
      strength: isExclusive ? 4 : 3,
    });
  }

  // Sort strongest first
  advantages.sort((a, b) => b.strength - a.strength);
  return advantages;
}

// ─── Convenience ────────────────────────────────────────────────────────────

/**
 * Pick a single advantage by category. Returns undefined if not found.
 */
export function pickAdvantage(category: AdvantageCategory): Advantage | undefined {
  return deriveAdvantages().find((a) => a.category === category);
}
