/**
 * KnowledgeRouter: deterministic zero-LLM-token fact answering layer.
 *
 * Intercepts factual questions about the property and returns pre-built
 * conversational responses directly — bypassing LLM entirely. This eliminates
 * token usage, removes hallucination risk, and cuts latency to near-zero for
 * ~80% of inbound questions.
 *
 * The LLM is only invoked for:
 *   - Open-ended / conversational questions
 *   - Objections and comparisons
 *   - Visit scheduling dialogue
 *   - Anything not in PROPERTY_FACTS
 */

import { PROPERTY_FACTS } from './PropertyFacts';
import { Logger } from '../shared/logger';
import type { SessionState } from '../orchestration/SessionState';
import { factFollowUp } from '../orchestration/PreferenceRecall';

// ─── Fact Intent Classification ──────────────────────────────────────────────

export type FactIntent =
  | 'PRICE'
  | 'PRICE_BHK'
  | 'LOCATION'
  | 'LANDMARKS'
  | 'AMENITIES'
  | 'BHK'
  | 'CARPET_AREA'
  | 'POSSESSION'
  | 'CONSTRUCTION_STATUS'
  | 'BUILDER'
  | 'UNITS'
  | 'PROJECT_NAME'
  | 'PAYMENT_PLAN'
  | 'BOOKING_AMOUNT'
  | 'LOAN'
  | 'PARKING'
  | 'RERA'
  | 'STAMP_DUTY'
  | 'USP'
  | 'SITE_VISIT_INFO'
  | 'SECURITY'
  | 'FLOOR_TOWER';

interface IntentRule {
  intent: FactIntent;
  patterns: RegExp[];
}

