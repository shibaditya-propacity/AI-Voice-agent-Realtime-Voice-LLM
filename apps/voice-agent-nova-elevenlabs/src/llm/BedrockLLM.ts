/**
 * BedrockLLM: streaming inference via @anthropic-ai/bedrock-sdk.
 *
 * Uses the Anthropic SDK routed through AWS Bedrock — same API surface as
 * the Anthropic Claude API but authenticated with AWS credentials.
 *
 * - Yields text chunks as they arrive for immediate TTS streaming.
 * - Handles tool use blocks: pauses TTS, executes tool, resumes with result.
 * - Recursively continues after tool results until a final text response.
 */

import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import type {
  MessageParam,
  TextBlockParam,
  ToolUseBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages';
import { Env } from '../config/env';
import { Logger } from '../shared/logger';
import { ToolRegistry } from '../tools/ToolRegistry';
import type { StreamEvent } from './types';

export type { MessageParam };

/**
 * Module-level singleton client — reuses the underlying HTTP keep-alive
 * connections across all calls rather than creating a new client per call.
 * Initialized lazily on first use so Env is guaranteed to be loaded.
 */
let _bedrockClient: AnthropicBedrock | null = null;

function getBedrockClient(): AnthropicBedrock {
  if (!_bedrockClient) {
    _bedrockClient = new AnthropicBedrock({
      awsRegion:    Env.llm.region,
      awsAccessKey: Env.llm.accessKeyId,
      awsSecretKey: Env.llm.secretAccessKey,
    });
  }
  return _bedrockClient;
}

export class BedrockLLM {
  private readonly client: AnthropicBedrock;
  private readonly log: Logger;
  private readonly tools: ToolRegistry;

  constructor(callSid: string, tools: ToolRegistry) {
    this.tools = tools;
    this.log = Logger.forCall(callSid, 'BedrockLLM');
    this.client = getBedrockClient();
  }

  /**
   * Stream a response for the given conversation messages.
   * Yields StreamEvent items; call sites pipe text chunks directly to TTS.
   * Tool use is handled internally — the generator recurses after execution.
   */
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

    this.log.debug('Invoking Bedrock (Anthropic SDK) stream', {
      modelId: Env.llm.modelId,
      turns:   messages.length,
      depth,
    });

    // Build the streaming request
    const streamParams: Parameters<AnthropicBedrock['messages']['stream']>[0] = {
      model:      Env.llm.modelId,
      max_tokens: Env.llm.maxTokens,
      system:     Env.llm.systemPrompt,
      messages,
      ...(hasTools && { tools: this.tools.toAnthropicTools() }),
    };

    let sdkStream: ReturnType<AnthropicBedrock['messages']['stream']>;
    try {
      sdkStream = this.client.messages.stream(streamParams, { signal: abortSignal });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        this.log.debug('LLM request aborted before start');
        return;
      }
      this.log.error('Bedrock stream creation error', err as Error);
      throw err;
    }

    // Track accumulated state for this generation
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

    // Handle tool use — recurse with tool results
    if (pendingToolUses.length > 0 && stopReason === 'tool_use') {
      for (const tu of pendingToolUses) {
        let parsedInput: Record<string, unknown> = {};
        try { parsedInput = JSON.parse(tu.inputJson || '{}'); } catch { parsedInput = {}; }
        yield { type: 'tool_use', toolUseId: tu.id, name: tu.name, input: parsedInput };
      }

      // Execute all tools in parallel
      const toolResults = await Promise.all(
        pendingToolUses.map(async (tu) => {
          let parsedInput: Record<string, unknown> = {};
          try { parsedInput = JSON.parse(tu.inputJson || '{}'); } catch { parsedInput = {}; }
          const result = await this.tools.execute(tu.name, parsedInput);
          return { id: tu.id, result };
        }),
      );

      // Append assistant turn (with tool use blocks)
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
