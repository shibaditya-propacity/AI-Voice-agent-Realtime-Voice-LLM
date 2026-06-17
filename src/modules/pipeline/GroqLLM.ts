/**
 * GroqLLM: streaming inference via Groq (llama-3.1-8b-instant).
 * Ultra-low latency for real-time voice conversations (~50-150ms TTFT).
 */

import Groq from 'groq-sdk';
import { Agent } from 'undici';
import { Env } from '../../config';
import { Logger } from '../../shared/Logger';
import type { StreamEvent } from './LLMTypes';

/** OpenAI-compatible message format used by Groq. */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ─── Singleton Client ───────────────────────────────────────────────────────

let _groqClient: Groq | null = null;

function getClient(): Groq {
  if (_groqClient) return _groqClient;
  _groqClient = new Groq({
    apiKey: Env.llm.groqApiKey,
    maxRetries: 0,
    timeout: 10_000,
    fetchOptions: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dispatcher: new Agent({
        keepAliveTimeout: 120_000,
        keepAliveMaxTimeout: 120_000,
        connections: 8,
        pipelining: 1,
      }) as any,
    },
  });
  return _groqClient;
}

/**
 * Keep-warm: maintain hot TLS connections to Groq between calls.
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

export async function warmUpGroq(): Promise<void> {
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
    _keepWarmTimer.unref();
  }
}

export class GroqLLM {
  private readonly client: Groq;
  private readonly log: Logger;

  constructor(callSid: string) {
    this.log = Logger.forCall(callSid, 'LLM');
    this.client = getClient();
  }

  async *stream(
    messages: LLMMessage[],
    abortSignal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const requestStart = Date.now();
    let firstTokenTime: number | null = null;

    this.log.debug('Invoking LLM stream', {
      mode:    'groq',
      modelId: Env.llm.modelId,
      turns:   messages.length,
    });

    let sdkStream;
    try {
      sdkStream = await this.client.chat.completions.create({
        model:                Env.llm.modelId,
        max_completion_tokens: Env.llm.maxTokens,
        temperature:          Env.llm.temperature,
        top_p:                Env.llm.topP,
        stream:               true,
        messages,
      }, { signal: abortSignal });
    } catch (err) {
      if ((err as Error).name === 'AbortError' || (err as Error).message?.includes('aborted')) {
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
      if ((err as Error).name === 'AbortError' || (err as Error).message?.includes('aborted')) {
        this.log.debug('LLM stream aborted mid-flight');
        return;
      }
      throw err;
    }

    yield { type: 'done', stopReason: 'end_turn' };
  }
}