// Rules are tested in order — more specific intents must appear before generic ones.
const INTENT_RULES: IntentRule[] = [
  // ── Booking Amount (before PRICE — "booking amount" must not match generic PRICE) ─
  {
    intent: 'BOOKING_AMOUNT',
    patterns: [
      /\b(booking\s*amount|token|token\s*money|advance|kitna\s*dena|कितना\s*देना|initial\s*amount|upfront)\b/i,
    ],
  },
  // ── Price by BHK (must be before generic PRICE) ──────────────────────
  {
    intent: 'PRICE_BHK',
    patterns: [
      /\b(2\.?5?|3|two|three)\s*bhk\b[^?]*\b(price|cost|kitna|kitne|कितना|कितने|कीमत|दाम|rate|budget|amount)\b/i,
      /\b(price|cost|kitna|kitne|कितना|कितने|कीमत|दाम|rate)\b[^?]*\b(2\.?5?|3|two|three)\s*bhk\b/i,
      /\b(2\.?5?|3|two|three)\s*bhk\b[^?]*\b(ka|ki|ke|का|की|के)\b/i,
    ],
  },
  // ── Generic Price ────────────────────────────────────────────────────
  {
    intent: 'PRICE',
    patterns: [
      /\b(price|pricing|cost|rate|budget|kitna|kitne|कितना|कितने|कीमत|दाम|paisa|पैसा|per\s*sq\s*ft|sqft|square\s*feet|वर्ग\s*फ़ीट|वर्गफीट|वर्गफुट)\b/i,
      /(?:कितने|kitne|kitna|कितना)\s*(?:का|ki|में|mein|me)/i,
    ],
  },
  // ── Carpet Area / Size ──────────────────────────────────────────────
  {
    intent: 'CARPET_AREA',
    patterns: [
      /\b(carpet\s*area|built\s*up|super\s*built|size|area|kitna\s*bada|कितना\s*बड़ा|sq\s*ft|sqft|square\s*feet|kitne\s*sq|flat\s*size|apartment\s*size)\b/i,
    ],
  },
  // ── Landmarks / Nearby ──────────────────────────────────────────────
  {
    intent: 'LANDMARKS',
    patterns: [
      /\b(nearby|near\b(?!\s*\d)|around\s+(?:here|property|area|project|society|building|locality|the\s+(?:property|area|project))|paas|पास|aas\s*paas|आसपास|landmark|school|hospital|metro|station|highway|expressway|mall|market|college|connectivity|connect|transport|commute|IT\s*park|hinjewadi)\b/i,
      /\b(kya\s*hai\s*nearby|आसपास\s*क्या\s*है|paas\s*mein\s*kya)\b/i,
    ],
  },
  // ── Location ────────────────────────────────────────────────────────
  {
    intent: 'LOCATION',
    patterns: [
      /\b(location|where|kahan|कहाँ|कहां|address|area|place|jagah|जगह|situated|sthit|स्थित|kidhar|किधर)\b/i,
      /(?:project|property)\s+(?:kahan|kidhar|where|कहाँ|कहां)/i,
    ],
  },
  // ── Amenities ──────────────────────────────────────────────────────
  {
    intent: 'AMENITIES',
    patterns: [
      /\b(ameniti|amenity|amenities|facilities|facility|features?|suvidha|सुविधा|सुविधाएं|सुविधाएँ|gym|pool|swimming|garden|club\s*house|ev\s*charg|kids?\s*zone|play\s*area|joggin|walking\s*track)\b/i,
    ],
  },
  // ── Parking ────────────────────────────────────────────────────────
  {
    intent: 'PARKING',
    patterns: [
      /\b(parking|car\s*park|gaadi|गाड़ी|two\s*wheeler|bike\s*park|covered\s*park|open\s*park|basement)\b/i,
    ],
  },
  // ── Security ──────────────────────────────────────────────────────
  {
    intent: 'SECURITY',
    patterns: [
      /\b(security|safe|safety|cctv|guard|suraksha|सुरक्षा|watchman|surveillance)\b/i,
    ],
  },
  // ── BHK / Configuration ────────────────────────────────────────────
  {
    intent: 'BHK',
    patterns: [
      /\b(bhk|configuration|config|layout|flat\s*type|apartment\s*type|kitne\s*bhk|कितने\s*bhk|floor\s*plan)\b/i,
      /(?:kaun|कौन)\s*(?:se|से)\s*(?:bhk|flat|apartment)/i,
    ],
  },
  // ── Floor / Tower ─────────────────────────────────────────────────
  {
    intent: 'FLOOR_TOWER',
    patterns: [
      /\b(floor|tower|manzil|मंज़िल|kitne\s*floor|कितने\s*floor|how\s*many\s*floor|storey|story|building)\b/i,
    ],
  },
  // ── Construction Status ───────────────────────────────────────────
  {
    intent: 'CONSTRUCTION_STATUS',
    patterns: [
      /\b(construction|kahan\s*tak\s*ban|कहाँ\s*तक\s*बन|kitna\s*ban|कितना\s*बन|progress|status|slab|work\s*start|kaam\s*shuru|काम\s*शुरू)\b/i,
    ],
  },
  // ── Possession ────────────────────────────────────────────────────
  {
    intent: 'POSSESSION',
    patterns: [
      /\b(possession|handover|ready|complete|completion|deliver|कब\s*मिलेगा|kab\s*milega|move\s*in|ready\s*to\s*move|under\s*construction)\b/i,
      /(?:kab|कब)\s+(?:tak|तक|ready|milega|मिलेगा|complete|banega|बनेगा)/i,
    ],
  },
  // ── Payment Plan ──────────────────────────────────────────────────
  {
    intent: 'PAYMENT_PLAN',
    patterns: [
      /\b(payment\s*plan|payment\s*schedule|kaise\s*pay|कैसे\s*pay|instalment|installment|emi\s*plan|construction\s*linked|milestone|20.*80|down\s*payment)\b/i,
    ],
  },
  // ── Loan / Finance ────────────────────────────────────────────────
  {
    intent: 'LOAN',
    patterns: [
      /\b(loan|home\s*loan|finance|emi|bank\s*loan|sbi|hdfc|icici|axis|bank\s*se|बैंक\s*से|pre\s*approved|loan\s*available|loan\s*milega)\b/i,
    ],
  },
  // ── RERA ──────────────────────────────────────────────────────────
  {
    intent: 'RERA',
    patterns: [
      /\b(rera|registration\s*number|registered|legal|approval|permission|govt\s*approv|सरकारी\s*मंज़ूरी)\b/i,
    ],
  },
  // ── Stamp Duty / Registration / GST / Taxes ──────────────────────
  {
    intent: 'STAMP_DUTY',
    patterns: [
      /\b(stamp\s*duty|registration\s*charge|gst|tax|government\s*charge|extra\s*charge|hidden\s*charge|additional\s*cost|other\s*charge|total\s*cost|kitna\s*extra|कितना\s*extra|sarkari|सरकारी)\b/i,
    ],
  },
  // ── Builder ───────────────────────────────────────────────────────
  {
    intent: 'BUILDER',
    patterns: [
      /\b(builder|developer|company|firm|kisne\s*banaya|किसने\s*बनाया|kaun\s*sa\s*builder|कौन\s*सा\s*builder|group|promoter|lunkad)\b/i,
    ],
  },
  // ── Units ─────────────────────────────────────────────────────────
  {
    intent: 'UNITS',
    patterns: [
      /\b(units?|total\s*flats?|kitne\s*flat|कितने\s*flat|how\s*many\s*flat|apartments?\s*available|flats?\s*available|total\s*apartments?)\b/i,
    ],
  },
  // ── Project Name ──────────────────────────────────────────────────
  {
    intent: 'PROJECT_NAME',
    patterns: [
      /\b(project\s*name|naam|नाम|konsa\s*project|कौनसा\s*project|which\s*project|project\s*ka\s*naam)\b/i,
    ],
  },
  // ── USP / Why This Project ────────────────────────────────────────
  {
    intent: 'USP',
    patterns: [
      /\b(usp|special|kya\s*khaas|क्या\s*ख़ास|क्या\s*खास|unique|different|alag|अलग|why\s*this|best\s*thing|highlight|advantage|fayda|फ़ायदा|फायदा|vastu)\b/i,
    ],
  },
  // ── Site Visit Info ───────────────────────────────────────────────
  {
    intent: 'SITE_VISIT_INFO',
    patterns: [
      /\b(site\s*visit\s*address|kahan\s*aana|कहाँ\s*आना|office\s*address|site\s*address|timing|kab\s*aa\s*sakte|कब\s*आ\s*सकते|open\s*on\s*sunday|sunday\s*open|sample\s*flat|model\s*flat)\b/i,
    ],
  },
];

