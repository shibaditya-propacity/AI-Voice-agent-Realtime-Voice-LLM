/**
 * EntityExtractor: deterministic regex-based entity extraction from user utterances.
 *
 * Runs synchronously after every finalized user transcript. Extracts:
 *   - name (first utterance heuristic + "my name is" patterns)
 *   - budget (lakh/crore amounts)
 *   - BHK preference (2/2.5/3 BHK)
 *   - site visit day (Monday–Sunday, today, tomorrow, weekend, specific dates)
 *   - site visit time (morning/afternoon/evening, HH:MM patterns)
 *   - visit intent (yes to visit, interest signals)
 *
 * Regex-first for zero latency. Groq llama-3.1-8b-instant is available as a
 * fallback for ambiguous utterances where regex yields nothing useful.
 */

import { Logger } from '../../shared/Logger';
import { ExtractionResult, ConversationStep } from './ConversationTypes';

const log = Logger.root('EntityExtractor');

// ─── Name Detection ──────────────────────────────────────────────────────────

const NAME_PATTERNS = [
  // "my name is X", "I am X", "this is X", "mera naam X hai"
  /(?:my\s+name\s+is|i\s+am|i'm|this\s+is|mera\s+naam(?:\s+hai)?)\s+([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})?)/i,
  // "X here", "X speaking", "X bol raha"
  /^([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})?)\s+(?:here|speaking|bol\s+raha|bol\s+rahi)/i,
  // "naam X hai", "naam X"
  /naam\s+([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})?)/i,
];

/**
 * First-turn heuristic: if the user's very first utterance is 1–3 words and
 * starts with a capitalized word, treat it as their name. The greeting already
 * asked "May I know your name?", so the reply is almost always just the name.
 */
const FIRST_TURN_NAME = /^([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})?)\.?\s*$/;

// Reject common false positives (greetings, filler words, etc.)
const NOT_NAMES = new Set([
  'hello', 'hi', 'hey', 'yes', 'no', 'haan', 'nahi', 'ok', 'okay',
  'good', 'fine', 'thanks', 'thank', 'sure', 'please', 'tell', 'what',
  'how', 'why', 'when', 'where', 'which', 'who', 'the', 'morning',
  'afternoon', 'evening', 'today', 'tomorrow', 'monday', 'tuesday',
  'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'ji',
]);

function extractName(text: string, isFirstTurn: boolean): string | undefined {
  const trimmed = text.trim();

  // Pattern-based extraction
  for (const pat of NAME_PATTERNS) {
    const m = trimmed.match(pat);
    if (m?.[1]) {
      const candidate = m[1].trim();
      if (!NOT_NAMES.has(candidate.toLowerCase())) return candidate;
    }
  }

  // First-turn heuristic
  if (isFirstTurn) {
    const m = trimmed.match(FIRST_TURN_NAME);
    if (m?.[1] && !NOT_NAMES.has(m[1].toLowerCase())) return m[1].trim();

    // Even looser: first word if it's capitalized and 2+ chars
    const words = trimmed.split(/\s+/);
    if (words.length <= 3) {
      const first = words[0].replace(/[.,!?]+$/, '');
      if (/^[A-Z][a-z]{1,20}$/.test(first) && !NOT_NAMES.has(first.toLowerCase())) {
        return words.length <= 2 ? words.map(w => w.replace(/[.,!?]+$/, '')).join(' ') : first;
      }
    }
  }

  return undefined;
}

// ─── Budget Detection ────────────────────────────────────────────────────────

const BUDGET_PATTERNS = [
  // "50 lakh", "1.5 crore", "45-50 lakh"
  /(\d+(?:\.\d+)?(?:\s*[-–to]+\s*\d+(?:\.\d+)?)?)\s*(lakh|lac|lakhs|crore|crores|cr)/i,
  // "budget is 50L", "around 80L"
  /(?:budget|range)[\s:]+(?:around\s+)?(\d+(?:\.\d+)?)\s*(l|cr)/i,
];

function extractBudget(text: string): string | undefined {
  for (const pat of BUDGET_PATTERNS) {
    const m = text.match(pat);
    if (m) return `${m[1]} ${m[2]}`.trim();
  }
  return undefined;
}

// ─── BHK Detection ───────────────────────────────────────────────────────────

const BHK_PATTERN = /(2\.5|2|3)\s*bhk/i;

function extractBhk(text: string): string | undefined {
  const m = text.match(BHK_PATTERN);
  return m ? `${m[1]} BHK` : undefined;
}

// ─── Visit Day Detection ─────────────────────────────────────────────────────

