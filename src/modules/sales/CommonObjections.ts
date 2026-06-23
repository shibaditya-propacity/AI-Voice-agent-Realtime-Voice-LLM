/**
 * CommonObjections: deterministic objection-handling playbooks.
 *
 * Pattern: Acknowledge → Provide value → Soft guide
 *
 * Rules:
 *  - Never immediately push for site visit.
 *  - Acknowledge the concern first.
 *  - Provide a value perspective.
 *  - Softly guide the conversation forward.
 *  - Max 2 sentences, 20 words each.
 */

// ─── Objection Types ────────────────────────────────────────────────────────

export type ObjectionType =
  | 'expensive'
  | 'not_interested'
  | 'exploring_others'
  | 'family_approval'
  | 'need_info'
  | 'busy_now'
  | 'call_later';

// ─── Objection Detection ────────────────────────────────────────────────────

interface ObjectionRule {
  type: ObjectionType;
  pattern: RegExp;
}

const OBJECTION_RULES: ObjectionRule[] = [
  {
    type: 'expensive',
    pattern: /\b(expensive|costly|mehnga|महंगा|zyada\s*(?:hai|lag)|too\s*(?:much|high)|over\s*budget|budget\s*(?:se\s*)?(?:zyada|bahar|upar)|out\s*of\s*(?:budget|range)|afford|सस्ता\s*(?:nahi|नहीं))\b/i,
  },
  {
    type: 'not_interested',
    pattern: /\b(not\s*interested|interested\s*nahi|nahi\s*chahiye|don'?t\s*want|no\s*thanks|nahi\s*ji|रुचि\s*नहीं)\b/i,
  },
  {
    type: 'exploring_others',
    pattern: /\b(other\s*(?:projects?|options?|properties)|compare|comparison|alternatives?|dekh\s*raha|aur\s*(?:bhi\s*)?dekh|doosra|दूसरा|comparing|explore)\b/i,
  },
  {
    type: 'family_approval',
    pattern: /\b(family|wife|husband|parents?|father|mother|spouse|ghar\s*(?:mein|pe|wale)|parivar|परिवार|discuss|baat\s*kar|पत्नी|पति|माता|पिता)\b/i,
  },
  {
    type: 'need_info',
    pattern: /\b(more\s*(?:info|details?|information)|aur\s*(?:batao|jaankari)|details?\s*(?:chahiye|do)|send|email|whatsapp|brochure|ज़्यादा\s*जानकारी)\b/i,
  },
  {
    type: 'busy_now',
    pattern: /\b(busy|abhi\s*nahi|not\s*(?:now|right\s*now)|can'?t\s*talk|time\s*nahi|व्यस्त|अभी\s*नहीं|meeting\s*mein|driving)\b/i,
  },
  {
    type: 'call_later',
    pattern: /\b(call\s*(?:back|later|baad)|later|baad\s*mein|phir\s*(?:se\s*)?call|बाद\s*में|फिर\s*से|kal\s*call|tomorrow\s*call)\b/i,
  },
];

// ─── Objection Playbooks ────────────────────────────────────────────────────

interface Playbook {
  /** Multiple response variants rotated by turn index. */
  responses: string[];
}

const PLAYBOOKS: Record<ObjectionType, Playbook> = {
  expensive: {
    responses: [
      'Samajh sakta hoon. Project dekhne par value better evaluate kar paayenge.',
      'Budget important hai. Configuration options mein flexibility hai, discuss kar sakte hain.',
      'Bilkul, investment soch ke karni chahiye. Pricing breakdown mein detail milega.',
    ],
  },

  not_interested: {
    responses: [
      'Koi baat nahi. Agar future mein kuch explore karna ho toh bata dijiye.',
      'Theek hai. Agar koi specific requirement ho toh help kar sakta hoon.',
      'Samajh gaya. Koi sawaal ho toh kabhi bhi reach out kar sakte hain.',
    ],
  },

  exploring_others: {
    responses: [
      'Bilkul, comparison zaroori hai. Agar koi specific cheez compare karni ho toh bataiye.',
      'Sahi approach hai. Jab comparison karein toh location aur possession timeline zaroor dekhiyega.',
      'Haan, options dekhna zaroori hai. Koi specific parameter hai jo aapke liye important hai?',
    ],
  },

  family_approval: {
    responses: [
      'Bilkul. Family ke saath visit karenge toh decision lena aasaan rahega.',
      'Haan, family ki raay important hai. Saath mein aayenge toh accha rahega.',
      'Zaroor, family ke saath discuss kariye. Koi sawaal ho toh main available hoon.',
    ],
  },

  need_info: {
    responses: [
      'Zaroor, kaunsi information chahiye specifically? Main abhi bata sakta hoon.',
      'Bilkul. Kya details chahiye aapko — pricing, floor plan, ya kuch aur?',
      'Haan, main details share kar sakta hoon. Kya specific jaanna chahte hain?',
    ],
  },

  busy_now: {
    responses: [
      'Koi baat nahi. Kab convenient hoga aapke liye baat karna?',
      'Theek hai. Main baad mein call kar sakta hoon, kab accha rahega?',
      'Samajh gaya. Aapka convenient time bataiye, main call karunga.',
    ],
  },

  call_later: {
    responses: [
      'Bilkul. Kab call karun — kal morning ya evening?',
      'Theek hai. Kal ya parson, kab accha rahega aapke liye?',
      'Zaroor. Aapka preferred time bataiye, call schedule kar leta hoon.',
    ],
  },
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Detect the specific objection type from user text.
 * Returns null if no known objection pattern matches.
 */
export function detectObjection(userText: string): ObjectionType | null {
  const lower = userText.toLowerCase().trim();

  for (const { type, pattern } of OBJECTION_RULES) {
    if (pattern.test(lower)) return type;
  }

  return null;
}

/**
 * Get the deterministic playbook response for an objection.
 * Rotates through variants by turn index.
 */
export function getObjectionResponse(
  objection: ObjectionType,
  turnIndex: number = 0,
): string {
  const playbook = PLAYBOOKS[objection];
  return playbook.responses[turnIndex % playbook.responses.length];
}

/**
 * Try to handle an objection deterministically.
 * Returns the response string or null if it's not a recognized objection.
 */
export function handleObjection(
  userText: string,
  turnIndex: number = 0,
): string | null {
  const objection = detectObjection(userText);
  if (!objection) return null;
  return getObjectionResponse(objection, turnIndex);
}