// ─── Response Templates ──────────────────────────────────────────────────────
// Conversational Hindi/Hinglish responses — fact + natural follow-up.

function pick<T>(arr: T[], seed: number): T { return arr[seed % arr.length]; }

function buildResponse(intent: FactIntent, seed = 0): string {
  switch (intent) {
    case 'PRICE':
      return pick([
        `${PROPERTY_FACTS.project} में price roughly ${PROPERTY_FACTS.pricePerSqft} है, overall range ${PROPERTY_FACTS.priceRange} तक है। Segment mein ye competitive pricing hai.`,
        `कीमत की बात करें तो ${PROPERTY_FACTS.priceRange} range है — per square feet ${PROPERTY_FACTS.pricePerSqft} के आसपास। Is area mein yeh bahut reasonable pricing hai.`,
        `${PROPERTY_FACTS.project} का price range ${PROPERTY_FACTS.priceRange} है, per sqft roughly ${PROPERTY_FACTS.pricePerSqft}। Quality aur location ke hisab se bahut value-for-money hai.`,
      ], seed);

    case 'PRICE_BHK': {
      const lines = Object.entries(PROPERTY_FACTS.configs)
        .map(([bhk, c]) => `${bhk} starting ${c.startingPrice} से`)
        .join(', ');
      return pick([
        `${lines} — carpet area और floor के हिसाब से vary करता है। Budget flexibility ke liye multiple configurations hain.`,
        `BHK के हिसाब से price है: ${lines}। Floor aur view ke hisab se thoda adjust hota hai.`,
        `${lines} — exact price carpet area aur floor par depend karta hai, lekin options kaafi flexible hain.`,
      ], seed);
    }

    case 'CARPET_AREA': {
      const lines = Object.entries(PROPERTY_FACTS.configs)
        .map(([bhk, c]) => `${bhk}: ${c.carpetArea}`)
        .join(', ');
      return pick([
        `Carpet area — ${lines}। सब RERA carpet area है, no hidden super built-up — jo dikhta hai wahi milta hai.`,
        `Size की बात करें — ${lines}। RERA carpet area है यानी कोई hidden charges नहीं, पूरा transparent है।`,
        `${lines} — ye sab RERA certified carpet area hai. Jo measure dikhaya jaata hai wahi exactly milta hai.`,
      ], seed);
    }

    case 'LOCATION':
      return pick([
        `${PROPERTY_FACTS.project} ${PROPERTY_FACTS.location} में है — Pimple Gurav Metro Station से बस 5 minute walk। Daily commute ke liye bahut convenient location hai.`,
        `Location है ${PROPERTY_FACTS.location}, Pune — metro station बस 5 minute पैदल है। IT hubs और schools सब आसपास हैं।`,
        `${PROPERTY_FACTS.project} Pimple Gurav, Pune में है। Metro connectivity बेहद अच्छी है — Hinjewadi और city दोनों तरफ़ easily पहुँच सकते हैं।`,
      ], seed);

    case 'LANDMARKS':
      return pick([
        `${PROPERTY_FACTS.landmarks.slice(0, 4).join(', ')} — connectivity काफ़ी अच्छी है। Hinjewadi IT Park भी 20 minute में पहुँच जाओगे।`,
        `आसपास ${PROPERTY_FACTS.landmarks.slice(0, 3).join(', ')} सब हैं। Daily life के लिए सब कुछ नज़दीक है।`,
        `Nearby — ${PROPERTY_FACTS.landmarks.slice(0, 4).join(', ')}। Location practically bahut convenient hai.`,
      ], seed);

    case 'AMENITIES':
      return pick([
        `Gym, swimming pool, clubhouse, kids zone, EV charging, jogging track — सब कुछ available है। Family living ke liye bahut balanced setup hai.`,
        `Amenities में gym, pool, clubhouse, kids play area, EV charging, aur jogging track हैं। Active aur comfortable lifestyle ke liye sab कुछ hai.`,
        `यहाँ gym, swimming pool, clubhouse, kids zone, EV charging — complete package मिलती है। Family ke saath rehne ke liye ideal setup hai.`,
      ], seed);

    case 'PARKING':
      return pick([
        `One covered parking हर flat के साथ included है price में। Additional open parking ${PROPERTY_FACTS.parking.additional} में, और two-wheeler parking free — parking ki koi tension nahi.`,
        `Covered parking हर unit में included है। Two-wheeler parking free है, additional open parking भी available है ${PROPERTY_FACTS.parking.additional} में।`,
        `Parking की कोई tension नहीं — हर flat के साथ covered parking आती है price में। Two-wheeler parking bhi free hai.`,
      ], seed);

    case 'SECURITY':
      return pick([
        `${PROPERTY_FACTS.amenitiesDetailed.security} — plus intercom facility हर flat में। Round-the-clock security hai, family ke liye peaceful environment.`,
        `Security बहुत अच्छी है — 24/7 CCTV, trained guards, और हर flat में intercom है। Family ke liye safe aur peaceful community hai.`,
        `24 घंटे security है, CCTV surveillance के साथ। Intercom हर flat में है — peaceful aur safe living environment hai.`,
      ], seed);

    case 'BHK':
      return pick([
        `${PROPERTY_FACTS.project} में ${PROPERTY_FACTS.bhk.join(', ')} BHK options available हैं। Har family size ke liye suitable configuration mil jayega.`,
        `यहाँ ${PROPERTY_FACTS.bhk.join(', ')} BHK के options हैं। Small family से लेकर larger family तक — सबके लिए कुछ न कुछ है।`,
        `${PROPERTY_FACTS.bhk.join(', ')} BHK configurations available हैं ${PROPERTY_FACTS.project} में। आपकी family size और requirement के हिसाब से choose कर सकते हैं।`,
      ], seed);

    case 'FLOOR_TOWER':
      return pick([
        `Total ${PROPERTY_FACTS.towers} towers हैं, हर tower ${PROPERTY_FACTS.totalFloors} floors का। हर tower में 2 high-speed lifts हैं — waiting nahi karni padegi.`,
        `${PROPERTY_FACTS.towers} towers हैं, ${PROPERTY_FACTS.totalFloors} floors each। 2 high-speed lifts per tower — daily आने-जाने में कोई delay नहीं।`,
        `Tower structure में ${PROPERTY_FACTS.towers} towers हैं — हर tower में ${PROPERTY_FACTS.totalFloors} floors और 2 high-speed lifts। Very well planned layout है।`,
      ], seed);

    case 'CONSTRUCTION_STATUS':
      return pick([
        `${PROPERTY_FACTS.constructionStatus}। Kaam tezi se chal raha hai — possession ${PROPERTY_FACTS.possession} mein expected hai.`,
        `Construction अच्छी तरह progress में है। ${PROPERTY_FACTS.possession} तक possession expected है — timeline बिल्कुल track पर है।`,
        `${PROPERTY_FACTS.constructionStatus} — possession ${PROPERTY_FACTS.possession} में मिलने की पूरी उम्मीद है। RERA registration से accountability भी है।`,
      ], seed);

    case 'POSSESSION':
      return pick([
        `Possession ${PROPERTY_FACTS.possession} में expected है — RERA registered hone se possession date pe poori accountability hai.`,
        `${PROPERTY_FACTS.possession} तक possession मिलने की उम्मीद है। RERA registration होने से date reliable है।`,
        `Possession ${PROPERTY_FACTS.possession} में है। Project RERA registered है तो possession timeline पर पूरी accountability है।`,
      ], seed);

    case 'PAYMENT_PLAN':
      return pick([
        `${PROPERTY_FACTS.paymentPlan}। Booking par sirf 20% dena hoga, baaki possession ke time — financial pressure kam rehta hai.`,
        `Payment plan काफ़ी flexible है — booking पर 20%, बाकी construction के साथ linked। EMI का pressure नहीं पड़ता।`,
        `${PROPERTY_FACTS.paymentPlan} — यानी पूरा एक साथ नहीं देना। Construction-linked होने से cashflow manage करना आसान है।`,
      ], seed);

    case 'BOOKING_AMOUNT':
      return pick([
        `Booking amount सिर्फ ${PROPERTY_FACTS.bookingAmount} है — flat lock ho jayega aur baaki construction-linked plan pe aayega.`,
        `${PROPERTY_FACTS.bookingAmount} में flat book हो जाता है। बाकी payment construction-linked plan पर आती है।`,
        `Sirf ${PROPERTY_FACTS.bookingAmount} se shuruat hoti hai booking ki. Flat lock hoga aur baaki installments me pay kar sakte hain.`,
      ], seed);

    case 'LOAN':
      return pick([
        `Home loan pre-approved है ${PROPERTY_FACTS.preApprovedBanks.join(', ')} से। Documentation mein hamari team full help karegi — process bahut smooth hai.`,
        `${PROPERTY_FACTS.preApprovedBanks.join(', ')} — इन banks से home loan pre-approved है। हमारी team documentation में पूरा साथ देती है।`,
        `Major banks से pre-approved loan है — ${PROPERTY_FACTS.preApprovedBanks.join(', ')}। Loan process में हमारी team guide करती है, आपको ज़्यादा tension नहीं लेनी।`,
      ], seed);

    case 'RERA':
      return pick([
        `Project RERA registered है — number ${PROPERTY_FACTS.reraNumber}। Sab government approvals in place hain, investment bilkul safe hai.`,
        `RERA number ${PROPERTY_FACTS.reraNumber} है — सभी government approvals complete हैं। Investment completely protected है।`,
        `हाँ, project RERA registered है (${PROPERTY_FACTS.reraNumber})। सब approvals in order हैं — बिल्कुल safe investment है।`,
      ], seed);

    case 'STAMP_DUTY':
      return pick([
        `Stamp duty ${PROPERTY_FACTS.stampDuty}, registration ${PROPERTY_FACTS.registration}, और GST ${PROPERTY_FACTS.gst} — ye flat price ke upar additional hai, koi hidden charges nahi.`,
        `Additional charges: stamp duty ${PROPERTY_FACTS.stampDuty}, registration ${PROPERTY_FACTS.registration}, GST ${PROPERTY_FACTS.gst}। Koi chhupa hua charge nahi — sab transparent hai.`,
        `Stamp duty, registration, GST — ये सब flat price के ऊपर हैं (${PROPERTY_FACTS.stampDuty} + ${PROPERTY_FACTS.registration} + ${PROPERTY_FACTS.gst})। No hidden charges — puri clarity hai.`,
      ], seed);

    case 'BUILDER':
      return pick([
        `${PROPERTY_FACTS.project} ${PROPERTY_FACTS.developer} group का project है — ${PROPERTY_FACTS.developerTrackRecord}। Pune mein 30 saal ka trusted naam hai.`,
        `यह ${PROPERTY_FACTS.developer} का project है — Pune में 30 साल से भरोसेमंद नाम है। ${PROPERTY_FACTS.developerTrackRecord}.`,
        `Builder है ${PROPERTY_FACTS.developer} — Pune में 30 saal se trusted developer hain. Track record bahut solid hai.`,
      ], seed);

    case 'UNITS':
      return pick([
        `${PROPERTY_FACTS.project} में total ${PROPERTY_FACTS.units} units हैं ${PROPERTY_FACTS.towers} towers में। Limited inventory hone se exclusivity milti hai aur community bhi better rehti hai.`,
        `${PROPERTY_FACTS.units} units हैं ${PROPERTY_FACTS.towers} towers में — limited inventory है। Isse community selective aur better maintain hoti hai.`,
        `Total ${PROPERTY_FACTS.units} units हैं — limited availability है जिससे close-knit community बनती है और property value भी better रहती है।`,
      ], seed);

    case 'PROJECT_NAME':
      return `Project का नाम ${PROPERTY_FACTS.project} है, ${PROPERTY_FACTS.developer} group का, ${PROPERTY_FACTS.location} में।`;

    case 'USP':
      return pick([
        `Metro station 5 minute walk, Vastu compliant, no common wall yani complete privacy, aur R.R. Lunkad ka 30 saal ka trust — rare combination hai is price range mein.`,
        `Key highlights: metro 5 min walk, Vastu compliant, no common walls for privacy, trusted builder — is price range mein yeh sab saath milna bahut rare hai.`,
        `सबसे बड़ी खासियत — metro 5 minute walk, complete privacy (no common walls), Vastu compliant, aur R.R. Lunkad ka 30 saal ka proven track record। Is price mein yeh combination bahut unique hai.`,
      ], seed);

    case 'SITE_VISIT_INFO':
      return `Site visit ${PROPERTY_FACTS.siteVisitTimings} — Sunday भी open है। Address: ${PROPERTY_FACTS.siteVisitAddress}।`;
  }
}

