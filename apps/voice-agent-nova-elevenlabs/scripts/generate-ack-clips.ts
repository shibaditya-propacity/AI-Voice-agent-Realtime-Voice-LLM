/**
 * generate-ack-clips.ts
 *
 * One-time script: generates short acknowledgement audio clips via Sarvam TTS
 * REST API and saves them as raw ulaw 8kHz mono files in assets/ack/.
 *
 * Usage:
 *   npx ts-node -r dotenv/config scripts/generate-ack-clips.ts
 *
 * Also regenerates assets/greet.raw for the cached greeting.
 * Requires SARVAM_API_KEY in .env.
 */

import * as fs from 'fs';
import * as path from 'path';

const SARVAM_REST_URL = 'https://api.sarvam.ai/text-to-speech';
const ACK_DIR = path.resolve(__dirname, '../assets/ack');
const ASSETS_DIR = path.resolve(__dirname, '../assets');

const ACK_PHRASES: Record<string, string> = {
  'ack_moment':   'बस एक moment।',
  'ack_checking': 'देखता हूँ।',
  'ack_second':   'बस एक second।',
};

const GREETING = 'Hi, मैं Arjun, R.R. Lunkad की Akshay Vista से। Site visit में interested होंगे?';

// PCM 16-bit linear → 8-bit mulaw conversion (ITU-T G.711)
function linearToMulaw(sample: number): number {
  const MULAW_MAX = 0x1FFF;
  const MULAW_BIAS = 33;
  const sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > MULAW_MAX) sample = MULAW_MAX;
  sample = sample + MULAW_BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

function pcm16ToMulaw(pcmBuf: Buffer): Buffer {
  const n = pcmBuf.length / 2;
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = linearToMulaw(pcmBuf.readInt16LE(i * 2));
  return out;
}

function extractRawFromWav(wavBuf: Buffer): Buffer {
  let dataOffset = 44;
  for (let i = 0; i < wavBuf.length - 4; i++) {
    if (wavBuf.toString('ascii', i, i + 4) === 'data') { dataOffset = i + 8; break; }
  }
  return pcm16ToMulaw(wavBuf.subarray(dataOffset));
}

async function generateClip(name: string, text: string, outDir: string): Promise<void> {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error('SARVAM_API_KEY not set');

  console.log(`  [gen]  ${name}: "${text}"`);
  const res = await fetch(SARVAM_REST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-subscription-key': apiKey },
    body: JSON.stringify({
      inputs: [text],
      target_language_code: 'hi-IN',
      speaker: process.env.SARVAM_SPEAKER || 'shubh',
      model: process.env.SARVAM_MODEL_ID || 'bulbul:v3',
      speech_sample_rate: 8000,
      enable_preprocessing: true,
      pace: 1.05,
    }),
  });

  if (!res.ok) throw new Error(`Sarvam API error ${res.status}: ${await res.text()}`);
  const json = await res.json() as { audios?: string[] };
  if (!json.audios?.[0]) throw new Error(`No audio returned for "${name}"`);

  const rawBuf = extractRawFromWav(Buffer.from(json.audios[0], 'base64'));
  const outPath = path.join(outDir, `${name}.raw`);
  fs.writeFileSync(outPath, rawBuf);
  console.log(`  [done] ${name}.raw — ${rawBuf.length} bytes, ${Math.round((rawBuf.length / 8000) * 1000)}ms`);
}

async function main(): Promise<void> {
  console.log('Generating acknowledgement clips...');
  fs.mkdirSync(ACK_DIR, { recursive: true });
  for (const [name, text] of Object.entries(ACK_PHRASES)) {
    await generateClip(name, text, ACK_DIR);
  }

  console.log('\nGenerating greeting...');
  await generateClip('greet', GREETING, ASSETS_DIR);

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
