/**
 * CommonObjections: detects and responds to common sales objections.
 *
 * Self-contained module — no dependency on property facts.
 * Provides canned empathetic responses for frequent objections
 * so the LLM doesn't need to improvise (faster + more consistent).
 */

// ─── Objection Types ────────────────────────────────────────────────────────

export type ObjectionType =
  | 'PRICE_HIGH'
  | 'LOCATION_FAR'
  | 'BUILDER_TRUST'
  | 'POSSESSION_DELAY'
  | 'RESALE_BETTER'
  | 'NEED_TIME'
  | 'ALREADY_BOOKED'
  | 'COMPETITOR_COMPARISON'
  | 'HIDDEN_CHARGES'
  | 'FLAT_SIZE_SMALL';

// ─── Detection Patterns ─────────────────────────────────────────────────────

interface ObjectionRule {
  type: ObjectionType;
  patterns: RegExp[];
}

const OBJECTION_RULES: ObjectionRule[] = [
  {
    type: 'PRICE_HIGH',
    patterns: [
      /\b(expensive|costly|mehenga|महंगा|zyada|ज़्यादा|over\s*budget|budget\s*se\s*zyada|too\s*much|bahut\s*zyada|बहुत\s*ज़्यादा)\b/i,
      /\b(discount|offer|kam\s*kar|कम\s*कर|negotiate|negotiation|price\s*kam|rate\s*kam)\b/i,
    ],
  },
  {
    type: 'LOCATION_FAR',
    patterns: [
      /\b(far|door|दूर|bahut\s*door|बहुत\s*दूर|location\s*acch[ia]\s*nahi|location\s*not\s*good|connectivity\s*issue)\b/i,
      /\b(traffic|jam|commute\s*time|travel\s*time|too\s*far\s*from)\b/i,
    ],
  },
  {
    type: 'BUILDER_TRUST',
    patterns: [
      /\b(trust|bharosa|भरोसा|reliable|reputation|fraud|scam|cheat|dhoka|धोखा|unknown\s*builder|new\s*builder|suna\s*nahi)\b/i,
    ],
  },
  {
    type: 'POSSESSION_DELAY',
    patterns: [
      /\b(delay|late|der|देर|possession\s*late|time\s*pe\s*nahi|on\s*time\s*nahi|kab\s*milega\s*sach|stuck|incomplete)\b/i,
    ],
  },
  {
    type: 'RESALE_BETTER',
    patterns: [
      /\b(resale|second\s*hand|purana|पुराना|ready\s*possession|immediate|abhi\s*mil\s*jaye|अभी\s*मिल\s*जाए|ready\s*to\s*move)\b/i,
    ],
  },
  {
    type: 'NEED_TIME',
    patterns: [
      /\b(time|sochna|सोचना|think|soch\s*ke\s*bata|सोच\s*के\s*बता|decide\s*nahi|not\s*sure|confuse|confused|later|baad\s*mein|बाद\s*में)\b/i,
      /\b(discuss\s*with\s*family|family\s*se\s*puch|फ़ैमिली\s*से\s*पूछ|wife\s*se|husband\s*se|parents\s*se)\b/i,
    ],
  },
  {
    type: 'ALREADY_BOOKED',
    patterns: [
      /\b(already\s*booked|already\s*bought|le\s*liya|ले\s*लिया|kharid\s*liya|ख़रीद\s*लिया|somewhere\s*else|doosra|दूसरा)\b/i,
    ],
  },
  {
    type: 'COMPETITOR_COMPARISON',
    patterns: [
      /\b(compare|comparison|versus|vs\.?|better\s*than|worse\s*than|other\s*project|doosra\s*project|दूसरा\s*project|competitor)\b/i,
    ],
  },
  {
    type: 'HIDDEN_CHARGES',
    patterns: [
      /\b(hidden\s*charge|extra\s*charge|chhupa|छुपा|additional\s*cost|surprise\s*charge|baad\s*mein\s*paisa|बाद\s*में\s*पैसा)\b/i,
    ],
  },
  {
    type: 'FLAT_SIZE_SMALL',
    patterns: [
      /\b(small|chhota|छोटा|tight|compact|space\s*kam|कम\s*space|size\s*kam|cramped)\b/i,
    ],
  },
];

// ─── Detection ──────────────────────────────────────────────────────────────

/**
 * Detects which objection type (if any) is present in the user's text.
 * Returns null if no objection is detected.
 */
export function detectObjection(text: string): ObjectionType | null {
  const trimmed = text.trim();
  for (const rule of OBJECTION_RULES) {
    for (const pat of rule.patterns) {
      if (pat.test(trimmed)) {
        return rule.type;
      }
    }
  }
  return null;
}

// ─── Response Templates ─────────────────────────────────────────────────────

