/**
 * Standalone Nova Sonic test.
 * Sends a real speech WAV to Nova and checks if audio comes back.
 *
 * Usage:  ts-node -r dotenv/config test-nova.ts
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import dotenv from 'dotenv';

dotenv.config();

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const ACCESS_KEY = process.env.AWS_ACCESS_KEY_ID!;
const SECRET_KEY = process.env.AWS_SECRET_ACCESS_KEY!;
const MODEL_ID = 'amazon.nova-sonic-v1:0';
const SAMPLE_RATE = 16000;
const WAV_FILE = '/tmp/hello_test.wav';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function evt(obj: object) {
  return { event: obj };
}

/**
 * Async generator that yields pre-queued events, then waits for close() to be called
 * before yielding sessionEnd and terminating. This prevents Nova from receiving
 * sessionEnd before it has generated a response.
 */
class InputController {
  private queue: object[] = [];
  private resolve: ((e: object | null) => void) | null = null;
  private done = false;

  push(event: object) {
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r(event);
    } else {
      this.queue.push(event);
    }
  }

  close() {
    this.push({ event: { sessionEnd: {} } });
    // Signal end of stream after sessionEnd
    setTimeout(() => {
      this.done = true;
      if (this.resolve) { const r = this.resolve; this.resolve = null; r(null); }
    }, 200);
  }

  async *stream(): AsyncGenerator<{ chunk: { bytes: Uint8Array } }> {
    while (true) {
      let event: object | null;
      if (this.queue.length > 0) {
        event = this.queue.shift()!;
      } else {
        event = await new Promise<object | null>(r => { this.resolve = r; });
      }
      if (event === null) break;
      const bytes = Buffer.from(JSON.stringify(event), 'utf-8');
      yield { chunk: { bytes } };
    }
  }
}

// ─── Load WAV (skip 44-byte header, raw PCM16 LE) ────────────────────────────

function loadWavPcm(filePath: string): Buffer {
  const full = fs.readFileSync(filePath);
  return full.subarray(44); // skip WAV header
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Loading speech audio from', WAV_FILE);
  const pcm16 = loadWavPcm(WAV_FILE);
  console.log(`PCM16 size: ${pcm16.length} bytes = ${(pcm16.length / (SAMPLE_RATE * 2)).toFixed(2)}s @ 16kHz`);

  const promptName = `prompt_${uuidv4().replace(/-/g, '')}`;
  const sysContentName = `sys_${uuidv4().replace(/-/g, '')}`;
  const audContentName = `aud_${uuidv4().replace(/-/g, '')}`;

  const SYSTEM_PROMPT =
    'You are Arjun, a friendly real estate sales agent for PropCity Developers. ' +
    'Keep your responses short and natural for a phone conversation.';

  // Split PCM16 into 640-byte chunks (20ms @ 16kHz 16-bit mono)
  const CHUNK_SIZE = 640;
  const audioChunks: object[] = [];
  for (let i = 0; i < pcm16.length; i += CHUNK_SIZE) {
    const chunk = pcm16.subarray(i, Math.min(i + CHUNK_SIZE, pcm16.length));
    audioChunks.push(evt({
      audioInput: {
        promptName,
        contentName: audContentName,
        content: chunk.toString('base64'),
      },
    }));
  }

  const ctrl = new InputController();

  // Queue all input events upfront
  ctrl.push(evt({ sessionStart: { inferenceConfiguration: { maxTokens: 512, temperature: 0.7, topP: 0.9 } } }));
  ctrl.push(evt({ promptStart: {
    promptName,
    textOutputConfiguration: { mediaType: 'text/plain' },
    audioOutputConfiguration: {
      mediaType: 'audio/lpcm',
      sampleRateHertz: SAMPLE_RATE,
      sampleSizeBits: 16,
      channelCount: 1,
      voiceId: 'matthew',
      encoding: 'base64',
      audioType: 'SPEECH',
    },
  }}));
  ctrl.push(evt({ contentStart: { promptName, contentName: sysContentName, type: 'TEXT', interactive: false, role: 'SYSTEM', textInputConfiguration: { mediaType: 'text/plain' } } }));
  ctrl.push(evt({ textInput: { promptName, contentName: sysContentName, content: SYSTEM_PROMPT } }));
  ctrl.push(evt({ contentEnd: { promptName, contentName: sysContentName } }));
  // interactive: true → Nova uses its own VAD to detect end of speech
  // We do NOT send contentEnd/promptEnd — Nova triggers the response autonomously
  ctrl.push(evt({ contentStart: { promptName, contentName: audContentName, type: 'AUDIO', interactive: true, role: 'USER', audioInputConfiguration: { mediaType: 'audio/lpcm', sampleRateHertz: SAMPLE_RATE, sampleSizeBits: 16, channelCount: 1, audioType: 'SPEECH', encoding: 'base64' } } }));
  for (const chunk of audioChunks) ctrl.push(chunk);
  // After audio, send some silence so VAD can detect end of speech
  const trailingSilence = Buffer.alloc(SAMPLE_RATE * 2, 0); // 1s silence @ 16kHz
  for (let i = 0; i < trailingSilence.length; i += CHUNK_SIZE) {
    ctrl.push(evt({ audioInput: { promptName, contentName: audContentName, content: trailingSilence.subarray(i, i + CHUNK_SIZE).toString('base64') } }));
  }
  // Do NOT send contentEnd/promptEnd — VAD handles it
  // sessionEnd is sent AFTER receiving completionEnd (see below)

  console.log(`Sending ${audioChunks.length} audio chunks to Nova Sonic…`);

  const client = new BedrockRuntimeClient({
    region: REGION,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  });

  const command = new InvokeModelWithBidirectionalStreamCommand({
    modelId: MODEL_ID,
    body: ctrl.stream() as any,
  } as any);

  let audioChunksReceived = 0;
  let textReceived = '';
  let gotSessionStart = false;

  try {
    const response = await client.send(command);
    if (!response.body) { console.error('No response body'); return; }

    for await (const item of response.body) {
      const raw = item as any;
      const bytes = raw?.chunk?.bytes;
      if (!bytes) {
        console.log('Non-chunk item:', JSON.stringify(raw).slice(0, 300));
        continue;
      }
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf-8')) as any;
      const inner = parsed?.event;
      if (!inner) continue;

      const key = Object.keys(inner)[0];
      const val = JSON.stringify(inner[key]);
      // Print full contentStart so we can see role + type
      const limit = key === 'contentStart' ? 600 : 200;
      console.log('Nova →', key, val.slice(0, limit));

      if (key === 'sessionStart') gotSessionStart = true;
      if (key === 'audioOutput') audioChunksReceived++;
      if (key === 'textOutput') textReceived += inner.textOutput.content;
      if (key === 'completionEnd') {
        console.log('\n✅ Nova responded!');
        console.log('   Text received:', textReceived || '(none)');
        console.log('   Audio chunks received:', audioChunksReceived);
        ctrl.close(); // now send sessionEnd and close the stream
        break;
      }
    }
  } catch (err: any) {
    console.error('❌ Nova error:', err.message);
  }

  if (!gotSessionStart) console.warn('⚠️  No sessionStart received');
  if (audioChunksReceived === 0) console.warn('⚠️  No audio output received from Nova');

  console.log('\nDone.');
}

main().catch(console.error);
