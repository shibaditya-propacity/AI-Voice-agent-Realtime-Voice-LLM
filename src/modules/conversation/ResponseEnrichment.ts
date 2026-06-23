/**
 * ResponseEnrichment: detects user question intent and injects an approved
 * contextual insight into the LLM prompt so responses sound like a
 * knowledgeable consultant rather than a database reader.
 *
 * Architecture:
 *   User utterance → detectIntent() → getInsight() → enrichment directive
 *
 * The enrichment is injected as a [RESPONSE INSIGHT] block in the prompt,
 * instructing the LLM to append the insight after the factual answer.
 *
 * Rules:
 *  - Maximum 2 sentences total (fact + insight).
 *  - Maximum 20 words per sentence.
 *  - Never invent facts — insights are pre-approved templates.
 *  - Zero latency impact — pure synchronous string matching + lookup.
 */

import { PropertyFacts } from './ConversationTypes';
import { QuestionIntent, getInsight } from './InsightLibrary';

// ─── Intent Detection Patterns ──────────────────────────────────────────────

interface IntentPattern {
  intent: QuestionIntent;
  pattern: RegExp;
}

/**
 * Ordered list of intent patterns. First match wins.
 * Patterns cover English, Hindi, and Hinglish variations.
 */
const INTENT_PATTERNS: IntentPattern[] = [
  {
    intent: 'PRICE',
    pattern: /\b(price|pricing|rate|cost|kitna|kharcha|budget|per\s*sq|psf|sqft|sq\s*ft|rupee|lakh|crore|paisa|keemat|कीमत|दाम|रेट|कितना|खर्चा|बजट|महंगा|सस्ता|affordable|expensive|cheap)\b/i,
  },
  {
    intent: 'POSSESSION',
    pattern: /\b(possession|ready|handover|move\s*in|delivery|complete|kab\s*milega|kab\s*tak|when|timeline|कब|तैयार|पज़ेशन|मिलेगा|ready\s*to\s*move|under\s*construction)\b/i,
  },
  {
    intent: 'LOCATION',
    pattern: /\b(location|kahan|where|area|jagah|address|direction|connectivity|commute|transport|metro|road|highway|कहाँ|कहां|जगह|पता|लोकेशन|sector|neighborhood|near|nearby)\b/i,
  },
  {
    intent: 'AMENITIES',
    pattern: /\b(amenity|amenities|facilities|facility|features|gym|pool|garden|clubhouse|parking|play\s*area|jogging|ev\s*charging|सुविधा|सुविधाएं|फैसिलिटी|गार्डन|क्लबहाउस|पार्किंग)\b/i,
  },
  {
    intent: 'DEVELOPER',
    pattern: /\b(developer|builder|company|brand|group|lunkad|promoter|construction\s*company|बिल्डर|डेवलपर|कंपनी|ब्रांड|कौन\s*बना|किसका\s*project|who\s*is\s*building|reputation|track\s*record)\b/i,
  },
  {
    intent: 'BHK',
    pattern: /\b(bhk|bedroom|bed\s*room|flat\s*size|configuration|carpet|super\s*built|बीएचके|बेडरूम|कमरे|kitne\s*kamre|flat\s*type|apartment\s*type|layout|floor\s*plan|size)\b/i,
  },
  {
    intent: 'UNITS',
    pattern: /\b(units|flats|apartments|kitne\s*flat|total\s*flats|how\s*many|towers|floors|buildings|कितने\s*फ्लैट|यूनिट|टावर|मंज़िल)\b/i,
  },
];

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Detect the primary question intent from a user utterance.
 * Returns 'GENERAL' if no specific intent is matched.
 */
export function detectIntent(userText: string): QuestionIntent {
  const text = userText.toLowerCase().trim();

  // Skip intent detection for very short utterances (greetings, yes/no)
  if (text.split(/\s+/).length <= 2) return 'GENERAL';

  for (const { intent, pattern } of INTENT_PATTERNS) {
    if (pattern.test(text)) return intent;
  }

  return 'GENERAL';
}

/**
 * Build the [RESPONSE INSIGHT] directive block for prompt injection.
 *
 * Returns the block string if an intent-specific insight is available,
 * or an empty string if no enrichment should be applied (e.g., for
 * GENERAL intent or scheduling steps where enrichment is irrelevant).
 */
export function buildEnrichmentDirective(
  userText: string,
  facts: PropertyFacts,
  turnIndex: number = 0,
  isSchedulingStep: boolean = false,
): string {
  // Don't enrich scheduling-related steps — those use canned responses
  if (isSchedulingStep) return '';

  const intent = detectIntent(userText);

  // No enrichment for generic/undetected intents
  if (intent === 'GENERAL') return '';

  const insight = getInsight(intent, facts, turnIndex);
  if (!insight) return '';

  return [
    '',
    '[RESPONSE INSIGHT]',
    `After answering the fact, add this insight naturally: "${insight}"`,
    'Keep total response under 2 sentences and 20 words per sentence.',
  ].join('\n');
}
