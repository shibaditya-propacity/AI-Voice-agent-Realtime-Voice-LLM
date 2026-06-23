/**
 * VisitPitches: generates varied site-visit invitation pitches.
 *
 * Uses PROPERTY_FACTS directly (Sarvam infra — module-level constant).
 */

import { PROPERTY_FACTS } from '../llm/PropertyFacts';

// ─── Pitch Templates ────────────────────────────────────────────────────────

type PitchTemplate = (callerName?: string) => string;

const PITCH_TEMPLATES: PitchTemplate[] = [
  (name) => {
    const greeting = name ? `${name} ji, ` : '';
    return `${greeting}एक बार ${PROPERTY_FACTS.project} देखने आओ ना — seeing is believing! Sample flat ready है, construction progress भी दिखाएंगे।`;
  },
  (name) => {
    const greeting = name ? `${name} ji, ` : '';
    return `${greeting}${PROPERTY_FACTS.project} site visit करो तो सब clear हो जाएगा — flat layout, view, construction quality — सब अपनी आँखों से देखना best है।`;
  },
  (name) => {
    const greeting = name ? `${name} ji, ` : '';
    return `${greeting}मैं suggest करूँगा कि एक बार site visit कर लो — ${PROPERTY_FACTS.project} का location और quality phone पर describe करने में limits हैं, देखोगे तो impressed होगे।`;
  },
  (name) => {
    const greeting = name ? `${name} ji, ` : '';
    return `${greeting}${PROPERTY_FACTS.project} का sample flat बहुत अच्छा बना है — एक बार देखो, no commitment, बस 30 minute का time दो।`;
  },
  (name) => {
    const greeting = name ? `${name} ji, ` : '';
    return `${greeting}अगर seriously consider कर रहे हो तो site visit ज़रूर करो — हमारी team सब details explain करेगी, cost sheet भी मिलेगी, और construction progress भी दिखाएंगे।`;
  },
  (name) => {
    const greeting = name ? `${name} ji, ` : '';
    return `${greeting}weekend पर free हो तो ${PROPERTY_FACTS.project} देखने आ जाओ — Sunday भी open है। Cab arrange कर देंगे अगर चाहो तो।`;
  },
];

// ─── Pitch Builder ──────────────────────────────────────────────────────────

/**
 * PitchBuilder: maintains state to avoid repeating the same pitch.
 * Takes only callerName — facts are from module-level PROPERTY_FACTS.
 */
class PitchBuilder {
  private callerName?: string;
  private usedIndices: Set<number> = new Set();

  constructor(callerName?: string) {
    this.callerName = callerName;
  }

  /**
   * Get the next visit pitch, cycling through templates without repeating
   * until all have been used.
   */
  next(): string {
    // Reset if all used
    if (this.usedIndices.size >= PITCH_TEMPLATES.length) {
      this.usedIndices.clear();
    }

    // Find an unused index
    let idx: number;
    do {
      idx = Math.floor(Math.random() * PITCH_TEMPLATES.length);
    } while (this.usedIndices.has(idx));

    this.usedIndices.add(idx);
    return PITCH_TEMPLATES[idx](this.callerName);
  }

  /**
   * Update the caller name (e.g., after they introduce themselves).
   */
  setCallerName(name: string): void {
    this.callerName = name;
  }
}

// ─── Module-level singleton & convenience export ────────────────────────────

let _defaultBuilder: PitchBuilder | null = null;

/**
 * Get a visit pitch. Optionally pass a caller name for personalization.
 * Uses a module-level PitchBuilder to avoid repeats across calls.
 */
export function getVisitPitch(callerName?: string): string {
  if (!_defaultBuilder) {
    _defaultBuilder = new PitchBuilder(callerName);
  } else if (callerName) {
    _defaultBuilder.setCallerName(callerName);
  }
  return _defaultBuilder.next();
}

export { PitchBuilder };