const DAY_NAMES = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|kal|parso)\b/i;
const WEEKEND_PATTERN = /\b(weekend|saturday|sunday|is\s+week(?:end)?)\b/i;
const DATE_PATTERN = /\b(\d{1,2})(?:st|nd|rd|th)?\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;

function extractVisitDay(text: string): string | undefined {
  const dateMatch = text.match(DATE_PATTERN);
  if (dateMatch) return `${dateMatch[1]} ${dateMatch[2]}`;

  const dayMatch = text.match(DAY_NAMES);
  if (dayMatch) return dayMatch[1];

  const weekendMatch = text.match(WEEKEND_PATTERN);
  if (weekendMatch) return 'weekend';

  return undefined;
}

// ─── Visit Time Detection ────────────────────────────────────────────────────

const TIME_PATTERNS = [
  // "10 AM", "2:30 PM", "10 baje"
  /\b(\d{1,2}(?::\d{2})?)\s*(am|pm|a\.m\.|p\.m\.)\b/i,
  /\b(\d{1,2})\s*baje\b/i,
  // "morning", "afternoon", "evening", "subah", "dopahar", "shaam"
  /\b(morning|afternoon|evening|subah|dopahar|shaam)\b/i,
];

function extractVisitTime(text: string): string | undefined {
  for (const pat of TIME_PATTERNS) {
    const m = text.match(pat);
    if (m) return m[0].trim();
  }
  return undefined;
}

// ─── Visit Intent Detection ──────────────────────────────────────────────────

const VISIT_YES_PATTERNS = [
  /\b(yes|yeah|sure|okay|ok|haan|theek\s+hai|chalega|chalo|let'?s\s+do\s+it|i'?d\s+like\s+to\s+visit|interested|want\s+to\s+(?:visit|see|come))\b/i,
];

const VISIT_NO_PATTERNS = [
  /\b(no|nahi|not\s+interested|don'?t\s+want|no\s+thanks|abhi\s+nahi)\b/i,
];

function detectVisitIntent(text: string): boolean | undefined {
  for (const pat of VISIT_YES_PATTERNS) {
    if (pat.test(text)) return true;
  }
  for (const pat of VISIT_NO_PATTERNS) {
    if (pat.test(text)) return false;
  }
  return undefined;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract all detectable entities from a user utterance. Runs synchronously
 * with zero external calls. The currentStep context helps tune extraction
 * (e.g., first-turn name heuristic only in GET_NAME).
 */
export function extractEntities(
  text: string,
  currentStep: ConversationStep,
): ExtractionResult {
  const result: ExtractionResult = {};

  const isFirstTurn = currentStep === 'GET_NAME';
  const name = extractName(text, isFirstTurn);
  if (name) result.name = name;

  const budget = extractBudget(text);
  if (budget) result.budget = budget;

  const bhk = extractBhk(text);
  if (bhk) result.bhk = bhk;

  const day = extractVisitDay(text);
  if (day) result.visitDay = day;

  const time = extractVisitTime(text);
  if (time) result.visitTime = time;

  const intent = detectVisitIntent(text);
  if (intent !== undefined) result.visitIntent = intent;

  if (Object.keys(result).length > 0) {
    log.debug('Entities extracted', { text: text.slice(0, 80), result });
  }

  return result;
}

// ─── Groq Extraction (optional, async) ───────────────────────────────────────

/**
 * Call Groq llama-3.1-8b-instant for extraction when regex yields nothing
 * useful but the utterance likely contains structured info. Fire-and-forget;
 * state updates from the result are applied on the next turn.
 */
export async function extractWithGroq(
  text: string,
  apiKey: string,
): Promise<ExtractionResult> {
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content: 'Extract entities from the user utterance. Return JSON only: {"name":"","budget":"","bhk":"","visitDay":"","visitTime":""}. Empty string if not found. No explanation.',
          },
          { role: 'user', content: text },
        ],
        temperature: 0,
        max_tokens: 100,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      log.warn('Groq extraction failed', { status: response.status });
      return {};
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return {};

    const parsed = JSON.parse(content) as Record<string, string>;
    const result: ExtractionResult = {};
    if (parsed.name) result.name = parsed.name;
    if (parsed.budget) result.budget = parsed.budget;
    if (parsed.bhk) result.bhk = parsed.bhk;
    if (parsed.visitDay) result.visitDay = parsed.visitDay;
    if (parsed.visitTime) result.visitTime = parsed.visitTime;
    return result;
  } catch (err) {
    log.warn('Groq extraction error', { error: (err as Error).message });
    return {};
  }
}