// ─── Compact Response Builders (for multi-intent) ────────────────────────────
// One compact sentence per intent — stripped of follow-up questions so two
// sentences can be joined without exceeding a natural response length.

type CompactBuilder = () => string;

const COMPACT_BUILDERS: Partial<Record<FactIntent, CompactBuilder>> = {
  PRICE:        () => `Price range ${PROPERTY_FACTS.priceRange} है।`,
  LOCATION:     () => `Project Pimple Gurav, Pune में है — Pimple Gurav Metro से 5 min walk।`,
  POSSESSION:   () => `Possession ${PROPERTY_FACTS.possession} में expected है।`,
  AMENITIES:    () => `Gym, pool, clubhouse, kids zone, EV charging — सब available हैं।`,
  BHK:          () => `${PROPERTY_FACTS.bhk.join(', ')} BHK options available हैं।`,
  CARPET_AREA:  () => {
    const e = Object.entries(PROPERTY_FACTS.configs).map(([b, c]) => `${b}: ${c.carpetArea}`).join(', ');
    return `Carpet area — ${e} (RERA carpet, no hidden super built-up)।`;
  },
  BUILDER:      () => `${PROPERTY_FACTS.developer} का project है — 30 साल का experience, Pune में trusted name।`,
  UNITS:        () => `Total ${PROPERTY_FACTS.units} units, ${PROPERTY_FACTS.towers} towers में।`,
  PARKING:      () => `Covered parking included, additional open parking ${PROPERTY_FACTS.parking.additional} में।`,
  BOOKING_AMOUNT: () => `Booking amount सिर्फ ${PROPERTY_FACTS.bookingAmount} है।`,
  LOAN:         () => `Home loan pre-approved — ${PROPERTY_FACTS.preApprovedBanks.slice(0, 3).join(', ')} से।`,
  RERA:         () => `RERA registered — number ${PROPERTY_FACTS.reraNumber}।`,
  PAYMENT_PLAN: () => `20:80 plan — booking पर 20%, बाकी possession पर।`,
  SECURITY:     () => `${PROPERTY_FACTS.amenitiesDetailed.security}, plus intercom हर flat में।`,
};

