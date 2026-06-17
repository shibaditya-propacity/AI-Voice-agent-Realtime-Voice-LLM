/**
 * LLMConversationManager: per-call conversation history for Groq LLM.
 * Uses simple message format (no Anthropic SDK dependency).
 * Includes message pinning and sliding window.
 */

import { Env } from '../../config';
import { Logger } from '../../shared/Logger';
import type { LLMMessage } from './GroqLLM';

interface MessageEntry {
  message: LLMMessage;
  pinned: boolean;
  pinnedReason?: string;
}

export class LLMConversationManager {
  private readonly entries: MessageEntry[] = [];
  private readonly log: Logger;
  private _turnIndex = 0;

  private _systemPromptSuffix = '';

  constructor(callSid: string) {
    this.log = Logger.forCall(callSid, 'ConversationManager');
  }

  setSystemPromptSuffix(suffix: string): void {
    this._systemPromptSuffix = suffix;
  }

  get systemPrompt(): string {
    if (!this._systemPromptSuffix) return Env.llm.systemPrompt;
    return `${Env.llm.systemPrompt}\n\n${this._systemPromptSuffix}`;
  }

  addUserMessage(text: string): void {
    this.entries.push({ message: { role: 'user', content: text }, pinned: false });
    this.log.debug('Added user message', { turn: this._turnIndex, length: text.length });
  }

  addAssistantText(text: string): void {
    this.entries.push({ message: { role: 'assistant', content: text }, pinned: false });
    this._turnIndex++;
    this.log.debug('Added assistant message', { turn: this._turnIndex });
  }

  pinLastUserMessage(reason: string): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].message.role === 'user' && !this.entries[i].pinned) {
        this.entries[i].pinned = true;
        this.entries[i].pinnedReason = reason;
        this.log.debug('Pinned user message', { index: i, reason });
        if (i > 0 && this.entries[i - 1].message.role === 'assistant') {
          this.entries[i - 1].pinned = true;
          this.entries[i - 1].pinnedReason = 'question_for_' + reason;
        }
        break;
      }
    }
  }

  discardLastUserMessage(): void {
    if (this.entries.length > 0 && this.entries[this.entries.length - 1]?.message.role === 'user') {
      this.entries.pop();
      this.log.debug('Discarded speculative user message');
    }
  }

  updateLastUserMessage(text: string): void {
    if (this.entries.length > 0 && this.entries[this.entries.length - 1]?.message.role === 'user') {
      this.entries[this.entries.length - 1].message = { role: 'user', content: text };
      this.log.debug('Updated user message (prefix match)', { length: text.length });
    }
  }

  discardLastAssistantMessage(): void {
    if (this.entries.length > 0 && this.entries[this.entries.length - 1]?.message.role === 'assistant') {
      this.entries.pop();
      this._turnIndex = Math.max(0, this._turnIndex - 1);
      this.log.debug('Discarded partial assistant message');
    }
  }

  discardGreetingTurn(): void {
    if (this.entries.length > 0 && this.entries[this.entries.length - 1]?.message.role === 'assistant') {
      this.entries.pop();
      this._turnIndex = Math.max(0, this._turnIndex - 1);
    }
    if (this.entries.length > 0 && this.entries[this.entries.length - 1]?.message.role === 'user') {
      this.entries.pop();
    }
    this.log.debug('Discarded greeting turn from history');
  }

  /** Returns messages ready for GroqLLM.stream(). Includes system prompt. */
  toMessages(): LLMMessage[] {
    const window = Env.llm.historyWindow;

    const allMsgs = this.entries.map(e => e.message);

    if (this.entries.length <= window) {
      return [{ role: 'system', content: this.systemPrompt }, ...allMsgs];
    }

    const windowStart = this.entries.length - window;
    const pinnedBefore: LLMMessage[] = [];
    for (let i = 0; i < windowStart; i++) {
      if (this.entries[i].pinned) pinnedBefore.push(this.entries[i].message);
    }

    let start = windowStart;
    while (start < this.entries.length && this.entries[start]?.message.role !== 'user') {
      start++;
    }
    const windowed = this.entries.slice(start).map(e => e.message);

    let result: LLMMessage[];
    if (pinnedBefore.length > 0) {
      let pinnedStart = 0;
      while (pinnedStart < pinnedBefore.length && pinnedBefore[pinnedStart].role !== 'user') {
        pinnedStart++;
      }
      const validPinned = pinnedBefore.slice(pinnedStart);
      result = validPinned.length > 0 ? [...validPinned, ...windowed] : windowed;
    } else {
      result = windowed;
    }

    // Deduplicate adjacent same-role messages
    const deduped: LLMMessage[] = [];
    for (const msg of result) {
      if (deduped.length > 0 && deduped[deduped.length - 1].role === msg.role) {
        const prev = deduped[deduped.length - 1];
        deduped[deduped.length - 1] = { role: msg.role, content: prev.content + '\n' + msg.content };
        continue;
      }
      deduped.push(msg);
    }

    this.log.debug('History windowed', {
      total: this.entries.length, pinned: pinnedBefore.length,
      sent: deduped.length + 1, window,
    });

    return [{ role: 'system', content: this.systemPrompt }, ...deduped];
  }

  get messageCount(): number { return this.entries.length; }
  get currentTurn(): number  { return this._turnIndex; }
}
