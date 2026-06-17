/**
 * LLM client: streaming inference via Groq (llama-3.1-8b-instant).
 *
 * Ultra-low latency mode for real-time voice conversations.
 * Groq typically achieves TTFT of 50-150ms vs 1500-2200ms on Bedrock Sonnet.
 *
 * Previous Bedrock/Anthropic implementation is commented out below for fallback.
 *
 * - Yields text chunks as they arrive for immediate TTS streaming.
 * - Converts Anthropic MessageParam format to OpenAI-compatible format.
 * - Tool use is NOT supported with Groq/Llama (tools registry must be empty).
 */

import Groq from 'groq-sdk';
import { Agent } from 'undici';
import type { MessageParam as AnthropicMessageParam } from '@anthropic-ai/sdk/resources/messages/messages';
import { Env } from '../config/env';
import { Logger } from '../shared/logger';
import { ToolRegistry } from '../tools/ToolRegistry';
import type { StreamEvent } from './types';

// Re-export MessageParam so downstream (ConversationManager) keeps working.
// The actual objects are Anthropic-shaped; we convert inside stream().
export type MessageParam = AnthropicMessageParam;

// ─── Singleton Client ───────────────────────────────────────────────────────

let _groqClient: Groq | null = null;

function getClient(): Groq {
  if (_groqClient) return _groqClient;
  _groqClient = new Groq({
    apiKey: Env.llm.groqApiKey,
    // No retries — a retried request adds seconds of silence on a live call.
    // Better to fail fast and let the turn error than to stall the caller.
    maxRetries: 0,
    timeout: 10_000,
    // Node's default fetch dispatcher closes idle sockets after 4s, so every
    // turn (10-15s apart) paid a fresh DNS+TCP+TLS handshake — the source of
    // TTFT spikes. Keep sockets alive for 2 minutes; the 30s keep-warm ping
    // below guarantees they never go idle long enough to be reaped.
    fetchOptions: {
      dispatcher: new Agent({
        keepAliveTimeout: 120_000,
        keepAliveMaxTimeout: 120_000,
        connections: 8,
        pipelining: 1,
      }),
    },
  });
  return _groqClient;
}

/**
 * Convert Anthropic MessageParam[] to OpenAI-compatible messages.
 * Anthropic uses `content: string | ContentBlock[]`, OpenAI uses `content: string`.
 */
function toOpenAIMessages(
  systemPrompt: string,
  messages: AnthropicMessageParam[],
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt },
  ];

  for (const msg of messages) {
    const role = msg.role as 'user' | 'assistant';
    let text: string;

    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      // Extract text from content blocks, skip tool_use/tool_result blocks
      text = msg.content
        .filter((b): b is { type: 'text'; text: string } => 'type' in b && b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (!text) continue; // skip empty messages (e.g. pure tool_result turns)
    } else {
      continue;
    }

    out.push({ role, content: text });
  }

  return out;
}

/**
 * Warm up: establish HTTP connection pool + test Groq reachability.
 * Then re-pings every KEEP_WARM_INTERVAL_MS so the TLS connection and
 * Groq routing stay hot between calls — cold connections were measured
 * adding ~800ms to TTFT (1047ms vs the usual ~250ms).
 */
const KEEP_WARM_INTERVAL_MS = 30_000;
let _keepWarmTimer: ReturnType<typeof setInterval> | null = null;

async function pingGroq(log: Logger): Promise<void> {
  const t = Date.now();
  await getClient().chat.completions.create({
    model: Env.llm.modelId,
    max_completion_tokens: 1,
    messages: [
      { role: 'system', content: 'hi' },
      { role: 'user', content: 'hi' },
    ],
  });
  log.debug('LLM keep-warm ping', { ms: Date.now() - t });
}

export async function warmUpBedrock(): Promise<void> {
  const log = Logger.root('LLM');
  try {
    log.info(`Warming up LLM (Groq, ${Env.llm.modelId})...`);
    const t = Date.now();
    await pingGroq(log);
    log.info('LLM warm-up complete (Groq)', { ms: Date.now() - t });
  } catch (err) {
    log.warn('LLM warm-up failed (Groq, non-fatal)', { error: (err as Error).message });
  }

  if (!_keepWarmTimer) {
    _keepWarmTimer = setInterval(() => {
      pingGroq(log).catch((err: Error) => {
        log.warn('LLM keep-warm ping failed (non-fatal)', { error: err.message });
      });
    }, KEEP_WARM_INTERVAL_MS);
    _keepWarmTimer.unref(); // don't block process shutdown
  }
}

