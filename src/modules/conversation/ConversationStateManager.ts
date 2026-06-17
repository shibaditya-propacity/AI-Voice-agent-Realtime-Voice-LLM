/**
 * ConversationStateManager: deterministic state machine for the booking flow.
 *
 * The APPLICATION decides conversation progression — not the LLM.
 *
 * State machine:
 *   GET_NAME → ANSWERING → ASK_DAY → ASK_TIME → CONFIRMING → BOOKED
 *
 * After every user utterance:
 *   1. Extract entities (regex, sync)
 *   2. Update SessionState
 *   3. Evaluate state transitions
 *   4. Determine next action directive for the LLM
 *
 * After every assistant utterance:
 *   5. Validate response against known facts and state
 */

import { Logger } from '../../shared/Logger';
import { callTrace } from '../../shared/CallTraceLogger';
import {
  SessionState,
  ConversationStep,
  ExtractionResult,
  ValidationIssue,
  createInitialSessionState,
} from './ConversationTypes';
import { PROPERTY_FACTS } from './PropertyFacts';
import { extractEntities, extractWithGroq } from './EntityExtractor';
import { buildContextBlock } from './PromptBuilder';
import { validateResponse } from './ResponseValidator';

const log = Logger.root('ConversationStateManager');

interface ManagedSession {
  state: SessionState;
  turnCount: number;
  lastUserText: string;
  lastAssistantText: string;
  /** Whether Groq extraction is pending (fire-and-forget, applied next turn). */
  pendingGroqResult: ExtractionResult | null;
}

export class ConversationStateManager {
  private readonly sessions: Map<string, ManagedSession> = new Map();
  private readonly groqApiKey: string;

  constructor(groqApiKey: string = '') {
    this.groqApiKey = groqApiKey;
  }

  // ─── Session Lifecycle ───────────────────────────────────────────────────

  initSession(sessionId: string): void {
    if (this.sessions.has(sessionId)) return;
    this.sessions.set(sessionId, {
      state: createInitialSessionState(),
      turnCount: 0,
      lastUserText: '',
      lastAssistantText: '',
      pendingGroqResult: null,
    });
    log.info('Conversation state initialized', { sessionId, step: 'GET_NAME' });
  }