const OBJECTION_RESPONSES: Record<ObjectionType, string[]> = {
  PRICE_HIGH: [
    'मैं समझता हूँ budget important है। लेकिन अगर आप per sq ft rate देखें तो ये area में काफ़ी competitive है, plus 20:80 payment plan है तो एक साथ पूरा amount नहीं देना।',
    'सही कह रहे हैं, investment बड़ा है। लेकिन metro के पास ये rate बहुत अच्छा है, और home loan भी pre-approved है — EMI काफ़ी manageable आती है।',
  ],
  LOCATION_FAR: [
    'Actually Pimple Gurav metro station 5 minute walk पर है, और Hinjewadi IT Park 20 minute में — connectivity बहुत improve हुई है। एक बार site visit करो तो idea लग जाएगा।',
    'ये area अभी developing है, इसीलिए rates भी reasonable हैं। Metro connectivity आ गई है, 2-3 साल में ये Pune का prime area बनेगा।',
  ],
  BUILDER_TRUST: [
    'R.R. Lunkad group Pune में 30 साल से है, 50 से ज़्यादा projects deliver कर चुके हैं — RERA registered है, सब approvals in place हैं। आप चाहो तो हम RERA details share कर सकते हैं।',
    'Valid concern है, trust important है। Lunkad group का track record Pune में बहुत strong है — 30+ years, 50+ completed projects। Site visit पर आओगे तो construction quality भी देख सकते हो।',
  ],
  POSSESSION_DELAY: [
    'Project RERA registered है तो timeline legally binding है। Construction तेज़ी से चल रहा है — 4th floor slab complete हो गया है। Site visit करो तो progress अपनी आँखों से देख सकते हो।',
    'समझता हूँ, delay की tension सबको होती है। लेकिन RERA registered project है, construction on track है, और builder का history of on-time delivery है।',
  ],
  RESALE_BETTER: [
    'Resale में ready possession मिलता है, ये बात सही है। लेकिन new construction में latest design, fresh amenities, और 20:80 plan मिलता है — plus resale में loan issues और documentation problems हो सकते हैं।',
    'New project में RERA protection, modern amenities, EV charging, और 20:80 payment plan — resale में ये सब नहीं मिलता। Plus builder warranty भी मिलती है।',
  ],
  NEED_TIME: [
    'Bilkul, take your time — ये बड़ा decision है। लेकिन एक suggestion — site visit कर लो तो decide करना easy हो जाएगा। Seeing is believing!',
    'सही है, soch samajh ke decision लो। बस ये ध्यान रखो कि limited units हैं और rates बढ़ रहे हैं — site visit no commitment है, बस एक बार देख लो।',
  ],
  ALREADY_BOOKED: [
    'बहुत बढ़िया, congratulations! अगर कभी investment purpose से कोई और property देखना हो तो बताना — Pune में real estate अच्छा return दे रहा है।',
    'अच्छा, congratulations! कोई बात नहीं, अगर future में investment के लिए सोचो तो contact में रहना।',
  ],
  COMPETITOR_COMPARISON: [
    'हर project की अपनी strengths हैं। लेकिन metro walking distance, R.R. Lunkad trust, vastu compliant design, और no common wall — ये combination rare है। एक बार compare करके देखो site visit पर।',
    'Comparison ज़रूरी है, smart decision है। Main advantages — metro proximity, established builder, 20:80 plan, और modern amenities। Site visit करोगे तो clear picture मिलेगी।',
  ],
  HIDDEN_CHARGES: [
    'कोई hidden charges नहीं हैं — stamp duty 6%, registration 1%, GST 5% — ये standard government charges हैं। बाकी flat price में parking included है। Full cost breakup site visit पर मिल जाएगा।',
    'पूरी transparency — stamp duty, registration, GST — सब upfront बता देते हैं। One covered parking included है price में। Site visit पर detailed cost sheet दे देंगे।',
  ],
  FLAT_SIZE_SMALL: [
    'Actually RERA carpet area है ये — real usable space। 2 BHK 650-700 sq ft, 3 BHK 950-1050 sq ft carpet — layout बहुत efficient है, एक बार site visit पर sample flat देखो तो space का idea लग जाएगा।',
    'Carpet area में ये काफ़ी spacious है — no common wall design से extra space feel आता है, plus बड़े balconies हैं। Site visit करो तो feel कर पाओगे।',
  ],
};

/**
 * Gets a response for a specific objection type.
 * Randomly picks from available responses for variety.
 */
export function getObjectionResponse(type: ObjectionType): string {
  const responses = OBJECTION_RESPONSES[type];
  const idx = Math.floor(Math.random() * responses.length);
  return responses[idx];
}

/**
 * Convenience: detect + respond in one call.
 * Returns null if no objection detected.
 */
export function handleObjection(text: string): { type: ObjectionType; response: string } | null {
  const type = detectObjection(text);
  if (!type) return null;
  return { type, response: getObjectionResponse(type) };
}