export class BedrockLLM {
  private readonly client: Groq;
  private readonly log: Logger;
  private readonly tools: ToolRegistry;

  constructor(callSid: string, tools: ToolRegistry) {
    this.tools = tools;
    this.log = Logger.forCall(callSid, 'LLM');
    this.client = getClient();
  }

  async *stream(
    messages: MessageParam[],
    abortSignal?: AbortSignal,
    systemPrompt?: string,
    maxTokens?: number,
  ): AsyncGenerator<StreamEvent> {
    const requestStart = Date.now();
    let firstTokenTime: number | null = null;
    // Adaptive per-turn token budget (falls back to the env default).
    const tokenBudget = maxTokens && maxTokens > 0 ? maxTokens : Env.llm.maxTokens;

    const openAIMessages = toOpenAIMessages(systemPrompt ?? Env.llm.systemPrompt, messages);

    this.log.debug('Invoking LLM stream', {
      mode:    'groq',
      modelId: Env.llm.modelId,
      turns:   openAIMessages.length,
    });

    let sdkStream;
    try {
      // Qwen3 is a reasoning model: by default it emits <think>…</think> tokens
      // that would be streamed straight to TTS and spoken aloud. Disable
      // reasoning entirely — we want a single short conversational reply, and
      // it also lowers TTFT. (llama models don't accept this param, so gate it.)
      const body: Record<string, unknown> = {
        model:                 Env.llm.modelId,
        max_completion_tokens: tokenBudget,
        temperature:           Env.llm.temperature,
        top_p:                 Env.llm.topP,
        stream:                true,
        stream_options:        { include_usage: true },
        messages:              openAIMessages,
      };
      if (/qwen/i.test(Env.llm.modelId)) {
        body.reasoning_effort = 'none';
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sdkStream = await this.client.chat.completions.create(body as any, { signal: abortSignal }) as unknown as AsyncIterable<any>;
    } catch (err) {
      if ((err as Error).name === 'AbortError' || (err as Error).message?.includes('aborted')) {
        this.log.debug('LLM request aborted before start');
        return;
      }
      this.log.error('LLM stream creation error', err as Error);
      throw err;
    }

    // Safety net: even with reasoning_effort=none, strip any <think>…</think>
    // spans that leak into content so they are never streamed to TTS. Handles
    // tags split across chunks via a running in-think flag + small carry buffer.
    let inThink = false;
    let carry = '';
    const OPEN = '<think>';
    // Longest suffix of s that is a proper prefix of OPEN (e.g. "<", "<th").
    const partialOpenLen = (s: string): number => {
      const max = Math.min(OPEN.length - 1, s.length);
      for (let k = max; k > 0; k--) {
        if (s.endsWith(OPEN.slice(0, k))) return k;
      }
      return 0;
    };
    const stripThink = (chunk: string): string => {
      let s = carry + chunk;
      carry = '';
      let out = '';
      while (s.length) {
        if (!inThink) {
          const open = s.indexOf(OPEN);
          if (open === -1) {
            // No full tag. Hold back only a trailing PARTIAL "<think>" prefix
            // (so a tag split across chunks still matches); emit the rest.
            const p = partialOpenLen(s);
            out += s.slice(0, s.length - p);
            carry = p ? s.slice(s.length - p) : '';
            s = '';
          } else {
            out += s.slice(0, open);
            s = s.slice(open + OPEN.length);
            inThink = true;
          }
        } else {
          const close = s.indexOf('</think>');
          if (close === -1) { s = ''; }
          else { s = s.slice(close + 8); inThink = false; }
        }
      }
      return out;
    };

    let finishReason: string | null = null;
    let completionTokens = 0;
    let producedChars = 0;
    try {
      for await (const chunk of sdkStream) {
        if (abortSignal?.aborted) break;

        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) {
          const clean = stripThink(delta.content);
          if (clean) {
            producedChars += clean.length;
            if (!firstTokenTime) {
              firstTokenTime = Date.now();
              this.log.info('LLM first token', { ttft_ms: firstTokenTime - requestStart });
            }
            yield { type: 'text', text: clean };
          }
        }

        // finish_reason arrives on the last content chunk; usage arrives on a
        // trailing chunk (empty choices) thanks to stream_options.include_usage.
        // Do NOT return early — keep reading so we capture the usage chunk.
        const fr = chunk.choices?.[0]?.finish_reason;
        if (fr) {
          finishReason = fr;
          if (carry && !inThink) { yield { type: 'text', text: carry }; producedChars += carry.length; carry = ''; }
        }
        const usage = (chunk as { usage?: { completion_tokens?: number } }).usage;
        if (usage?.completion_tokens != null) completionTokens = usage.completion_tokens;
      }

      // Stream exhausted. Fall back to a char-based estimate if usage was absent.
      const tokensUsed = completionTokens > 0 ? completionTokens : Math.ceil(producedChars / 4);
      const truncated = finishReason === 'length';
      this.log.info('LLM stream complete', {
        finish_reason:       finishReason,
        total_ms:            Date.now() - requestStart,
        ttft_ms:             firstTokenTime ? firstTokenTime - requestStart : null,
        selectedTokenLimit:  tokenBudget,
        actualTokensUsed:    tokensUsed,
        responseTruncated:   truncated,
      });
      yield { type: 'done', stopReason: finishReason ?? 'stop', tokensUsed, truncated };
      return;
    } catch (err) {
      if ((err as Error).name === 'AbortError' || (err as Error).message?.includes('aborted')) {
        this.log.debug('LLM stream aborted mid-flight');
        return;
      }
      throw err;
    }

    // If we exit the loop without a finish_reason, emit done anyway
    yield { type: 'done', stopReason: 'end_turn' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMENTED OUT: Previous Bedrock/Anthropic implementation
// To re-enable: uncomment below, comment out Groq code above,
// and restore the Anthropic imports.
// ═══════════════════════════════════════════════════════════════════════════════

/*
import Anthropic from '@anthropic-ai/sdk';
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import type {
  MessageParam,
  TextBlockParam,
  ToolUseBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages';

type AnyClient = Anthropic | AnthropicBedrock;

const SYSTEM_BLOCKS: TextBlockParam[] = [{
  type: 'text',
  text: Env.llm.systemPrompt,
  cache_control: { type: 'ephemeral' },
}];

let _client: AnyClient | null = null;
let _mode: 'direct' | 'bedrock' = 'bedrock';

function getClient(): AnyClient {
  if (_client) return _client;

  if (Env.llm.anthropicApiKey) {
    _mode = 'direct';
    _client = new Anthropic({ apiKey: Env.llm.anthropicApiKey });
  } else {
    _mode = 'bedrock';
    _client = new AnthropicBedrock({
      awsRegion:    Env.llm.region,
      awsAccessKey: Env.llm.accessKeyId,
      awsSecretKey: Env.llm.secretAccessKey,
    });
  }
  return _client;
}

export async function warmUpBedrock(): Promise<void> {
  const log = Logger.root('LLM');
  const client = getClient();
  try {
    log.info(`Warming up LLM (${_mode} mode, ${Env.llm.modelId})...`);
    const t = Date.now();
    await client.messages.create({
      model:      Env.llm.modelId,
      max_tokens: 1,
      system:     SYSTEM_BLOCKS,
      messages:   [{ role: 'user', content: 'hi' }],
    });
    log.info(`LLM warm-up complete (${_mode})`, { ms: Date.now() - t });
  } catch (err) {
    log.warn(`LLM warm-up failed (${_mode}, non-fatal)`, { error: (err as Error).message });
  }
}

export class BedrockLLM {
  private readonly client: AnyClient;
  private readonly log: Logger;
  private readonly tools: ToolRegistry;

  constructor(callSid: string, tools: ToolRegistry) {
    this.tools = tools;
    this.log = Logger.forCall(callSid, 'LLM');
    this.client = getClient();
  }

  async *stream(
    messages: MessageParam[],
    abortSignal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    yield* this.invokeStream(messages, abortSignal);
  }

  private async *invokeStream(
    messages: MessageParam[],
    abortSignal?: AbortSignal,
    depth = 0,
  ): AsyncGenerator<StreamEvent> {
    if (depth > 5) {
      this.log.warn('Max tool call depth reached');
      return;
    }

    const hasTools = this.tools.size > 0;

    this.log.debug('Invoking LLM stream', {
      mode:    _mode,
      modelId: Env.llm.modelId,
      turns:   messages.length,
      depth,
    });

    const streamParams = {
      model:       Env.llm.modelId,
      max_tokens:  Env.llm.maxTokens,
      temperature: Env.llm.temperature,
      system:      SYSTEM_BLOCKS,
      messages,
      ...(hasTools && { tools: this.tools.toAnthropicTools() }),
    };

    let sdkStream: any;
    try {
      sdkStream = (this.client as any).messages.stream(streamParams, { signal: abortSignal });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        this.log.debug('LLM request aborted before start');
        return;
      }
      this.log.error('LLM stream creation error', err as Error);
      throw err;
    }

    const assistantContent: Array<TextBlockParam | ToolUseBlockParam> = [];
    const pendingToolUses: Array<{ id: string; name: string; inputJson: string }> = [];
    let currentToolUse: { id: string; name: string; inputJson: string } | null = null;
    let currentTextParts: string[] = [];
    let stopReason = 'end_turn';

    try {
      for await (const event of sdkStream) {
        if (abortSignal?.aborted) break;

        switch (event.type) {
          case 'content_block_start':
            if (event.content_block.type === 'tool_use') {
              currentToolUse = {
                id:        event.content_block.id,
                name:      event.content_block.name,
                inputJson: '',
              };
            }
            break;

          case 'content_block_delta':
            if (event.delta.type === 'text_delta') {
              const { text } = event.delta;
              currentTextParts.push(text);
              yield { type: 'text', text };
            } else if (event.delta.type === 'input_json_delta') {
              if (currentToolUse) currentToolUse.inputJson += event.delta.partial_json;
            }
            break;

          case 'content_block_stop':
            if (currentTextParts.length > 0) {
              assistantContent.push({ type: 'text', text: currentTextParts.join('') });
              currentTextParts = [];
            }
            if (currentToolUse) {
              let parsedInput: Record<string, unknown> = {};
              try { parsedInput = JSON.parse(currentToolUse.inputJson || '{}'); } catch { parsedInput = {}; }

              const toolUseBlock: ToolUseBlockParam = {
                type:  'tool_use',
                id:    currentToolUse.id,
                name:  currentToolUse.name,
                input: parsedInput,
              };

              assistantContent.push(toolUseBlock);
              pendingToolUses.push(currentToolUse);
              currentToolUse = null;
            }
            break;

          case 'message_delta':
            stopReason = event.delta.stop_reason ?? 'end_turn';
            break;
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        this.log.debug('LLM stream aborted mid-flight');
        return;
      }
      throw err;
    }

    yield { type: 'done', stopReason };

    if (pendingToolUses.length > 0 && stopReason === 'tool_use') {
      for (const tu of pendingToolUses) {
        let parsedInput: Record<string, unknown> = {};
        try { parsedInput = JSON.parse(tu.inputJson || '{}'); } catch { parsedInput = {}; }
        yield { type: 'tool_use', toolUseId: tu.id, name: tu.name, input: parsedInput };
      }

      const toolResults = await Promise.all(
        pendingToolUses.map(async (tu) => {
          let parsedInput: Record<string, unknown> = {};
          try { parsedInput = JSON.parse(tu.inputJson || '{}'); } catch { parsedInput = {}; }
          const result = await this.tools.execute(tu.name, parsedInput);
          return { id: tu.id, result };
        }),
      );

      const nextMessages: MessageParam[] = [
        ...messages,
        { role: 'assistant', content: assistantContent },
        {
          role: 'user',
          content: toolResults.map(({ id, result }): ToolResultBlockParam => ({
            type:        'tool_result',
            tool_use_id: id,
            content:     result,
          })),
        },
      ];

      yield* this.invokeStream(nextMessages, abortSignal, depth + 1);
    }
  }
}
*/
