/**
 * Humanizer: adds natural conversational texture to bot responses.
 *
 * Self-contained — no external dependencies.
 * Provides fillers, acknowledgements, and response wrappers that make
 * the voice agent sound more human and less robotic.
 */

// ─── Filler Phrases ─────────────────────────────────────────────────────────

const FILLERS_HINDI = [
  'अच्छा,',
  'हाँ जी,',
  'बिल्कुल,',
  'सही है,',
  'जी हाँ,',
  'देखिए,',
  'समझ गया,',
  'अच्छा सवाल है,',
];

const FILLERS_HINGLISH = [
  'Accha,',
  'Haan ji,',
  'Bilkul,',
  'Sahi hai,',
  'Ji haan,',
  'Dekhiye,',
  'Samajh gaya,',
  'Good question,',
  'Sure,',
  'Absolutely,',
  'Right,',
];

const ACKNOWLEDGEMENTS = [
  'मैं समझ रहा हूँ',
  'बिल्कुल सही पूछ रहे हो',
  'ये important point है',
  'अच्छा सवाल है',
  'Valid concern है',
  'समझ सकता हूँ',
];

const TRANSITIONS = [
  'तो बात ये है कि',
  'actually',
  'देखो',
  'बात ये है',
  'main point ये है कि',
  'simply put',
];

const CLOSERS = [
  'और कुछ जानना है तो बताओ।',
  'कोई और सवाल?',
  'बताओ और क्या जानना है।',
  'कुछ और पूछना हो तो बोलो।',
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ─── Humanizer Class ────────────────────────────────────────────────────────

export class Humanizer {
  private lastFillerIdx = -1;
  private turnCount = 0;

  /**
   * Get a random filler/opener. Avoids repeating the last one.
   * Uses Hinglish fillers by default (more natural for voice).
   */
  getFiller(useHindi = false): string {
    const pool = useHindi ? FILLERS_HINDI : FILLERS_HINGLISH;
    let idx: number;
    do {
      idx = Math.floor(Math.random() * pool.length);
    } while (idx === this.lastFillerIdx && pool.length > 1);
    this.lastFillerIdx = idx;
    return pool[idx];
  }

  /**
   * Get a random acknowledgement phrase.
   */
  getAcknowledgement(): string {
    return pickRandom(ACKNOWLEDGEMENTS);
  }

  /**
   * Get a random transition phrase.
   */
  getTransition(): string {
    return pickRandom(TRANSITIONS);
  }

  /**
   * Get a random closing phrase.
   */
  getCloser(): string {
    return pickRandom(CLOSERS);
  }

  /**
   * Wrap a response with natural conversational elements.
   * - Adds a filler ~60% of the time
   * - Adds a closer ~30% of the time (not on every turn)
   */
  humanize(response: string): string {
    this.turnCount++;
    let result = response;

    // Add filler at start ~60% of the time
    if (Math.random() < 0.6) {
      const filler = this.getFiller();
      result = `${filler} ${result}`;
    }

    // Add closer ~30% of the time, but not on first 2 turns
    if (this.turnCount > 2 && Math.random() < 0.3) {
      result = `${result} ${this.getCloser()}`;
    }

    return result;
  }

  /**
   * For objection responses: always acknowledge first, then transition.
   */
  humanizeObjectionResponse(response: string): string {
    const ack = this.getAcknowledgement();
    const transition = this.getTransition();
    return `${ack}, ${transition} ${response}`;
  }

  /**
   * Reset turn counter (e.g., new call).
   */
  reset(): void {
    this.turnCount = 0;
    this.lastFillerIdx = -1;
  }
}
