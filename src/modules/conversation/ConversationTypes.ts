/**
 * Deterministic conversation state types for the booking flow.
 * The application — not the LLM — drives conversation progression.
 */

// ─── Conversation Step (State Machine) ───────────────────────────────────────

export type ConversationStep =
  | 'GET_NAME'
  | 'ANSWERING'
  | 'ASK_DAY'
  | 'ASK_TIME'
  | 'CONFIRMING'
  | 'BOOKED';

// ─── Session State ───────────────────────────────────────────────────────────

export interface SessionState {
  customerName: string;
  budget: string;
  bhkPreference: string;
  siteVisitDay: string;
  siteVisitTime: string;
  visitBooked: boolean;
  currentStep: ConversationStep;
  summary: string;
}

export function createInitialSessionState(): SessionState {
  return {
    customerName: '',
    budget: '',
    bhkPreference: '',
    siteVisitDay: '',
    siteVisitTime: '',
    visitBooked: false,
    currentStep: 'GET_NAME',
    summary: '',
  };
}

// ─── Property Facts ──────────────────────────────────────────────────────────

export interface PropertyFacts {
  projectName: string;
  location: string;
  price: string;
  bhkOptions: string[];
  possession: string;
  builder: string;
  units: number;
  amenities: string[];
}

// ─── Extraction Result ───────────────────────────────────────────────────────

export interface ExtractionResult {
  name?: string;
  budget?: string;
  bhk?: string;
  visitDay?: string;
  visitTime?: string;
  visitIntent?: boolean;
}

// ─── Validation Result ───────────────────────────────────────────────────────

export interface ValidationIssue {
  type: 'hallucinated_booking' | 'invented_price' | 'invented_possession' | 'invented_amenity' | 'response_too_long';
  detail: string;
}
