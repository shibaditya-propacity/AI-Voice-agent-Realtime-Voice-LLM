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
  // ─── Core Identity ──────────────────────────────────────────────────────
  project: 'Akshay Vista',
  developer: 'R.R. Lunkad',
  developerTrackRecord: '30+ years in Pune real estate, 50+ completed projects',
  reraNumber: 'P52100054321',
  location: 'Pimple Gurav, Pune',

  // ─── Nearby Landmarks ──────────────────────────────────────────────────
  landmarks: [
    'Dmart Pimple Gurav (2 min)',
    'Pimple Gurav Metro Station (5 min walk)',
    'Aditya Birla Hospital (10 min)',
    'Indira College of Engineering (5 min)',
    'Mumbai-Pune Expressway (20 min)',
    'Hinjewadi IT Park (20 min)',
  ],

  // ─── Configuration & Sizing ────────────────────────────────────────────
  bhk: ['2', '2.5', '3'],
  configs: {
    '2 BHK': { carpetArea: '650-700 sq ft', startingPrice: '52 lakh' },
    '2.5 BHK': { carpetArea: '800-850 sq ft', startingPrice: '65 lakh' },
    '3 BHK': { carpetArea: '950-1050 sq ft', startingPrice: '78 lakh' },
  } as Record<string, { carpetArea: string; startingPrice: string }>,
  totalFloors: 14,
  towers: 3,
  units: 78,

  // ─── Pricing ───────────────────────────────────────────────────────────
  pricePerSqft: '8 to 10 thousand per sq ft',
  priceRange: '52 lakh to 1.05 crore',

  // ─── Payment & Finance ─────────────────────────────────────────────────
  paymentPlan: '20:80 construction-linked plan (20% on booking, 80% on possession)',
  bookingAmount: '2 lakh',
  preApprovedBanks: ['SBI', 'HDFC', 'ICICI', 'Axis Bank', 'Bank of Baroda'],
  stampDuty: '6% (as per Maharashtra govt)',
  registration: '1% of agreement value',
  gst: '5% on under-construction property (no input credit)',

  // ─── Possession & Status ───────────────────────────────────────────────
  possession: 'April 2027',
  constructionStatus: 'Under construction — 4th floor slab completed',
  projectStatus: 'RERA registered, all approvals in place',

  // ─── Amenities ─────────────────────────────────────────────────────────
  amenities: ['gym', 'swimming pool', 'EV charging', 'kids zone'],
  amenitiesDetailed: {
    clubhouse: '5000 sq ft with party hall, indoor games, and lounge',
    gym: 'Fully equipped modern gym on ground floor',
    swimmingPool: 'Adults and kids pool with deck area',
    garden: 'Landscaped garden with walking/jogging track',
    kidsZone: 'Dedicated play area with modern equipment',
    evCharging: 'EV charging points in basement parking',
    security: '24x7 CCTV surveillance and 3-tier security',
    power: '100% power backup for common areas, optional for flats',
    water: '24x7 water supply with borewell backup',
    lift: '2 high-speed lifts per tower',
  },

  // ─── Parking ───────────────────────────────────────────────────────────
  parking: {
    covered: 'One covered parking per flat (included in price)',
    additional: 'Additional open parking available at 3 lakh',
    twoWheeler: 'Free two-wheeler parking',
  },

  // ─── USPs (Why This Project) ───────────────────────────────────────────
  usps: [
    'Walking distance to Pimple Gurav Metro Station',
    'R.R. Lunkad brand — 30+ year trust',
    'Vastu compliant design',
    'Wide 24 ft internal roads',
    'No common wall between flats — complete privacy',
    'Large balconies with open views',
  ],

  // ─── Site Visit Info ───────────────────────────────────────────────────
  siteVisitAddress: 'Survey No. 45, Pimple Gurav, near Dmart, Pimpri-Chinchwad, Pune 411061',
  siteVisitTimings: '10 AM to 7 PM, all days including Sunday',
  siteContactPerson: 'Arjun (sales team)',
} as const);

/**
 * Pre-rendered [PROPERTY_FACTS] block. Built once, never rebuilt per turn
 * (zero-copy prompt construction — see ConversationManager).
 */
export const PROPERTY_FACTS_BLOCK: string = [
  '[PROPERTY_FACTS] (only source of truth — never add or invent beyond this)',
  '',
  `Project: ${PROPERTY_FACTS.project}`,
  `Developer: ${PROPERTY_FACTS.developer} (${PROPERTY_FACTS.developerTrackRecord})`,
  `RERA: ${PROPERTY_FACTS.reraNumber}`,
  `Location: ${PROPERTY_FACTS.location}`,
  `Nearby: ${PROPERTY_FACTS.landmarks.join('; ')}`,
  '',
  `Configs: ${PROPERTY_FACTS.bhk.join(', ')} BHK`,
  ...Object.entries(PROPERTY_FACTS.configs).map(
    ([bhk, c]) => `  ${bhk}: carpet ${c.carpetArea}, starting ${c.startingPrice}`,
  ),
  `Towers: ${PROPERTY_FACTS.towers} | Floors: ${PROPERTY_FACTS.totalFloors} | Units: ${PROPERTY_FACTS.units}`,
  '',
  `Price: ${PROPERTY_FACTS.pricePerSqft} (range: ${PROPERTY_FACTS.priceRange})`,
  `Payment: ${PROPERTY_FACTS.paymentPlan}`,
  `Booking amount: ${PROPERTY_FACTS.bookingAmount}`,
  `Home loans: Pre-approved from ${PROPERTY_FACTS.preApprovedBanks.join(', ')}`,
  `Stamp duty: ${PROPERTY_FACTS.stampDuty} | Registration: ${PROPERTY_FACTS.registration} | GST: ${PROPERTY_FACTS.gst}`,
  '',
  `Possession: ${PROPERTY_FACTS.possession}`,
  `Construction: ${PROPERTY_FACTS.constructionStatus}`,
  `Status: ${PROPERTY_FACTS.projectStatus}`,
  '',
  `Amenities: ${PROPERTY_FACTS.amenities.join(', ')} + clubhouse, garden, jogging track, 24x7 security, power backup, 2 lifts/tower`,
  `Parking: ${PROPERTY_FACTS.parking.covered}; additional open at ${PROPERTY_FACTS.parking.additional}`,
  '',
  `USPs: ${PROPERTY_FACTS.usps.join('; ')}`,
  '',
  `Site visit: ${PROPERTY_FACTS.siteVisitAddress}`,
  `Timings: ${PROPERTY_FACTS.siteVisitTimings}`,
].join('\n');