// ─── Exclusion Patterns ──────────────────────────────────────────────────────
// These indicate the query is too complex for a direct fact response and
// needs LLM reasoning (comparisons, multi-part questions, objections).

const NEEDS_LLM: RegExp[] = [
  // Comparisons
  /\b(compare|comparison|versus|vs\.?|differ|farak|फ़र्क|फर्क|अंतर|better|best|which\s+is)\b/i,
  // Multi-question (2+ question marks)
  /\?[^?]*\?/,
  // Objections / negotiation
  /\b(expensive|costly|mehenga|महंगा|too\s+much|zyada|ज़्यादा|discount|offer|negotiate|kam\s+kar|कम\s+कर)\b/i,
  // Visit scheduling
  /\b(visit|schedule|book|appointment|देखना|देखेंगे|देखने|dekhna|dekhenge)\b/i,
  // Explanatory / open-ended
  /\b(explain|describe|tell\s+me\s+about|overview|detail|batao|बताइए|बताओ|समझाइए|kyu|क्यों|why)\b/i,
];

// ─── Router ──────────────────────────────────────────────────────────────────

export interface RouterResult {
  /** Whether the query was handled directly (no LLM needed). */
  handled: boolean;
  /** The fact intent that matched, or null if routed to LLM. */
  intent: FactIntent | null;
  /** The pre-built response text (only when handled=true). */
  response: string;
  /** Why the router made this decision. */
  reason: string;
}

