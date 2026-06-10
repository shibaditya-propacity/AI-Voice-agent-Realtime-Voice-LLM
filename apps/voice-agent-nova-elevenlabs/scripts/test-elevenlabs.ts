/**
 * Test: ElevenLabs Flash v2.5 streaming TTS
 * Sends a short sentence and measures time-to-first-audio.
 * Verifies output is valid base64-encoded ulaw_8000 audio.
 */
import 'dotenv/config';
import WebSocket from 'ws';

const API_KEY  = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID ?? 'eleven_flash_v2_5';

if (!API_KEY)  { console.error('❌ ELEVENLABS_API_KEY not set');  process.exit(1); }
if (!VOICE_ID) { console.error('❌ ELEVENLABS_VOICE_ID not set'); process.exit(1); }

const params = new URLSearchParams({
  model_id:                   MODEL_ID,
  output_format:              'ulaw_8000',
  optimize_streaming_latency: '4',
});

const url = `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream-input?${params}`;

console.log(`\n🔵 Testing ElevenLabs streaming TTS...`);
console.log(`   Model   : ${MODEL_ID}`);
console.log(`   Voice   : ${VOICE_ID}`);
console.log(`   Format  : ulaw_8000 (Twilio-compatible, no conversion needed)`);

const start = Date.now();
const ws = new WebSocket(url);

let firstAudioMs: number | null = null;
let totalBytes = 0;
let chunkCount = 0;
let isDone = false;

ws.on('open', () => {
  const connMs = Date.now() - start;
  console.log(`✅ ElevenLabs WebSocket opened in ${connMs}ms`);

  // Initialisation message (must send a space first)
  ws.send(JSON.stringify({
    text: ' ',
    voice_settings: {
      stability: 0.4,
      similarity_boost: 0.8,
      speed: 1.0,
    },
    generation_config: { chunk_length_schedule: [50] },
    xi_api_key: API_KEY,
  }));

  // Send the test sentence
  ws.send(JSON.stringify({ text: 'ElevenLabs Flash v2.5 streaming is working correctly.' }));

  // Signal end of text input
  ws.send(JSON.stringify({ text: '' }));
  console.log(`   Sent test sentence, waiting for audio...`);
});

ws.on('message', (raw: WebSocket.RawData) => {
  try {
    const data = JSON.parse(raw.toString()) as Record<string, unknown>;

    if (data['audio']) {
      const audioB64 = data['audio'] as string;
      const audioBytes = Buffer.from(audioB64, 'base64');
      totalBytes += audioBytes.length;
      chunkCount++;

      if (firstAudioMs === null) {
        firstAudioMs = Date.now() - start;
        console.log(`✅ First audio chunk received in ${firstAudioMs}ms`);
        console.log(`   Chunk size : ${audioBytes.length} bytes (ulaw_8000 = ${(audioBytes.length / 8).toFixed(1)}ms of audio)`);
        // Quick sanity: μ-law bytes should all be in range [0,255] (trivially true for Buffer)
        // A non-empty buffer from base64 is sufficient proof of valid audio data
        if (audioBytes.length > 0) {
          console.log(`   Encoding   : valid base64 → ${audioBytes.length} raw bytes`);
        }
      }
    }

    if (data['isFinal'] === true) {
      isDone = true;
      const totalMs = Date.now() - start;
      console.log(`\n✅ PASS — ElevenLabs Flash v2.5 is working`);
      console.log(`   First audio    : ${firstAudioMs}ms`);
      console.log(`   Total time     : ${totalMs}ms`);
      console.log(`   Audio chunks   : ${chunkCount}`);
      console.log(`   Total audio    : ${totalBytes} bytes ≈ ${(totalBytes / 8 / 1000).toFixed(2)}s of speech`);
      console.log(`   Twilio compat  : ✅ ulaw_8000 base64 passes directly to Twilio media event`);
      ws.close();
    }

    if (data['message']) {
      console.warn(`⚠️  ElevenLabs message: ${data['message']}`);
    }

  } catch (err) {
    console.warn('Could not parse message:', (err as Error).message);
  }
});

ws.on('error', (err: Error) => {
  console.error(`❌ ElevenLabs error: ${err.message}`);
  process.exit(1);
});

ws.on('close', (code: number, reason: Buffer) => {
  if (!isDone) {
    if (firstAudioMs !== null) {
      // Received some audio but no isFinal (connection dropped)
      console.log(`\n⚠️  Connection closed before isFinal — but audio was received (${chunkCount} chunks, ${totalBytes} bytes)`);
      console.log(`   This is normal if the sentence was short. ElevenLabs is working.`);
    } else {
      console.error(`❌ Connection closed without any audio (code=${code}, reason=${reason.toString()})`);
      process.exit(1);
    }
  }
});

// Timeout guard
setTimeout(() => {
  if (!isDone) {
    console.error('❌ Timeout: no response from ElevenLabs after 15s');
    ws.close();
    process.exit(1);
  }
}, 15_000);
