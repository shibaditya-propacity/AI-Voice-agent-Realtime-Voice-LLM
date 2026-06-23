/**
 * InsightLibrary: contextual insight templates keyed by FactIntent.
 *
 * Each intent maps to an array of template functions that produce a short
 * conversational "insight" line. The insight is appended to the LLM directive
 * so the model can weave it naturally into the response — adding value beyond
 * the raw fact answer.
 *
 * Templates reference PROPERTY_FACTS directly (no parameter needed).
 */

import { PROPERTY_FACTS } from './PropertyFacts';
import type { FactIntent } from './KnowledgeRouter';

// ─── Insight Templates ──────────────────────────────────────────────────────

type InsightTemplate = () => string;

const INSIGHT_MAP: Partial<Record<FactIntent, InsightTemplate[]>> = {
  PRICE: [
    () => `${PROPERTY_FACTS.project} ka pricing similar projects ke comparison mein competitive hai.`,
    () => `${PROPERTY_FACTS.bhk.length} configurations available hain, budget flexibility milti hai.`,
    () => `${PROPERTY_FACTS.priceRange} range mein options hain — har budget ke liye kuch na kuch hai.`,
  ],

  LOCATION: [
    () => `${PROPERTY_FACTS.location} Pune ke fastest growing areas mein se ek hai.`,
    () => `Metro connectivity hone se ${PROPERTY_FACTS.location} ki property value aur badhegi.`,
    () => `${PROPERTY_FACTS.project} ka location working professionals ke liye ideal hai.`,
  ],

  LANDMARKS: [
    () => `Hinjewadi IT Park sirf 20 minute mein — daily commute bahut easy ho jayega.`,
    () => `Schools, hospitals, malls sab 10 minute ke radius mein hain.`,
    () => `Metro station walking distance pe hone se connectivity unmatched hai.`,
  ],

  AMENITIES: [
    () => `${PROPERTY_FACTS.project} mein clubhouse alone 5000 sq ft ka hai — bahut rare milta hai is price range mein.`,
    () => `EV charging points future-ready investment ka indicator hai.`,
    () => `Kids zone aur garden dono hain — families ke liye perfect setup hai.`,
  ],

  BHK: [
    () => `${PROPERTY_FACTS.bhk.join(', ')} BHK options se har family size ke liye configuration mil jayega.`,
    () => `2.5 BHK option unique hai — extra room study ya guest room ke liye use ho sakta hai.`,
    () => `Vastu compliant layouts hain, so space ka optimal utilization milta hai.`,
  ],

  POSSESSION: [
    () => `${PROPERTY_FACTS.possession} possession hai — abhi book karo to achha floor choice mil sakta hai.`,
    () => `Construction-linked payment plan hai, so possession tak ka risk minimal hai.`,
    () => `RERA registered hone se possession date pe accountability hai.`,
  ],

  BUILDER: [
    () => `${PROPERTY_FACTS.developer} ka ${PROPERTY_FACTS.developerTrackRecord} — trust factor bahut strong hai.`,
    () => `Established builder hone se resale value bhi better milti hai.`,
    () => `${PROPERTY_FACTS.developer} ke projects mein on-time delivery ka track record hai.`,
  ],

  UNITS: [
    () => `Total ${PROPERTY_FACTS.units} units hain — limited inventory mein exclusivity milti hai.`,
    () => `Kam units hone se maintenance aur community feel dono better hoti hai.`,
    () => `${PROPERTY_FACTS.towers} towers mein ${PROPERTY_FACTS.units} units — low density living ka fayda.`,
  ],

  PARKING: [
    () => `Covered parking included hona is price range mein rare hai.`,
    () => `EV charging points basement mein available hain — future-ready parking setup hai.`,
    () => `Two-wheeler parking free hai, extra savings hoti hai.`,
  ],

  USP: [
    () => `No common wall design complete privacy deta hai — bahut kam projects mein milta hai.`,
    () => `Metro se walking distance aur Vastu compliant — dono ek saath rare combination hai.`,
    () => `${PROPERTY_FACTS.developer} ka brand plus metro proximity — long term appreciation ka strong case hai.`,
  ],
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Returns an insight string for the given intent.
 *
 * @param intent  The classified fact intent
 * @param turnIndex  Optional turn index — used to rotate through templates
 * @returns  Insight text, or empty string if no insight is available for the intent
 */
export function getInsight(intent: FactIntent, turnIndex?: number): string {
  const templates = INSIGHT_MAP[intent];
  if (!templates || templates.length === 0) return '';

  const idx = (turnIndex ?? 0) % templates.length;
  return templates[idx]();
}
