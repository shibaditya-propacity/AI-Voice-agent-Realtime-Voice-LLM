/**
 * PreferenceRecall: deterministic preference recall + missing-field logic.
 *
 * Pure, env-free, zero-LLM. The single source of truth for two concerns:
 *
 *  1. RECALL — when the caller asks "what was my budget / which BHK did I say /
 *     what did I tell you", answer straight from stored SessionState values.
 *     Never invent: if a field is empty, say so honestly.
 *
 *  2. MISSING-FIELD — decide whether a fact answer should append a follow-up
 *     question. We only ask for a field that has NOT been captured yet, so the
 *     bot never re-asks something the caller already told us (e.g. it must not
 *     ask "which BHK?" once bhkPreference is "3 BHK").
 *
 * Kept as plain functions over a values object (not the SessionState instance)
 * so it's trivially unit-testable without env/IO.
 */

// ─── Stored Preference Values ────────────────────────────────────────────────

export interface PreferenceValues {
  name: string | null;
  budget: string | null;
  bhk: string | null;
  day: string | null;
  time: string | null;
}

/** Which stored preference the caller is asking us to recall. */
export type RecallTarget = 'name' | 'budget' | 'bhk' | 'day' | 'time' | 'all';

// ─── Recall Detection ─────────────────────────────────────────────────────────

interface RecallRule {
  target: RecallTarget;
  pattern: RegExp;
}

/**
 * Ordered most-specific-first. A recall query is the caller asking us to repeat
 * something THEY told us earlier ("what was my…", "kya bataya tha", "again").
 * The "my/mera/meri/maine" + recall-verb framing is what separates these from a
 * fresh question ("what is the price?" is NOT a recall).
 */
const RECALL_RULES: RecallRule[] = [
  {
    target: 'budget',
    pattern: /\b(my|mera|mere|meri)\s*budget\b|\bbudget\s*(kya|kitna|kitne)\s*(bola|btaya|bataya|kaha|tha|mention)\b|what\s*(was|is)\s*my\s*budget|budget\s*phir\s*se|मेरा\s*budget|मेरा\s*बजट/i,
  },
  {
    target: 'bhk',
    pattern: /\b(my|mera|mere|kaun\s*sa|kaunsa|konsa|kitne)\s*bhk\b|what\s*bhk\s*(did\s*i|i\s*(said|told|mentioned))|bhk\s*(kya|kaunsa|konsa)\s*(bola|bataya|kaha|tha)|कौन\s*सा\s*bhk|मेरा\s*bhk/i,
  },
  {
    target: 'name',
    pattern: /\b(my|mera)\s*naam\b|what\s*(was|is)\s*my\s*name|mera\s*naam\s*(kya|bataya|tha)|मेरा\s*नाम/i,
  },
  {
    target: 'day',
    pattern: /\b(which|what|kaun\s*sa|kaunsa|konsa)\s*(day|din)\b.*\b(i|maine|bataya|bola|tha|said|told)\b|visit\s*(day|din)\s*(kya|kaunsa)|कौन\s*सा\s*दिन/i,
  },
  {
    target: 'time',
    pattern: /\b(which|what|kaun\s*sa|kaunsa|konsa)\s*(time|samay|वक्त|समय)\b.*\b(i|maine|bataya|bola|tha|said|told)\b|visit\s*time\s*(kya|kaunsa)/i,
  },
  {
    // Broad "remind me what I said" — must come last (least specific).
    target: 'all',
    pattern: /\b(my\s*requirement|meri\s*requirement|kya\s*(bataya|bola)\s*tha|kya\s*kaha\s*tha|what\s*did\s*i\s*(mention|say|tell)|mention\s*kiya\s*tha|phir\s*se\s*bata|remind\s*me|again\s*(what|batao)|दोबारा\s*बता|फिर\s*से\s*बता)\b/i,
  },
];

/**
 * Detect whether the caller is asking us to recall a previously-stated
 * preference. Returns the target field, or null if this is not a recall query.
 */
export function detectRecallQuery(text: string): RecallTarget | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  for (const { target, pattern } of RECALL_RULES) {
    if (pattern.test(trimmed)) return target;
  }
  return null;
}

// ─── Recall Response Builder ────────────────────────────────────────────────

/** Single-field recall line — value present. */
function presentLine(target: Exclude<RecallTarget, 'all'>, v: PreferenceValues): string {
  switch (target) {
    case 'name':   return `जी, आपने अपना नाम ${v.name} बताया था।`;
    case 'budget': return `जी, आपने budget around ${v.budget} बताया था।`;
    case 'bhk':    return `जी, आपने ${v.bhk} preference बताया था।`;
    case 'day':    return `जी, आपने visit के लिए ${v.day} बताया था।`;
    case 'time':   return `जी, आपने visit time ${v.time} बताया था।`;
  }
}

/** Single-field recall line — value NOT captured (never hallucinate). */
function missingLine(target: Exclude<RecallTarget, 'all'>): string {
  switch (target) {
    case 'name':   return `जी, आपने अभी तक अपना नाम नहीं बताया — बता दीजिए?`;
    case 'budget': return `जी, आपने अभी तक budget mention नहीं किया — कितने range में देख रहे हैं?`;
    case 'bhk':    return `जी, आपने अभी तक नहीं बताया कि कौन सा BHK चाहिए — 2, 2.5, या 3 BHK?`;
    case 'day':    return `जी, अभी तक कोई visit day तय नहीं हुआ।`;
    case 'time':   return `जी, अभी तक कोई visit time तय नहीं हुआ।`;
  }
}

function fieldValue(target: Exclude<RecallTarget, 'all'>, v: PreferenceValues): string | null {
  switch (target) {
    case 'name':   return v.name;
    case 'budget': return v.budget;
    case 'bhk':    return v.bhk;
    case 'day':    return v.day;
    case 'time':   return v.time;
  }
}

