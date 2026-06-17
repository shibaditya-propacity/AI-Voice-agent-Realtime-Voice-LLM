/**
 * PropertyFacts: the single source of truth for project facts.
 *
 * This block is STATIC — it is built exactly once at module load and frozen.
 * It is injected verbatim into the system prompt as [PROPERTY_FACTS] and is
 * also the allow-list the validation layer checks responses against.
 *
 * The LLM must NEVER state a price, size, possession date, configuration, or
 * developer name that is not present here. Anything outside this block is a
 * hallucination and is caught by SessionState.validateOutput().
 */

export const PROPERTY_FACTS = Object.freeze({
  project: 'Akshay Vista',
  location: 'Pimple Gurav, Pune',
  bhk: ['2', '2.5', '3'],
  sizeSqft: '8 to 10 thousand sq ft',
  pricePerSqft: '8 to 10 thousand per sq ft',
  possession: 'April 2027',
  developer: 'R.R. Lunkad',
  units: 78,
  amenities: ['gym', 'swimming pool', 'EV charging', 'kids zone'],
} as const);

/**
 * Pre-rendered [PROPERTY_FACTS] block. Built once, never rebuilt per turn
 * (zero-copy prompt construction — see ConversationManager).
 */
export const PROPERTY_FACTS_BLOCK: string = [
  '[PROPERTY_FACTS] (only source of truth — never add or invent beyond this)',
  `Project: ${PROPERTY_FACTS.project}`,
  `Location: ${PROPERTY_FACTS.location}`,
  `Configs: ${PROPERTY_FACTS.bhk.join(', ')} BHK`,
  `Amenities: ${PROPERTY_FACTS.amenities.join(', ')}`,
  `Price: ${PROPERTY_FACTS.pricePerSqft}`,
  `Possession: ${PROPERTY_FACTS.possession}`,
  `Developer: ${PROPERTY_FACTS.developer}`,
  `Units: ${PROPERTY_FACTS.units}`,
].join('\n');
