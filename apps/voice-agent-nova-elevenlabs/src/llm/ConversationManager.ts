/**
 * ConversationManager: maintains per-call conversation history.
 * Uses Anthropic SDK MessageParam types directly.
 *
 * Also holds a dynamic system prompt suffix (session state) that is
 * appended to the base system prompt on every LLM call, so the model
 * always knows what info has been collected and what to ask next.
 */

import type { MessageParam, ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';
import { Env } from '../config/env';
import { Logger } from '../shared/logger';

export class ConversationManager {
  private readonly history: MessageParam[] = [];
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

  /** Full system prompt = base prompt + session state suffix. */
  get systemPrompt(): string {
    if (!this._systemPromptSuffix) return Env.llm.systemPrompt;
    return `${Env.llm.systemPrompt}\n\n${this._systemPromptSuffix}`;
  }

  // ─── Mutation ─────────────────────────────────────────────────────────────

  addUserMessage(text: string): void {
    this.history.push({ role: 'user', content: text });
    this.log.debug('Added user message', { turn: this._turnIndex, length: text.length });
  }

  addAssistantText(text: string): void {
    this.history.push({ role: 'assistant', content: text });
    this._turnIndex++;
    this.log.debug('Added assistant message', { turn: this._turnIndex });
  }

  addAssistantContent(content: ContentBlockParam[]): void {
    this.history.push({ role: 'assistant', content });
    this._turnIndex++;
  }

  /**
   * Add a tool result as a user message.
   * Anthropic requires tool results in user turns.
   */
  addToolResult(toolUseId: string, result: string, isError = false): void {
    this.history.push({
      role: 'user',
      content: [{
        type:        'tool_result',
        tool_use_id: toolUseId,
        content:     result,
        ...(isError && { is_error: true }),
      }],
    });
  }

  /**
   * Discard the last user message — used when speculative generation
   * from a stable interim is invalidated by a different speech_final.
   */
  discardLastUserMessage(): void {
    if (this.history.length > 0 && this.history[this.history.length - 1]?.role === 'user') {
      this.history.pop();
      this.log.debug('Discarded speculative user message');
    }
  }

  /**
   * Update the last user message text — used when speculative generation
   * is confirmed via prefix match (final text extends the speculative text).
   * Keeps the LLM generation running but corrects history for future context.
   */
  updateLastUserMessage(text: string): void {
    if (this.history.length > 0 && this.history[this.history.length - 1]?.role === 'user') {
      this.history[this.history.length - 1] = { role: 'user', content: text };
      this.log.debug('Updated user message (prefix match)', { length: text.length });
    }
  }

  /**
   * Discard the last assistant message on barge-in so the model
   * doesn't see an incomplete assistant turn in context.
   */
  discardLastAssistantMessage(): void {
    if (this.history.length > 0 && this.history[this.history.length - 1]?.role === 'assistant') {
      this.history.pop();
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
    if (this.history.length > 0 && this.history[this.history.length - 1]?.role === 'assistant') {
      this.history.pop();
      this._turnIndex = Math.max(0, this._turnIndex - 1);
    }
    // Remove the synthetic user greeting prompt
    if (this.history.length > 0 && this.history[this.history.length - 1]?.role === 'user') {
      this.history.pop();
    }
    this.log.debug('Discarded greeting turn from history');
  }

  // ─── Query ────────────────────────────────────────────────────────────────

  /**
   * Returns messages ready to pass to BedrockLLM.stream().
   * Applies a sliding window to cap context size on long calls.
   * Prevents TTFT degradation as conversation grows.
   */
  toMessages(): MessageParam[] {
    const window = Env.llm.historyWindow;
    if (this.history.length <= window) return this.history;

    // Take last N messages, ensuring we start with a user message
    // (Anthropic API requires messages to start with user role)
    let start = this.history.length - window;
    while (start < this.history.length && this.history[start]?.role !== 'user') {
      start++;
    }
    const windowed = this.history.slice(start);
    this.log.debug('History windowed', {
      total: this.history.length,
      sent: windowed.length,
      window,
    });
    return windowed;
  }

  get messageCount(): number { return this.history.length; }
  get currentTurn(): number  { return this._turnIndex; }
}