/**
 * Build a deterministic recall response from stored values. Pure string lookup —
 * never calls the LLM, never invents a value. For 'all', summarises whatever is
 * known; if nothing is known, says so.
 *
 * @returns the spoken response AND whether any stored value was actually used
 *          (used=false means every relevant field was empty — caller logs this
 *          as a non-hallucinated "not captured yet" answer).
 */
export function buildRecallResponse(
  target: RecallTarget,
  v: PreferenceValues,
): { response: string; used: boolean } {
  if (target !== 'all') {
    const value = fieldValue(target, v);
    return value
      ? { response: presentLine(target, v), used: true }
      : { response: missingLine(target), used: false };
  }

  // 'all' — summarise everything captured, in a single natural line.
  const parts: string[] = [];
  if (v.name) parts.push(`naam ${v.name}`);
  if (v.bhk) parts.push(`${v.bhk}`);
  if (v.budget) parts.push(`budget around ${v.budget}`);
  if (v.day) parts.push(`visit ${v.day}${v.time ? ` ${v.time}` : ''}`);
  else if (v.time) parts.push(`visit time ${v.time}`);

  if (parts.length === 0) {
    return {
      response: `जी, अभी तक आपने कोई specific requirement नहीं बताई — बताइए कौन सा BHK और budget देख रहे हैं?`,
      used: false,
    };
  }
  return { response: `जी, आपने बताया था — ${parts.join(', ')}।`, used: true };
}

// ─── Missing-Field Logic (never re-ask captured fields) ───────────────────────

/**
 * Decide the follow-up clause to append after a fact answer.
 *
 * Returns the question text ONLY when the relevant field is still missing, so a
 * captured preference is never re-asked. An empty string means "append nothing".
 * `reused` is true when we deliberately suppressed a question because the field
 * was already captured (caller logs SESSION_FIELD_REUSED).
 *
 * Only PRICE and BHK fact answers carry a slot-filling follow-up; every other
 * intent returns no follow-up here (its template stands alone).
 */
export function factFollowUp(
  intent: string,
  v: Pick<PreferenceValues, 'budget' | 'bhk'>,
): { clause: string; reused: boolean; field?: 'budget' | 'bhk' } {
  if (intent === 'PRICE') {
    return v.budget
      ? { clause: '', reused: true, field: 'budget' }
      : { clause: 'आप किस budget range में देख रहे हैं?', reused: false, field: 'budget' };
  }
  if (intent === 'BHK') {
    return v.bhk
      ? { clause: '', reused: true, field: 'bhk' }
      : { clause: 'आप किस configuration में interested हैं?', reused: false, field: 'bhk' };
  }
  return { clause: '', reused: false };
}

// ─── Budget Parsing (digits + Hindi/English number words) ────────────────────

/**
 * Number WORDS → digits, for budgets spoken as words. STT routinely returns
 * "पचास लाख" / "fifty lakh" rather than "50 lakh". Covers the realistic
 * real-estate range (40 lakh – 3 crore) in Hindi (Devanagari) and English.
 */
const NUM_WORDS: Record<string, string> = {
  forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90',
  hundred: '100', one: '1', 'one-and-half': '1.5', two: '2', three: '3',
  'चालीस': '40', 'पैंतालीस': '45', 'पचास': '50', 'पचपन': '55', 'साठ': '60',
  'पैंसठ': '65', 'सत्तर': '70', 'पचहत्तर': '75', 'अस्सी': '80', 'पचासी': '85',
  'नब्बे': '90', 'नब्बई': '90', 'पंचानवे': '95', 'सौ': '100',
  'एक': '1', 'डेढ़': '1.5', 'दो': '2', 'ढाई': '2.5', 'तीन': '3',
};

const UNIT_CRORE = /cr|crore|करोड़/;

/**
 * Parse a budget mention from a (lowercased) utterance. Handles both digit
 * forms ("50 lakh", "1.5 crore") and number words ("पचास लाख", "fifty lakh",
 * "डेढ़ करोड़"). Returns a normalised "<n> lakh|crore" string, or null if none.
 * Pure — no env, no SessionState.
 */
export function parseBudget(lower: string): string | null {
  // 1. Digit form.
  const m = lower.match(/\b(\d{1,3}(?:\.\d{1,2})?)\s*(lakh|lakhs|lac|crore|cr|करोड़|लाख)\b/);
  if (m) return `${m[1]} ${UNIT_CRORE.test(m[2]) ? 'crore' : 'lakh'}`;

  // 2. Number-word form.
  const wm = lower.match(/([ऀ-ॿ]+|[a-z]+(?:-[a-z]+)*)\s*(lakh|lakhs|lac|crore|cr|करोड़|लाख)\b/);
  if (wm) {
    const digits = NUM_WORDS[wm[1]];
    if (digits) return `${digits} ${UNIT_CRORE.test(wm[2]) ? 'crore' : 'lakh'}`;
  }
  return null;
}

// ─── Scheduling Preference Recap ──────────────────────────────────────────────

/**
 * One-line natural recap of captured preferences for the scheduling flow, e.g.
 * "आप 3 BHK, budget around 80 lakh dekh rahe the — ". Returns '' when nothing is
 * captured. The caller is responsible for using it only ONCE per call.
 */
export function buildSchedulingRecap(v: Pick<PreferenceValues, 'bhk' | 'budget'>): string {
  const bits: string[] = [];
  if (v.bhk) bits.push(v.bhk);
  if (v.budget) bits.push(`budget around ${v.budget}`);
  if (bits.length === 0) return '';
  return `आप ${bits.join(', ')} dekh rahe the — `;
}