  destroySession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  getState(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId)?.state;
  }

  // ─── Process User Utterance ────────────────────────────────────────────

  /**
   * Called after every finalized user transcript. Runs extraction, updates
   * state, evaluates transitions, and returns the context block to inject
   * into Nova as a directive for the next response.
   *
   * Returns the context string (to be injected as a USER text block) or null
   * if no injection is needed (normal audio-driven turn).
   */
  processUserUtterance(
    sessionId: string,
    callId: string,
    text: string,
  ): string | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    session.turnCount++;
    session.lastUserText = text;

    // Apply any pending Groq results from last turn
    if (session.pendingGroqResult) {
      this.applyExtraction(session, session.pendingGroqResult);
      session.pendingGroqResult = null;
    }

    // 1. Extract entities (sync, regex-based)
    const extraction = extractEntities(text, session.state.currentStep);

    // 2. Update SessionState
    this.applyExtraction(session, extraction);

    // 3. Evaluate state transitions
    const prevStep = session.state.currentStep;
    this.evaluateTransitions(session, text);

    // Log state change
    if (session.state.currentStep !== prevStep) {
      log.info('Conversation step transition', {
        sessionId,
        from: prevStep,
        to: session.state.currentStep,
        state: this.stateSnapshot(session),
      });
      callTrace.event(callId, sessionId, 'conversation.step', {
        from: prevStep,
        to: session.state.currentStep,
        extraction,
      });
    }

    // 4. Fire-and-forget Groq extraction if regex found nothing and utterance is non-trivial
    if (
      this.groqApiKey &&
      Object.keys(extraction).length === 0 &&
      text.split(/\s+/).length > 3
    ) {
      void extractWithGroq(text, this.groqApiKey).then((result) => {
        if (Object.keys(result).length > 0) {
          const s = this.sessions.get(sessionId);
          if (s) s.pendingGroqResult = result;
        }
      });
    }

    // 5. Build context block for injection
    session.state.summary = this.buildSummary(session.state);
    return buildContextBlock(session.state, PROPERTY_FACTS);
  }

  // ─── Process Assistant Utterance ───────────────────────────────────────

  /**
   * Called after every finalized assistant transcript. Validates the response.
   * Returns validation issues (empty array = clean).
   */
  processAssistantUtterance(
    sessionId: string,
    callId: string,
    text: string,
  ): ValidationIssue[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    session.lastAssistantText = text;
    const issues = validateResponse(text, session.state, PROPERTY_FACTS);

    if (issues.length > 0) {
      log.warn('Response validation issues', {
        sessionId,
        issues,
        text: text.slice(0, 120),
      });
      callTrace.event(callId, sessionId, 'conversation.validation', {
        issues,
        text: text.slice(0, 120),
      });
    }

    return issues;
  }

  // ─── State Transitions ─────────────────────────────────────────────────

  private evaluateTransitions(session: ManagedSession, userText: string): void {
    const s = session.state;

    switch (s.currentStep) {
      case 'GET_NAME':
        if (s.customerName) {
          s.currentStep = 'ANSWERING';
        }
        break;

      case 'ANSWERING':
        // Transition to ASK_DAY when the user shows visit intent
        if (this.hasVisitIntent(userText)) {
          s.currentStep = 'ASK_DAY';
        }
        break;

      case 'ASK_DAY':
        if (s.siteVisitDay) {
          s.currentStep = 'ASK_TIME';
        }
        break;

      case 'ASK_TIME':
        if (s.siteVisitTime) {
          s.currentStep = 'CONFIRMING';
        }
        break;

      case 'CONFIRMING':
        if (this.hasConfirmation(userText) && s.siteVisitDay && s.siteVisitTime) {
          s.visitBooked = true;
          s.currentStep = 'BOOKED';
        }
        // If they correct the day/time, go back
        if (s.siteVisitDay && !s.siteVisitTime) {
          s.currentStep = 'ASK_TIME';
        }
        break;

      case 'BOOKED':
        // Terminal state — no further transitions
        break;
    }
  }

  private hasVisitIntent(text: string): boolean {
    const lower = text.toLowerCase();
    return /\b(yes|yeah|sure|okay|ok|haan|theek\s*hai|chalega|visit|dekhna|come|interested)\b/.test(lower);
  }

  private hasConfirmation(text: string): boolean {
    const lower = text.toLowerCase();
    return /\b(yes|yeah|sure|confirm|haan|theek\s*hai|done|pakka|ok|okay)\b/.test(lower);
  }

  // ─── Apply Extraction ──────────────────────────────────────────────────

  private applyExtraction(session: ManagedSession, extraction: ExtractionResult): void {
    const s = session.state;

    if (extraction.name && !s.customerName) {
      s.customerName = extraction.name;
      log.info('Name captured', { name: s.customerName });
    }

    if (extraction.budget && !s.budget) {
      s.budget = extraction.budget;
    }

    if (extraction.bhk && !s.bhkPreference) {
      s.bhkPreference = extraction.bhk;
    }

    if (extraction.visitDay) {
      s.siteVisitDay = extraction.visitDay;
    }

    if (extraction.visitTime) {
      s.siteVisitTime = extraction.visitTime;
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private buildSummary(s: SessionState): string {
    const parts: string[] = [];
    if (s.customerName) parts.push(`Name: ${s.customerName}`);
    if (s.bhkPreference) parts.push(`BHK: ${s.bhkPreference}`);
    if (s.budget) parts.push(`Budget: ${s.budget}`);
    if (s.siteVisitDay) parts.push(`Day: ${s.siteVisitDay}`);
    if (s.siteVisitTime) parts.push(`Time: ${s.siteVisitTime}`);
    if (s.visitBooked) parts.push('BOOKED');
    return parts.join(' | ') || 'No info yet';
  }

  private stateSnapshot(session: ManagedSession): Record<string, unknown> {
    return {
      step: session.state.currentStep,
      name: session.state.customerName || null,
      bhk: session.state.bhkPreference || null,
      budget: session.state.budget || null,
      day: session.state.siteVisitDay || null,
      time: session.state.siteVisitTime || null,
      booked: session.state.visitBooked,
    };
  }
}
