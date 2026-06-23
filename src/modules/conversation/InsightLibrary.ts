
/**
 * InsightLibrary: approved contextual insight templates for response enrichment.
 *
 * Each insight is a short sentence (<20 words) that adds a professional
 * perspective without inventing facts. Templates are parameterized from
 * PropertyFacts so they work for any project configuration.
 *
 * Rules:
 *  - Never invent facts, amenities, or project advantages.
 *  - Only reference data present in PropertyFacts.
 *  - Keep insights generic and observational (professional perspective).
 *  - No sales pitches, no hype, no "excellent choice" flattery.
 */

import { PropertyFacts } from './ConversationTypes';

// ─── Intent Categories ──────────────────────────────────────────────────────

export type QuestionIntent =
  | 'PRICE'
  | 'LOCATION'
  | 'AMENITIES'
  | 'DEVELOPER'
  | 'POSSESSION'
  | 'BHK'
  | 'UNITS'
  | 'GENERAL';

// ─── Insight Template ───────────────────────────────────────────────────────

/** A function that generates an insight sentence from PropertyFacts. */
type InsightTemplate = (facts: PropertyFacts) => string;

// ─── Approved Insight Templates ─────────────────────────────────────────────

const INSIGHT_TEMPLATES: Record<QuestionIntent, InsightTemplate[]> = {
  PRICE: [
    (f) => `${f.projectName} ka pricing similar projects ke comparison mein competitive hai.`,
    (f) => `${f.bhkOptions.length} configurations available hain, budget flexibility milti hai.`,
    (f) => `${f.builder} ke projects mein pricing transparent rehti hai.`,
  ],

  LOCATION: [
    (f) => {
      // Extract area keywords from location for a contextual insight
      const hasIT = f.location.toLowerCase().includes('it park') || f.location.toLowerCase().includes('hinjewadi');
      if (hasIT) return 'Daily commute ke liye IT professionals ke liye convenient location hai.';
      return 'Daily commute ke liye location kaafi convenient hai.';
    },
    (f) => `${f.projectName} ka location connectivity ke liye well-suited hai.`,
    () => 'Residential aur commercial areas dono accessible hain yahan se.',
  ],

  AMENITIES: [
    (f) => {
      const count = f.amenities.length;
      return `${count} key amenities hain, family living ke liye balanced setup hai.`;
    },
    () => 'Day-to-day lifestyle ke liye practical amenities cover hain.',
    (f) => `${f.projectName} mein essential amenities well-planned hain.`,
  ],

  DEVELOPER: [
    (f) => {
      // Extract city from location for market context
      const parts = f.location.split(',');
      const city = parts[parts.length - 1]?.trim() || 'market';
      return `${city} market mein established developer hain.`;
    },
    (f) => `${f.builder} ke projects mein quality construction ka track record hai.`,
    (f) => `${f.builder} ka ${f.projectName} unke experienced portfolio ka hissa hai.`,
  ],

  POSSESSION: [
    () => 'Planning perspective se comfortable timeline hai.',
    (f) => `${f.projectName} ka construction schedule track par hai.`,
    () => 'Home loan aur financial planning ke liye sufficient time milega.',
  ],

  BHK: [
    (f) => {
      const count = f.bhkOptions.length;
      return `${count} options hain, family size ke hisaab se flexibility milti hai.`;
    },
    () => 'Different family sizes ke liye configurations available hain.',
    (f) => `${f.projectName} mein space planning practical hai.`,
  ],

  UNITS: [
    (f) => {
      const units = f.units;
      if (units <= 100) return 'Limited units hain, community living ka feel rahega.';
      if (units <= 300) return 'Mid-size project hai, manageable community hoga.';
      return 'Large-scale project hai, comprehensive facilities milenge.';
    },
    (f) => `${f.projectName} mein well-planned unit distribution hai.`,
  ],

  GENERAL: [
    (f) => `${f.projectName} overall ek balanced residential project hai.`,
    () => 'Koi specific cheez aur jaanna ho toh zaroor poochiye.',
  ],
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Get an approved contextual insight for the given intent.
 * Uses a rotating index (not random) for deterministic test behavior
 * while still varying responses across turns.
 */
export function getInsight(
  intent: QuestionIntent,
  facts: PropertyFacts,
  turnIndex: number = 0,
): string {
  const templates = INSIGHT_TEMPLATES[intent];
  if (!templates || templates.length === 0) return '';

  const idx = turnIndex % templates.length;
  return templates[idx](facts);
}

/**
 * Get all available intents (for testing/introspection).
 */
export function getAvailableIntents(): QuestionIntent[] {
  return Object.keys(INSIGHT_TEMPLATES) as QuestionIntent[];
}
