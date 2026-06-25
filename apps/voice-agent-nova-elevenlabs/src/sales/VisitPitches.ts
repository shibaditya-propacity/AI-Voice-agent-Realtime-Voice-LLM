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
    return `${greeting}अगर convenient हो तो एक बार ${PROPERTY_FACTS.project} visit कर सकते हैं — site पर देखने से काफी कुछ clear हो जाता है।`;
  },
  (name) => {
    const greeting = name ? `${name} ji, ` : '';
    return `${greeting}जब भी time हो, site visit कर सकते हैं — flat layout और location खुद देख लेंगे, बहुत कुछ clear हो जाएगा।`;
  },
  (name) => {
    const greeting = name ? `${name} ji, ` : '';
    return `${greeting}अगर आप चाहें तो एक बार आकर देख सकते हैं — हमारी team सब कुछ detail में समझाएगी, कोई pressure नहीं।`;
  },
  (name) => {
    const greeting = name ? `${name} ji, ` : '';
    return `${greeting}एक बार site आकर देखें तो बेहतर idea मिलेगा — sample flat भी ready है, और सारे questions site पर ही clear हो जाते हैं।`;
  },
  (name) => {
    const greeting = name ? `${name} ji, ` : '';
    return `${greeting}जब सुविधा हो तो visit plan कर सकते हैं — हमारी team available रहेगी, कोई commitment नहीं।`;
  },
  (name) => {
    const greeting = name ? `${name} ji, ` : '';
    return `${greeting}अगर इस project में interest हो तो एक बार आकर देखना helpful रहेगा — site पर सब कुछ personally समझ आ जाता है।`;
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
