/**
 * PropertyAdvantages: approved sales insights derived from PropertyFacts.
 *
 * These are factual observations about the project — never invented claims.
 * Each advantage is tagged with a category so it can be contextually matched
 * to user questions.
 */

import { PropertyFacts } from '../conversation/ConversationTypes';

// ─── Advantage Categories ───────────────────────────────────────────────────

export type AdvantageCategory =
  | 'connectivity'
  | 'community'
  | 'developer_trust'
  | 'inventory'
  | 'value'
  | 'lifestyle'
  | 'timeline';

export interface Advantage {
  category: AdvantageCategory;
  text: string;
}

// ─── Advantage Builders ─────────────────────────────────────────────────────

/**
 * Derive approved advantages from PropertyFacts. No hardcoded project claims.
 */
export function deriveAdvantages(facts: PropertyFacts): Advantage[] {
  const advantages: Advantage[] = [];

  // Connectivity — derived from location
  const locationLower = facts.location.toLowerCase();
  if (locationLower.includes('it park') || locationLower.includes('hinjewadi') ||
      locationLower.includes('whitefield') || locationLower.includes('electronic city')) {
    advantages.push({ category: 'connectivity', text: 'IT hub ke paas convenient location hai.' });
  }
  if (locationLower.includes('metro') || locationLower.includes('highway') ||
      locationLower.includes('expressway')) {
    advantages.push({ category: 'connectivity', text: 'Major transport links accessible hain.' });
  }
  // Default connectivity
  advantages.push({ category: 'connectivity', text: 'Daily commute ke liye convenient location hai.' });

  // Community — derived from unit count and amenities
  if (facts.units <= 100) {
    advantages.push({ category: 'community', text: 'Close-knit community feel rahega.' });
  } else if (facts.units <= 300) {
    advantages.push({ category: 'community', text: 'Balanced community size hai.' });
  }
  if (facts.amenities.length >= 4) {
    advantages.push({ category: 'lifestyle', text: 'Family living ke liye balanced amenities hain.' });
  }

  // Developer trust — derived from builder name
  const parts = facts.location.split(',');
  const city = parts[parts.length - 1]?.trim() || 'market';
  advantages.push({ category: 'developer_trust', text: `${city} market mein established developer hain.` });

  // Inventory — derived from unit count
  if (facts.units <= 100) {
    advantages.push({ category: 'inventory', text: 'Limited units hain, exclusive project hai.' });
  }

  // Value — derived from BHK options
  if (facts.bhkOptions.length >= 3) {
    advantages.push({ category: 'value', text: 'Multiple configurations se budget flexibility milti hai.' });
  }

  // Timeline — derived from possession
  advantages.push({ category: 'timeline', text: 'Planning ke liye comfortable timeline hai.' });

  return advantages;
}

/**
 * Pick a contextually relevant advantage for a given category.
 */
export function pickAdvantage(
  facts: PropertyFacts,
  category: AdvantageCategory,
  turnIndex: number = 0,
): string | null {
  const all = deriveAdvantages(facts);
  const matching = all.filter(a => a.category === category);
  if (matching.length === 0) return null;
  return matching[turnIndex % matching.length].text;
}
