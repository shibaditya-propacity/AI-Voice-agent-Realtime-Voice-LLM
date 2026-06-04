#!/usr/bin/env ts-node
// @ts-nocheck
/**
 * scripts/test-nova-v2.ts
 *
 * Standalone integration test for Amazon Nova Sonic v2.
 *
 * Matches the official docs event format exactly:
 * https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-getting-started.html
 *
 * Usage:
 *   npx ts-node --transpile-only -r dotenv/config scripts/test-nova-v2.ts
 *   # Or override settings:
 *   AWS_REGION=us-west-2 NOVA_VOICE_ID=matthew NOVA_TEST_SAMPLE_RATE=24000 npx ts-node ...
 */

import * as fs from 'fs';
import * as path from 'path';

try { require('dotenv').config(); } catch {}

import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import {
  PollyClient,
  SynthesizeSpeechCommand,
} from '@aws-sdk/client-polly';
import { v4 as uuidv4 } from 'uuid';

// ─── Config ───────────────────────────────────────────────────────────────────

const MODEL_ID    = process.env.NOVA_MODEL_ID            ?? 'amazon.nova-2-sonic-v1:0';
const VOICE_ID    = process.env.NOVA_VOICE_ID            ?? 'matthew';
const REGION      = process.env.AWS_REGION               ?? 'us-east-1';
const ACCESS_KEY  = process.env.AWS_ACCESS_KEY_ID        ?? '';
const SECRET_KEY  = process.env.AWS_SECRET_ACCESS_KEY    ?? '';
const SAMPLE_RATE = parseInt(process.env.NOVA_TEST_SAMPLE_RATE ?? process.env.INTERNAL_SAMPLE_RATE ?? '24000', 10);
const ENDPOINTING = process.env.NOVA_ENDPOINTING_SENSITIVITY ?? 'HIGH';

const OUT_DIR     = path.join(process.cwd(), 'test-output');
const CHUNK_BYTES = Math.floor((20 / 1000) * SAMPLE_RATE) * 2;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const log = (tag, msg, data?) =>
  console.log(`[${new Date().toISOString().slice(11,23)}] [${tag}] ${msg}${data ? ' '+JSON.stringify(data) : ''}`);

function writePcmAsWav(pcm, sr, filePath) {
  const bits = 16, byteRate = sr * (bits/8), blockAlign = bits/8;
  const buf = Buffer.alloc(44 + pcm.length); let o = 0;
  buf.write('RIFF',o);o+=4;buf.writeUInt32LE(36+pcm.length,o);o+=4;
  buf.write('WAVE',o);o+=4;buf.write('fmt ',o);o+=4;
  buf.writeUInt32LE(16,o);o+=4;buf.writeUInt16LE(1,o);o+=2;
  buf.writeUInt16LE(1,o);o+=2;buf.writeUInt32LE(sr,o);o+=4;
  buf.writeUInt32LE(byteRate,o);o+=4;buf.writeUInt16LE(blockAlign,o);o+=2;
  buf.writeUInt16LE(bits,o);o+=2;buf.write('data',o);o+=4;
  buf.writeUInt32LE(pcm.length,o);o+=4;pcm.copy(buf,o);
  fs.writeFileSync(filePath, buf);
}

const uid = () => uuidv4().replace(/-/g,'');
const ev  = (obj) => ({ chunk: { bytes: Buffer.from(JSON.stringify(obj), 'utf-8') } });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const makeSilence = (ms) => Buffer.alloc(Math.floor((ms/1000)*SAMPLE_RATE)*2, 0);
const makeTone    = (ms, hz=440) => {
  const n=Math.floor((ms/1000)*SAMPLE_RATE), buf=Buffer.alloc(n*2);
  for(let i=0;i<n;i++) buf.writeInt16LE(Math.round(Math.sin(2*Math.PI*hz*i/SAMPLE_RATE)*16000),i*2);
  return buf;
};

/**
 * Synthesise speech via AWS Polly at 16 kHz PCM16.
 * Polly PCM output is 16-bit signed little-endian mono.
 */
