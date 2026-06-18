/**
 * ConversationManager: maintains per-call conversation history.
 * Uses Anthropic SDK MessageParam types directly.
 *
 * Also holds a dynamic system prompt suffix (session state) that is
 * appended to the base system prompt on every LLM call, so the model
 * always knows what info has been collected and what to ask next.
 *
 * MESSAGE PINNING: Critical messages (where user provided name, date, time)
 * are pinned and preserved even when the sliding history window evicts
 * older messages. This prevents the LLM from forgetting user-provided info.
 */

import type { MessageParam, ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';
import { Env } from '../config/env';
import { PROPERTY_FACTS_BLOCK } from './PropertyFacts';
import { Logger } from '../shared/logger';

/**
 * Static prompt prefix = persona/style core + [PROPERTY_FACTS].
 * Built EXACTLY ONCE at module load (zero-copy): neither the base prompt nor
 * the property facts change during a call, so they are never re-concatenated
 * per turn. Only the small dynamic [SESSION_STATE] block is appended at runtime.
 */
const STATIC_PROMPT_PREFIX = `${Env.llm.systemPrompt}\n\n${PROPERTY_FACTS_BLOCK}`;

/** Metadata for a message in the history. */
interface MessageEntry {
  message: MessageParam;
  /** Pinned messages survive history windowing. */
  pinned: boolean;
  /** What info was captured from this message (for logging). */
  pinnedReason?: string;
}

export class ConversationManager {
  private readonly entries: MessageEntry[] = [];
  private readonly log: Logger;
  private _turnIndex = 0;

  /** Dynamic suffix appended to system prompt — updated every turn with session state. */
  private _systemPromptSuffix = '';

  constructor(callSid: string) {
    this.log = Logger.forCall(callSid, 'ConversationManager');
  }

  /** Update the dynamic session state block injected into the system prompt. */
  setSystemPromptSuffix(suffix: string): void {
    this._systemPromptSuffix = suffix;
  }

  /**
   * Full system prompt = cached static prefix (persona + [PROPERTY_FACTS])
   * + dynamic [SESSION_STATE] suffix. Only one string concat per turn over the
   * small dynamic block; the large static prefix is never rebuilt.
   */
  get systemPrompt(): string {
    if (!this._systemPromptSuffix) return STATIC_PROMPT_PREFIX;
    return `${STATIC_PROMPT_PREFIX}\n\n${this._systemPromptSuffix}`;
  }

  // ─── Mutation ─────────────────────────────────────────────────────────────

  addUserMessage(text: string): void {
    this.entries.push({ message: { role: 'user', content: text }, pinned: false });
    this.log.debug('Added user message', { turn: this._turnIndex, length: text.length });
  }

  addAssistantText(text: string): void {
    this.entries.push({ message: { role: 'assistant', content: text }, pinned: false });
    this._turnIndex++;
    this.log.debug('Added assistant message', { turn: this._turnIndex });
  }

  addAssistantContent(content: ContentBlockParam[]): void {
    this.entries.push({ message: { role: 'assistant', content }, pinned: false });
    this._turnIndex++;
  }

  /**
   * Add a tool result as a user message.
   * Anthropic requires tool results in user turns.
   */
  addToolResult(toolUseId: string, result: string, isError = false): void {
    this.entries.push({
      message: {
        role: 'user',
        content: [{
          type:        'tool_result',
          tool_use_id: toolUseId,
          content:     result,
          ...(isError && { is_error: true }),
        }],
      },
      pinned: false,
    });
  }

  /**
   * Pin the last user message — marks it as critical (contains name, date, etc.)
   * so it survives history windowing.
   */
  pinLastUserMessage(reason: string): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].message.role === 'user' && !this.entries[i].pinned) {
        this.entries[i].pinned = true;
        this.entries[i].pinnedReason = reason;
        this.log.debug('Pinned user message', { index: i, reason });

        // Also pin the preceding assistant message (the question that elicited this response)
        // so the LLM sees the full Q&A pair
        if (i > 0 && this.entries[i - 1].message.role === 'assistant') {
          this.entries[i - 1].pinned = true;
          this.entries[i - 1].pinnedReason = 'question_for_' + reason;
        }
        break;
      }
    }
  }

  /**
   * Discard the last user message — used when speculative generation
   * from a stable interim is invalidated by a different speech_final.
   */
  discardLastUserMessage(): void {
    if (this.entries.length > 0 && this.entries[this.entries.length - 1]?.message.role === 'user') {
      this.entries.pop();
      this.log.debug('Discarded speculative user message');
    }
  }

  /**
   * Update the last user message text — used when speculative generation
   * is confirmed via prefix match (final text extends the speculative text).
   * Keeps the LLM generation running but corrects history for future context.
   */
  updateLastUserMessage(text: string): void {
    if (this.entries.length > 0 && this.entries[this.entries.length - 1]?.message.role === 'user') {
      this.entries[this.entries.length - 1].message = { role: 'user', content: text };
      this.log.debug('Updated user message (prefix match)', { length: text.length });
    }
  }

  /**
   * Discard the last assistant message on barge-in so the model
   * doesn't see an incomplete assistant turn in context.
   */
  discardLastAssistantMessage(): void {
    if (this.entries.length > 0 && this.entries[this.entries.length - 1]?.message.role === 'assistant') {
      this.entries.pop();
      this._turnIndex = Math.max(0, this._turnIndex - 1);
      this.log.debug('Discarded partial assistant message');
    }
  }

  /**
   * Remove the synthetic greeting turn (user prompt + assistant response)
   * from history so it doesn't pollute the real conversation context.
   */
  discardGreetingTurn(): void {
    // Remove last assistant turn
    if (this.entries.length > 0 && this.entries[this.entries.length - 1]?.message.role === 'assistant') {
      this.entries.pop();
      this._turnIndex = Math.max(0, this._turnIndex - 1);
    }
    // Remove the synthetic user greeting prompt
    if (this.entries.length > 0 && this.entries[this.entries.length - 1]?.message.role === 'user') {
      this.entries.pop();
    }
    this.log.debug('Discarded greeting turn from history');
  }

  // ─── Query ────────────────────────────────────────────────────────────────

  /**
   * Returns messages ready to pass to BedrockLLM.stream().
   * Applies a sliding window to cap context size on long calls.
   * Prevents TTFT degradation as conversation grows.
   *
   * PINNED messages are always included at the front, even if they fall
   * outside the sliding window. This ensures the LLM never forgets
   * user-provided name, date, time, etc.
   */
  toMessages(): MessageParam[] {
    const window = Env.llm.historyWindow;

    if (this.entries.length <= window) {
      return this.entries.map(e => e.message);
    }

    // Collect pinned messages that would be evicted by the window
    const windowStart = this.entries.length - window;
    const pinnedBefore: MessageParam[] = [];
    for (let i = 0; i < windowStart; i++) {
      if (this.entries[i].pinned) {
        pinnedBefore.push(this.entries[i].message);
      }
    }

    // Take last N messages from the window, ensuring we start with a user message
    let start = windowStart;
    while (start < this.entries.length && this.entries[start]?.message.role !== 'user') {
      start++;
    }
    const windowed = this.entries.slice(start).map(e => e.message);

    // Merge: pinned messages first, then windowed messages.
    // Ensure pinned messages start with user role.
    let result: MessageParam[];
    if (pinnedBefore.length > 0) {
      // Ensure first message is user role
      let pinnedStart = 0;
      while (pinnedStart < pinnedBefore.length && pinnedBefore[pinnedStart].role !== 'user') {
        pinnedStart++;
      }
      const validPinned = pinnedBefore.slice(pinnedStart);

      if (validPinned.length > 0) {
        result = [...validPinned, ...windowed];
      } else {
        result = windowed;
      }
    } else {
      result = windowed;
    }

    // Deduplicate adjacent same-role messages (can happen when pinned + window overlap)
    const deduped: MessageParam[] = [];
    for (const msg of result) {
      if (deduped.length > 0 && deduped[deduped.length - 1].role === msg.role) {
        // Merge content: append text if both are strings
        const prev = deduped[deduped.length - 1];
        if (typeof prev.content === 'string' && typeof msg.content === 'string') {
          deduped[deduped.length - 1] = { role: msg.role, content: prev.content + '\n' + msg.content };
        }
        // Otherwise skip the duplicate (keep the earlier one)
        continue;
      }
      deduped.push(msg);
    }

    this.log.debug('History windowed', {
      total: this.entries.length,
      pinned: pinnedBefore.length,
      sent: deduped.length,
      window,
    });
    return deduped;
  }

  /** Returns the content of the most recent user message, or empty string. */
  getLastUserText(): string {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const content = this.entries[i].message.content;
      if (this.entries[i].message.role === 'user' && typeof content === 'string') {
        return content;
      }
    }
    return '';
  }

  get messageCount(): number { return this.entries.length; }
  get currentTurn(): number  { return this._turnIndex; }
}