/** Last intent handled by the router — used to prevent identical repeated responses. */
let lastHandledIntent: FactIntent | null = null;

/** Reset after LLM handles a turn, so the next same-intent question gets the canned response. */
export function resetLastRouterIntent(): void {
  lastHandledIntent = null;
}

/**
 * Side-effect-free probe: does this text match a fact intent?
 * Used by speculative containment to compare spec vs final intent without
 * mutating lastHandledIntent or triggering markVisitSuggested().
 */
export function probeFactIntent(text: string): FactIntent | null {
  const trimmed = text.trim();
  for (const pat of NEEDS_LLM) {
    if (pat.test(trimmed)) return null;
  }
  for (const rule of INTENT_RULES) {
    for (const pat of rule.patterns) {
      if (pat.test(trimmed)) return rule.intent;
    }
  }
  return null;
}

/**
 * Try to answer two or more fact intents in one response, bypassing LLM.
 * Returns a RouterResult when 2+ intents with compact builders are matched,
 * null when fewer than 2 locally-routable intents are detected.
 *
 * This must be called BEFORE routeQuery() to intercept multi-intent queries.
 */
export function routeMultiQuery(
  text: string,
  session: SessionState,
  log: Logger,
): RouterResult | null {
  const trimmed = text.trim();

  // Terminal steps are never answered here
  const step = session.currentStep;
  if (new Set(['CONFIRM_VISIT', 'BOOKED', 'NOT_INTERESTED']).has(step)) return null;

  // Exclusion patterns need LLM reasoning
  for (const pat of NEEDS_LLM) {
    if (pat.test(trimmed)) return null;
  }

  // Collect all matching intents that have compact builders
  const matched: FactIntent[] = [];
  for (const rule of INTENT_RULES) {
    for (const pat of rule.patterns) {
      if (pat.test(trimmed) && COMPACT_BUILDERS[rule.intent]) {
        if (!matched.includes(rule.intent)) matched.push(rule.intent);
        break;
      }
    }
  }

  if (matched.length < 2) return null;

  // Take first 2 matched intents
  const selected = matched.slice(0, 2);
  const sentences = selected.map(i => COMPACT_BUILDERS[i]!());
  const response = sentences.join(' ');

  log.info('MULTI_INTENT_RESPONSE', {
    intents: selected,
    response,
    queryLen: trimmed.length,
  });

  // Update lastHandledIntent for the primary intent
  lastHandledIntent = selected[0];

  return {
    handled: true,
    intent: selected[0],
    response,
    reason: `multi_intent:${selected.join('+')}`,
  };
}

