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
  _groqClient = new Groq({ apiKey: Env.llm.groqApiKey });
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
 */
export async function warmUpBedrock(): Promise<void> {
  const log = Logger.root('LLM');
  const client = getClient();
  try {
    log.info(`Warming up LLM (Groq, ${Env.llm.modelId})...`);
    const t = Date.now();
    await client.chat.completions.create({
      model: Env.llm.modelId,
      max_completion_tokens: 1,
      messages: [
        { role: 'system', content: 'hi' },
        { role: 'user', content: 'hi' },
      ],
    });
    log.info('LLM warm-up complete (Groq)', { ms: Date.now() - t });
  } catch (err) {
    log.warn('LLM warm-up failed (Groq, non-fatal)', { error: (err as Error).message });
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
  ): AsyncGenerator<StreamEvent> {
    const requestStart = Date.now();
    let firstTokenTime: number | null = null;

    const openAIMessages = toOpenAIMessages(Env.llm.systemPrompt, messages);

    this.log.debug('Invoking LLM stream', {
      mode:    'groq',
      modelId: Env.llm.modelId,
      turns:   openAIMessages.length,
    });

    let sdkStream;
    try {
      sdkStream = await this.client.chat.completions.create({
        model:                Env.llm.modelId,
        max_completion_tokens: Env.llm.maxTokens,
        temperature:          Env.llm.temperature,
        top_p:                Env.llm.topP,
        stream:               true,
        messages:             openAIMessages,
      }, { signal: abortSignal });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        this.log.debug('LLM request aborted before start');
        return;
      }
      this.log.error('LLM stream creation error', err as Error);
      throw err;
    }

    try {
      for await (const chunk of sdkStream) {
        if (abortSignal?.aborted) break;

        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) {
          if (!firstTokenTime) {
            firstTokenTime = Date.now();
            this.log.info('LLM first token', {
              ttft_ms: firstTokenTime - requestStart,
            });
          }
          yield { type: 'text', text: delta.content };
        }

        // Check for stream end
        const finishReason = chunk.choices?.[0]?.finish_reason;
        if (finishReason) {
          const totalMs = Date.now() - requestStart;
          this.log.info('LLM stream complete', {
            finish_reason: finishReason,
            total_ms:      totalMs,
            ttft_ms:       firstTokenTime ? firstTokenTime - requestStart : null,
          });
          yield { type: 'done', stopReason: finishReason };
          return;
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
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
