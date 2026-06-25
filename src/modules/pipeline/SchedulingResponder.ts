/**
 * SchedulingResponder: pure, deterministic scheduling response builder.
 *
 * Given current slot values, previous slot values, and booking status, returns
 * the appropriate canned response — or null if nothing changed and no LLM-free
 * response is warranted.
 *
 * Extracted from CallOrchestrator so it can be unit-tested independently.
 *
 * Rules:
 *  - Day-only provided  → store day, ask ONLY for time  (never restart)
 *  - Time-only provided → store time, ask ONLY for day  (never restart)
 *  - Both provided      → confirm immediately
 *  - User changes date/time → re-confirm with updated values (never restart)
 *  - Returns null       → fall through to LLM
 */

import type { BookingStatus } from './SessionState';

export interface SchedulingSlots {
  preferredDate: string | null;
  preferredTime: string | null;
  bookingStatus: BookingStatus;
  name: string | null;
}

/**
 * Build the appropriate scheduling response for the current turn.
 *
 * @param current  Slot values AFTER this turn's extraction.
 * @param prevDate Slot value BEFORE this turn's extraction.
 * @param prevTime Slot value BEFORE this turn's extraction.
 */
export function buildSchedulingResponse(
  current: SchedulingSlots,
  prevDate: string | null,
  prevTime: string | null,
): string | null {
  const { preferredDate, preferredTime, bookingStatus, name } = current;

  // True if the slot value changed this turn (newly set OR overwritten)
  const dateUpdated = !!preferredDate && preferredDate !== prevDate;
  const timeUpdated = !!preferredTime && preferredTime !== prevTime;

  if (!dateUpdated && !timeUpdated) return null;

  // ── Both slots filled → confirm (initial booking OR reschedule) ──────────
  if (bookingStatus === 'CONFIRMATION_PENDING' && preferredDate && preferredTime) {
    const nameClause = name ? `${name} ji, ` : '';
    const isReschedule = (prevDate !== null && dateUpdated) || (prevTime !== null && timeUpdated);

    if (isReschedule) {
      return `${nameClause}updated: ${preferredDate} ko ${preferredTime} ki visit scheduled hai. Aapka din shubh rahe.`;
    }
    return `${nameClause}aapki ${preferredDate} ko ${preferredTime} ki visit book ho gayi hai. Aapka din shubh rahe.`;
  }

  // ── Day provided, time still missing → ask ONLY for time ─────────────────
  if (dateUpdated && !preferredTime) {
    return `${preferredDate} noted. Kaunsa time convenient rahega aapke liye — morning ya afternoon?`;
  }

  // ── Time provided, day still missing → ask ONLY for day ──────────────────
  if (timeUpdated && !preferredDate) {
    return `${preferredTime} noted. Kaunsa day convenient rahega aapke liye — weekday ya weekend?`;
  }

  return null;
}