export function routeQuery(
  text: string,
  session: SessionState,
  log: Logger,
): RouterResult {
  const trimmed = text.trim();

  // ── Gate 1: Terminal steps are always deterministic ──────────────────────
  // CONFIRM_VISIT, BOOKED, NOT_INTERESTED are handled by the application.
  // ASK_VISIT_DAY and ASK_VISIT_TIME allow factual questions through — the
  // scheduling re-prompt is appended after the fact answer.
  const step = session.currentStep;
  const terminalSteps = new Set([
    'CONFIRM_VISIT', 'BOOKED', 'NOT_INTERESTED',
  ]);
  if (terminalSteps.has(step)) {
    return { handled: false, intent: null, response: '', reason: `step=${step} handled deterministically` };
  }

  // ── Gate 2: Check exclusion patterns (needs LLM reasoning) ──────────────
  for (const pat of NEEDS_LLM) {
    if (pat.test(trimmed)) {
      return { handled: false, intent: null, response: '', reason: `exclusion: ${pat.source.substring(0, 30)}` };
    }
  }

  // ── Gate 3: Classify fact intent ────────────────────────────────────────
  let matchedIntent: FactIntent | null = null;
  for (const rule of INTENT_RULES) {
    for (const pat of rule.patterns) {
      if (pat.test(trimmed)) {
        matchedIntent = rule.intent;
        break;
      }
    }
    if (matchedIntent) break;
  }

  if (!matchedIntent) {
    // No fact intent → during scheduling steps, fall through to the
    // deterministic scheduling handler (user is likely providing a date/time).
    return { handled: false, intent: null, response: '', reason: 'no fact intent matched' };
  }

  // ── Repeat guard: if the same fact intent was just answered, fall through
  // to LLM for a varied response instead of repeating the same canned line.
  if (matchedIntent === lastHandledIntent) {
    log.info('ROUTER_REPEAT_SKIP', { intent: matchedIntent, reason: 'same intent as last turn — falling through to LLM' });
    return { handled: false, intent: matchedIntent, response: '', reason: `repeat_skip:${matchedIntent}` };
  }

  // ── Build response (variant seed = currentTurn so each call sounds different)
  let response = buildResponse(matchedIntent, session.currentTurn);

  // Missing-field logic: append the slot-filling follow-up ONLY when the field
  // isn't captured yet — never re-ask a preference the caller already gave.
  const follow = factFollowUp(matchedIntent, {
    budget: session.budget,
    bhk: session.bhkPreference,
  });
  if (follow.clause) {
    response += ` ${follow.clause}`;
  } else if (follow.reused && follow.field) {
    log.info('SESSION_FIELD_REUSED', {
      field: follow.field,
      value: follow.field === 'budget' ? session.budget : session.bhkPreference,
      reason: 'fact follow-up suppressed — already captured',
    });
  }

  // During scheduling steps (ASK_VISIT_DAY, ASK_VISIT_TIME), the user asked
  // a factual question instead of providing a date/time. Answer the question
  // and gently re-prompt for the scheduling info.
  if (step === 'ASK_VISIT_DAY') {
    response += ' तो आपको कौन सा दिन सही रहेगा — आज, कल, या weekend?';
  } else if (step === 'ASK_VISIT_TIME') {
    response += ' कितने बजे आना चाहेंगे — सुबह, दोपहर, या शाम?';
  }

  lastHandledIntent = matchedIntent;

  log.info('ROUTER_DECISION', {
    intent: matchedIntent,
    step,
    handled: true,
    queryLen: trimmed.length,
  });

  return {
    handled: true,
    intent: matchedIntent,
    response,
    reason: `direct_fact:${matchedIntent}`,
  };
}
