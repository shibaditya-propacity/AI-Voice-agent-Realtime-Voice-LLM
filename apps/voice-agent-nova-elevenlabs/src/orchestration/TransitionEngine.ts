/**
 * TransitionEngine: selects a contextual transition phrase (≤12 words) that
 * flows naturally after a fact answer without abruptly changing topic.
 *
 * Design rules:
 *  - NEVER suggests a site visit
 *  - NEVER asks more than one question per turn
 *  - Flows naturally from the preceding fact answer
 *  - Under 12 words per transition
 *  - Returns '' when factFollowUp already handles the closing (PRICE/BHK slots)
 *
 * Usage:
 *  - KnowledgeRouter (direct-route path): appended after buildResponse()
 *  - ResponseEnrichment (LLM path): injected as [TRANSITION_HINT] in the prompt
 */

import type { FactIntent } from '../llm/KnowledgeRouter';

export interface TransitionContext {
  /** Budget range already captured from this caller. */
  hasBudget: boolean;
  /** BHK preference already captured from this caller. */
  hasBhk: boolean;
}

type TransitionFn = (ctx: TransitionContext) => string;

// Each entry maps an intent to a function that returns the transition.
// Empty string means factFollowUp() handles the slot-filling (PRICE/BHK).
const TRANSITIONS: Partial<Record<FactIntent, TransitionFn>> = {
  // PRICE & BHK: factFollowUp() asks the missing slot. TransitionEngine only
  // fills in when the slot is already captured (so there's still a natural close).
  PRICE:               ctx => ctx.hasBudget
                         ? 'Budget ke hisaab se compare karna ho toh bata sakta hoon.'
                         : '',

  BHK:                 ctx => ctx.hasBhk
                         ? 'Carpet area aur starting price bhi bata sakta hoon.'
                         : '',

  PRICE_BHK:           () => 'Floor aur view ke hisaab se thoda adjust hota hai.',
  CARPET_AREA:         () => 'Jo dikhta hai wahi exactly milta hai — koi hidden charges nahi.',
  LOCATION:            () => 'Daily commute ke liye kaafi convenient location hai.',
  LANDMARKS:           () => 'Daily life ke liye sab kuch nazdik hai.',
  AMENITIES:           () => 'Kisi specific facility ke baare mein poochna ho toh bataiye.',
  PARKING:             () => 'EV charging bhi basement mein available hai.',
  SECURITY:            () => 'Family ke liye safe aur peaceful environment hai.',
  FLOOR_TOWER:         () => 'High-speed lifts hain, waiting nahi karni padegi.',
  CONSTRUCTION_STATUS: () => 'Possession timeline bilkul track par hai.',
  POSSESSION:          () => 'RERA registered hone se possession date reliable hai.',
  PAYMENT_PLAN:        () => 'Construction-linked hone se cashflow manage karna aasaan hai.',
  BOOKING_AMOUNT:      () => 'Booking ke baad flat lock ho jayega.',
  LOAN:                () => 'Documentation mein hamari team poori help karegi.',
  RERA:                () => 'Investment bilkul safe aur protected hai.',
  STAMP_DUTY:          () => 'Koi chhupa hua charge nahi — puri clarity hai.',
  BUILDER:             () => 'Established builder se resale value bhi better milti hai.',
  UNITS:               () => 'Limited inventory se community selective aur better rehti hai.',
  PROJECT_NAME:        () => 'Property ke baare mein koi sawaal ho toh bataiye.',
  USP:                 () => 'Is price range mein yeh combination bahut rare hai.',
  SITE_VISIT_INFO:     () => 'Site par aake sample flat bhi dekh sakte hain.',
};

/**
 * Returns a contextual transition sentence (≤12 words) for the given fact intent.
 *
 * Returns empty string when:
 *  - The intent is PRICE/BHK and the relevant slot is still missing
 *    (factFollowUp() handles that case with a slot-filling question)
 *  - No transition is defined for the intent
 */
export function selectTransition(intent: FactIntent, ctx: TransitionContext): string {
  const fn = TRANSITIONS[intent];
  return fn ? fn(ctx) : '';
}
