import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { Env } from '../config';
import { Logger } from './Logger';

const log = Logger.root('CallAnalyzer');

const SONNET_MODEL_ID =
  process.env.CALL_ANALYSIS_MODEL_ID ??
  'us.anthropic.claude-sonnet-4-5-20251001-v1:0';

let client: BedrockRuntimeClient | null = null;

function getClient(): BedrockRuntimeClient {
  if (!client) {
    client = new BedrockRuntimeClient({
      region: Env.aws.region,
      credentials: {
        accessKeyId: Env.aws.accessKeyId,
        secretAccessKey: Env.aws.secretAccessKey,
      },
    });
  }
  return client;
}

export interface TranscriptTurn {
  role: 'USER' | 'ASSISTANT';
  content: string;
  createdAt?: string;
}

export interface CallAnalysis {
  summary: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  keyTopics: string[];
  actionItems: string[];
  language: string;
}

export async function analyzeCallTranscript(
  turns: TranscriptTurn[],
): Promise<CallAnalysis> {
  if (turns.length === 0) {
    return {
      summary: 'No conversation recorded.',
      sentiment: 'neutral',
      keyTopics: [],
      actionItems: [],
      language: 'en',
    };
  }

  const transcript = turns
    .map((t) => `${t.role === 'USER' ? 'Caller' : 'Agent'}: ${t.content}`)
    .join('\n');

  const prompt = `Analyze this voice call transcript and respond with valid JSON only.

TRANSCRIPT:
${transcript}

Respond with exactly this JSON structure (no markdown, no explanation):
{
  "summary": "<2-3 sentence summary of the call>",
  "sentiment": "<positive|neutral|negative>",
  "keyTopics": ["<topic1>", "<topic2>"],
  "actionItems": ["<action1>", "<action2>"],
  "language": "<primary language code, e.g. en, hi, mr>"
}`;

  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  };

  try {
    const command = new InvokeModelCommand({
      modelId: SONNET_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(payload),
    });

    const response = await getClient().send(command);
    const raw = new TextDecoder().decode(response.body);
    const parsed = JSON.parse(raw) as {
      content: Array<{ type: string; text: string }>;
    };

    const text = parsed.content.find((c) => c.type === 'text')?.text ?? '';
    const analysis = JSON.parse(text) as CallAnalysis;
    log.info('Call analysis complete', { sentiment: analysis.sentiment, topics: analysis.keyTopics.length });
    return analysis;
  } catch (err) {
    log.warn('Call analysis failed — skipping', { error: (err as Error).message });
    return {
      summary: turns.length > 0 ? `Call with ${turns.length} exchanges.` : 'No transcript available.',
      sentiment: 'neutral',
      keyTopics: [],
      actionItems: [],
      language: 'en',
    };
  }
}