async function pollySpeak(text: string, voiceId = 'Matthew'): Promise<Buffer> {
  const polly = new PollyClient({
    region: REGION,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  });
  log('POLLY', `Synthesising "${text}" with voice=${voiceId} at 16000Hz...`);
  const r = await polly.send(new SynthesizeSpeechCommand({
    Text: text,
    OutputFormat: 'pcm',
    SampleRate: '16000',
    VoiceId: voiceId as any,
    Engine: 'standard',
  }));
  const chunks: Buffer[] = [];
  for await (const chunk of r.AudioStream as any) chunks.push(Buffer.from(chunk));
  const pcm = Buffer.concat(chunks);
  log('POLLY', `✅ Got ${pcm.length} bytes (${(pcm.length / (16000 * 2) * 1000).toFixed(0)} ms)`);
  return pcm;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!ACCESS_KEY || !SECRET_KEY) { console.error('❌ AWS creds missing'); process.exit(1); }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  log('TEST', 'Nova v2 integration test', { MODEL_ID, VOICE_ID, REGION, SAMPLE_RATE, ENDPOINTING });

  const sysPrompt =
    'You are Arjun, a professional Indian real estate sales consultant. ' +
    'Greet the caller warmly and ask for their name. Keep it to 2 sentences.';

  const pn = `prompt_${uid()}`;
  const sc = `sys_${uid()}`;
  const ac = `aud_${uid()}`;

  // Generate real speech audio via Polly (16kHz PCM16) to ensure Nova's ASR fires.
  // Silence/tones are processed but don't trigger LLM output.
  const greetingPcm = await pollySpeak(
    'Hello, I am calling regarding a property enquiry. Could you please help me?',
    'Matthew',
  );
  const greetingAudioInput = greetingPcm;
  const silChunks = [];
  for(let o=0;o<greetingAudioInput.length;o+=CHUNK_BYTES)
    silChunks.push(ev({event:{audioInput:{promptName:pn,contentName:ac,
      content:greetingAudioInput.subarray(o,Math.min(o+CHUNK_BYTES,greetingAudioInput.length)).toString('base64')}}}));

  // Build the complete event sequence matching docs exactly.
  // interactive:true for SYSTEM content (per docs example).
  // interactive:false for USER audio → explicit promptEnd triggers greeting.
  const greetingEvents = [
    ev({event:{sessionStart:{
      inferenceConfiguration:{maxTokens:1024,topP:0.9,temperature:0.7},
      turnDetectionConfiguration:{endpointingSensitivity:ENDPOINTING},
    }}}),
    ev({event:{promptStart:{
      promptName:pn,
      textOutputConfiguration:{mediaType:'text/plain'},
      audioOutputConfiguration:{
        mediaType:'audio/lpcm',sampleRateHertz:SAMPLE_RATE,
        sampleSizeBits:16,channelCount:1,
        voiceId:VOICE_ID,encoding:'base64',audioType:'SPEECH',
      },
    }}}),
    // SYSTEM content — docs show interactive:true for text blocks
    ev({event:{contentStart:{
      promptName:pn,contentName:sc,
      type:'TEXT',interactive:true,role:'SYSTEM',
      textInputConfiguration:{mediaType:'text/plain'},
    }}}),
    ev({event:{textInput:{promptName:pn,contentName:sc,content:sysPrompt}}}),
    ev({event:{contentEnd:{promptName:pn,contentName:sc}}}),
    // USER audio — interactive:false → we control turn end via promptEnd
    ev({event:{contentStart:{
      promptName:pn,contentName:ac,
      type:'AUDIO',interactive:false,role:'USER',
      audioInputConfiguration:{
        mediaType:'audio/lpcm',sampleRateHertz:SAMPLE_RATE,
        sampleSizeBits:16,channelCount:1,
        audioType:'SPEECH',encoding:'base64',
      },
    }}}),
    ...silChunks,
    ev({event:{contentEnd:{promptName:pn,contentName:ac}}}),
    ev({event:{promptEnd:{promptName:pn}}}),
  ];

  log('BUILD', `${greetingEvents.length} greeting events (${silChunks.length} audio chunks)`);

  const bedrock = new BedrockRuntimeClient({
    region: REGION,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  });

  // Control: generator sends greeting events immediately, then waits for
  // completionEnd (via ctrl.greetingDone). After greeting, sends response turn.
  // After response, sends sessionEnd.
  const ctrl = { greetingDone: false, done: false };

  async function* inputGenerator() {
    // Phase 1: greeting — send immediately (generator runs as bedrock.send() sets up stream)
    log('INPUT', `Sending ${greetingEvents.length} greeting events...`);
    for (const e of greetingEvents) yield e;
    log('INPUT', 'Greeting events sent — keeping stream open, waiting for Nova...');

    // Keep stream alive while output consumer waits for completionEnd
    while (!ctrl.greetingDone && !ctrl.done) await sleep(50);
    if (ctrl.done) { yield ev({event:{sessionEnd:{}}}); return; }

    log('INPUT', 'Greeting done — sending response turn...');

    // Phase 2: response turn — use Polly speech so Nova ASR can transcribe
    const ac2 = `aud_${uid()}`;
    const responsePcm = await pollySpeak(
      'Yes, I am interested. I would like to know more about 2BHK options available.',
      'Matthew',
    );
    const toneChunks2 = [];
    for(let o=0;o<responsePcm.length;o+=CHUNK_BYTES)
      toneChunks2.push(ev({event:{audioInput:{promptName:pn,contentName:ac2,
        content:responsePcm.subarray(o,Math.min(o+CHUNK_BYTES,responsePcm.length)).toString('base64')}}}));

    yield ev({event:{contentStart:{
      promptName:pn,contentName:ac2,
      type:'AUDIO',interactive:false,role:'USER',
      audioInputConfiguration:{
        mediaType:'audio/lpcm',sampleRateHertz:SAMPLE_RATE,
        sampleSizeBits:16,channelCount:1,
        audioType:'SPEECH',encoding:'base64',
      },
    }}});
    for (const e of toneChunks2) yield e;
    yield ev({event:{contentEnd:{promptName:pn,contentName:ac2}}});
    yield ev({event:{promptEnd:{promptName:pn}}});
    log('INPUT', 'Response events sent — waiting for Nova response...');

    while (!ctrl.done) await sleep(50);
    yield ev({event:{sessionEnd:{}}});
    log('INPUT', 'sessionEnd sent');
  }

  // ── Connect ──────────────────────────────────────────────────────────────
  log('CONNECT', 'Opening stream...');
  let streamResponse;
  try {
    streamResponse = await bedrock.send(new InvokeModelWithBidirectionalStreamCommand({
      modelId: MODEL_ID,
      body: inputGenerator(),
    }));
  } catch (err) {
    log('ERROR', '❌ Stream open FAILED', { error: err.message });
    process.exit(1);
  }
  if (!streamResponse?.body) { log('ERROR', '❌ No response.body'); process.exit(1); }
  log('CONNECT', '✅ Stream open');

  // ── Output consumer ───────────────────────────────────────────────────────
  let greetingAudio = Buffer.alloc(0), responseAudio = Buffer.alloc(0);
  let greetingText = '', responseText = '', userTranscript = '';
  let phase = 'greeting', turnCount = 0;

  try {
    for await (const item of streamResponse.body) {
      if (!('chunk' in item)) {
        log('ERROR', '❌ Error envelope', { raw: JSON.stringify(item).slice(0,600) });
        continue;
      }
      const bytes = item.chunk?.bytes;
      if (!bytes?.length) continue;

      const rawStr = Buffer.from(bytes).toString('utf-8');
      log('RAW', 'event', { preview: rawStr.slice(0,500) });

      let parsed;
      try { parsed = JSON.parse(rawStr); } catch { continue; }
      const inner = parsed?.event;
      if (!inner) continue;

      const evType = Object.keys(inner)[0] ?? 'unknown';
      log('NOVA', `${evType} [${phase}]`);

      if ('sessionStart' in inner) {
        log('NOVA', '✅ sessionStart', { sessionId: inner.sessionStart?.sessionId });
      } else if ('completionStart' in inner) {
        log('NOVA', '✅ completionStart', { id: inner.completionStart?.completionId });
      } else if ('contentStart' in inner) {
        const cs = inner.contentStart;
        log('NOVA', `contentStart type=${cs?.type} role=${cs?.role}`);
      } else if ('audioOutput' in inner) {
        const ao = inner.audioOutput;
        if (ao?.content) {
          const chunk = Buffer.from(ao.content, 'base64');
          if (phase === 'greeting') {
            if (!greetingAudio.length) log('NOVA', '✅ FIRST GREETING AUDIO!', { bytes: chunk.length });
            greetingAudio = Buffer.concat([greetingAudio, chunk]);
          } else {
            if (!responseAudio.length) log('NOVA', '✅ FIRST RESPONSE AUDIO!', { bytes: chunk.length });
            responseAudio = Buffer.concat([responseAudio, chunk]);
          }
        }
      } else if ('textOutput' in inner) {
        const { content='', role='' } = inner.textOutput ?? {};
        log('NOVA', `textOutput role=${role}`, { text: content.slice(0,100) });
        if (phase === 'greeting') greetingText += content;
        else if (role === 'USER') userTranscript += content;
        else responseText += content;
      } else if ('contentEnd' in inner) {
        log('NOVA', 'contentEnd', { stopReason: inner.contentEnd?.stopReason });
      } else if ('completionEnd' in inner) {
        turnCount++;
        log('NOVA', `✅ completionEnd turn=${turnCount}`, { stopReason: inner.completionEnd?.stopReason });
        if (phase === 'greeting') {
          if (greetingAudio.length) {
            const f = path.join(OUT_DIR, 'greeting.wav');
            writePcmAsWav(greetingAudio, SAMPLE_RATE, f);
            fs.writeFileSync(path.join(OUT_DIR, 'greeting.pcm'), greetingAudio);
            log('TEST', `✅ Greeting saved → ${f} (${(greetingAudio.length/(SAMPLE_RATE*2)*1000).toFixed(0)} ms)`);
            log('TEST', `Greeting text: "${greetingText}"`);
          } else {
            log('WARN', `⚠️  0 audio bytes for voice "${VOICE_ID}" — try NOVA_VOICE_ID=matthew or tiffany`);
            log('WARN', `Greeting text (no audio): "${greetingText}"`);
          }
          phase = 'response';
          ctrl.greetingDone = true;
        } else {
          if (responseAudio.length) {
            const f = path.join(OUT_DIR, 'response.wav');
            writePcmAsWav(responseAudio, SAMPLE_RATE, f);
            fs.writeFileSync(path.join(OUT_DIR, 'response.pcm'), responseAudio);
            log('TEST', `✅ Response saved → ${f} (${(responseAudio.length/(SAMPLE_RATE*2)*1000).toFixed(0)} ms)`);
          }
          log('TEST', `Transcript: "${userTranscript}", Reply: "${responseText}"`);
          ctrl.done = true;
          break;
        }
      } else if ('usageEvent' in inner) {
        const u = inner.usageEvent;
        log('NOVA', 'usageEvent', {
          in:u?.totalInputTokens, out:u?.totalOutputTokens,
          speechIn:u?.details?.total?.input?.speechTokens,
          speechOut:u?.details?.total?.output?.speechTokens,
        });
      } else {
        log('WARN', `Unhandled: ${evType}`);
      }
    }
  } catch (err) {
    log('ERROR', 'Output stream error', { error: err.message });
  }

  ctrl.done = true;

  const ms = (b) => b.length > 0 ? (b.length/(SAMPLE_RATE*2)*1000).toFixed(0) : '0';
  console.log('\n' + '='.repeat(64));
  console.log('RESULT SUMMARY');
  console.log('='.repeat(64));
  console.log(`Model:          ${MODEL_ID}`);
  console.log(`Voice:          ${VOICE_ID}`);
  console.log(`Region:         ${REGION}`);
  console.log(`Sample rate:    ${SAMPLE_RATE} Hz`);
  console.log(`Greeting audio: ${greetingAudio.length} bytes (${ms(greetingAudio)} ms)`);
  console.log(`Response audio: ${responseAudio.length} bytes (${ms(responseAudio)} ms)`);
  console.log(`Greeting text:  ${greetingText || '(none)'}`);
  console.log(`User xscript:   ${userTranscript || '(none)'}`);
  console.log(`Nova reply:     ${responseText || '(none)'}`);

  if (ctrl.greetingDone && greetingAudio.length > 0 && responseAudio.length > 0) {
    console.log('\n✅  PASS — Nova 2 works end-to-end!');
    process.exit(0);
  } else if (ctrl.greetingDone && greetingAudio.length > 0) {
    console.log('\n⚠️   Greeting OK, response turn failed.');
    process.exit(1);
  } else if (ctrl.greetingDone) {
    console.log(`\n⚠️   completionEnd received but 0 audio bytes (voice "${VOICE_ID}" may be unavailable).`);
    console.log(`    Greeting text was: "${greetingText}"`);
    console.log(`    Try: NOVA_VOICE_ID=matthew or NOVA_VOICE_ID=tiffany`);
    process.exit(1);
  } else {
    console.log('\n❌  FAIL — No completionEnd. Stream closed without Nova generating any output.');
    console.log('    Verify in AWS Bedrock console:');
    console.log('      1. amazon.nova-2-sonic-v1:0 is enabled for model access');
    console.log('      2. IAM has bedrock:InvokeModelWithBidirectionalStream');
    console.log('      3. Try AWS_REGION=us-west-2 (Nova 2 availability varies by region)');
    process.exit(1);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
