/**
 * ResponseValidator: blocks hallucinated bookings, invented facts, and
 * overly long responses from the assistant.
 *
 * Runs synchronously on every finalized assistant transcript.
 * Returns an array of ValidationIssues (empty = clean).
 */

import { SessionState, PropertyFacts, ValidationIssue } from './ConversationTypes';

// ─── Booking Hallucination ───────────────────────────────────────────────────

const BOOKING_CLAIMS = /\b(booked|confirmed|scheduled|registered|appointment\s+is\s+set|visit\s+is\s+(?:booked|confirmed|set|done))\b/i;

function checkBookingHallucination(text: string, state: SessionState): ValidationIssue | null {
  if (BOOKING_CLAIMS.test(text) && (!state.siteVisitDay || !state.siteVisitTime)) {
    return {
      type: 'hallucinated_booking',
      detail: `Claimed booking without ${!state.siteVisitDay ? 'day' : 'time'}. Day="${state.siteVisitDay}" Time="${state.siteVisitTime}"`,
    };
  }
  return null;
}

// ─── Invented Prices ─────────────────────────────────────────────────────────

// The only valid price is "8,000 to 10,000 per square foot" (or variations).
// Anything else is invented.
const PRICE_MENTIONS = /(\d[\d,]*)\s*(?:per\s+sq(?:uare)?\s*(?:ft|foot|feet)|psf|rupees?\s+per)/i;
const VALID_PRICE_RANGE = { min: 7000, max: 11000 }; // slightly wider to catch rounding

function checkInventedPrice(text: string, _facts: PropertyFacts): ValidationIssue | null {
  const match = text.match(PRICE_MENTIONS);
  if (!match) return null;

  const num = parseInt(match[1].replace(/,/g, ''), 10);
  if (isNaN(num)) return null;

  if (num < VALID_PRICE_RANGE.min || num > VALID_PRICE_RANGE.max) {
    return {
      type: 'invented_price',
      detail: `Price ${num} is outside valid range ${VALID_PRICE_RANGE.min}–${VALID_PRICE_RANGE.max}`,
    };
  }
  return null;
}

// ─── Invented Possession Date ────────────────────────────────────────────────

const POSSESSION_MENTIONS = /(?:possession|ready|handover|move\s*in)[\s:]*(?:by\s+)?(\w+\s+\d{4}|\d{4})/i;
const VALID_POSSESSION = ['april 2027', '2027'];

function checkInventedPossession(text: string): ValidationIssue | null {
  const match = text.match(POSSESSION_MENTIONS);
  if (!match) return null;

  const mentioned = match[1].toLowerCase().trim();
  if (!VALID_POSSESSION.some((v) => mentioned.includes(v))) {
    return {
      type: 'invented_possession',
      detail: `Possession "${match[1]}" doesn't match known "April 2027"`,
    };
  }
  return null;
}

// ─── Invented Amenities ──────────────────────────────────────────────────────

const KNOWN_AMENITIES = new Set([
  'gym', 'play area', 'jogging track', 'ev charging', 'covered parking',
  'playground', 'play ground', 'running track', 'jog track',
  'electric vehicle', 'parking', 'fitness', 'exercise',
]);

const AMENITY_CLAIMS = /(?:amenities|facilities|features)[\s:]*([^.!?]+)/i;

// Common amenities that DON'T exist at this property
const INVENTED_AMENITIES = [
  'swimming pool', 'pool', 'clubhouse', 'club house', 'tennis',
  'badminton', 'squash', 'spa', 'sauna', 'theatre', 'theater',
  'cinema', 'golf', 'basketball', 'cricket', 'football',
  'rooftop', 'sky lounge', 'infinity pool', 'jacuzzi',
];

function checkInventedAmenities(text: string): ValidationIssue | null {
  const lower = text.toLowerCase();
  for (const invented of INVENTED_AMENITIES) {
    if (lower.includes(invented)) {
      return {
        type: 'invented_amenity',
        detail: `Mentioned "${invented}" which is not a known amenity`,
      };
    }
  }
  return null;
}

// ─── Response Length ─────────────────────────────────────────────────────────

const MAX_WORDS = 20; // soft limit, logged as issue but not blocking

function checkResponseLength(text: string): ValidationIssue | null {
  const words = text.trim().split(/\s+/).length;
  if (words > MAX_WORDS) {
    return {
      type: 'response_too_long',
      detail: `${words} words (target: under 12)`,
    };
  }
  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function validateResponse(
  text: string,
  state: SessionState,
  facts: PropertyFacts,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const booking = checkBookingHallucination(text, state);
  if (booking) issues.push(booking);

  const price = checkInventedPrice(text, facts);
  if (price) issues.push(price);

  const possession = checkInventedPossession(text);
  if (possession) issues.push(possession);

  const amenity = checkInventedAmenities(text);
  if (amenity) issues.push(amenity);

  const length = checkResponseLength(text);
  if (length) issues.push(length);

  return issues;
}
