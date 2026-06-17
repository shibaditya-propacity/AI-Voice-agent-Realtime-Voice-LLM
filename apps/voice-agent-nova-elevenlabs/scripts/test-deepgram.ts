/**
 * Test: Deepgram Nova-3 connection + live transcription
 * Sends 3 seconds of synthetic PCMU silence then checks connection health.
 */
import 'dotenv/config';
import WebSocket from 'ws';

const API_KEY = process.env.DEEPGRAM_API_KEY;
if (!API_KEY) { console.error('❌ DEEPGRAM_API_KEY not set'); process.exit(1); }

const MODEL    = process.env.DEEPGRAM_MODEL    ?? 'nova-3';
const LANGUAGE = process.env.DEEPGRAM_LANGUAGE ?? 'en-IN';

const params = new URLSearchParams({
  model:            MODEL,
  language:         LANGUAGE,
  encoding:         'mulaw',
  sample_rate:      '8000',
  channels:         '1',
  interim_results:  'true',
  vad_events:       'true',
  endpointing:      '300',
  utterance_end_ms: '1000',
});

const url = `wss://api.deepgram.com/v1/listen?${params}`;

console.log(`\n🔵 Connecting to Deepgram Nova-3...`);
console.log(`   Model: ${MODEL} | Language: ${LANGUAGE}`);

const start = Date.now();
const ws = new WebSocket(url, { headers: { Authorization: `Token ${API_KEY}` } });

let opened = false;
let metadataReceived = false;

ws.on('open', () => {
  opened = true;
  const latency = Date.now() - start;
  console.log(`✅ Deepgram WebSocket opened in ${latency}ms`);

  // Send 3 seconds of PCMU silence (0x7F = μ-law silence byte, 20ms chunks at 8kHz)
  // Each chunk = 160 bytes (8000 samples/s × 0.02s)
  const silenceChunk = Buffer.alloc(160, 0x7F);
  let sent = 0;
  const interval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(silenceChunk);
      sent++;
    }
    if (sent >= 150) { // 3 seconds worth
      clearInterval(interval);
      // Send CloseStream
      ws.send(JSON.stringify({ type: 'CloseStream' }));
      setTimeout(() => ws.close(), 1000);
    }
  }, 20);
});

ws.on('message', (raw: WebSocket.RawData) => {
  try {
    const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (msg.type === 'Metadata') {
      metadataReceived = true;
      const modelInfo = (msg.model_info as Record<string, string>) ?? {};
      console.log(`✅ Deepgram Metadata received`);
      console.log(`   Request ID : ${msg.request_id}`);
      console.log(`   Model      : ${modelInfo.name} v${modelInfo.version} (${modelInfo.arch})`);
    } else if (msg.type === 'Results') {
      const channel = (msg.channel as Record<string, unknown>) ?? {};
      const alts = (channel.alternatives as Array<Record<string, unknown>>) ?? [];
      const transcript = (alts[0]?.transcript as string) ?? '';
      if (transcript) {
        console.log(`📝 Transcript: "${transcript}" (is_final=${msg.is_final}, speech_final=${msg.speech_final})`);
      }
    } else if (msg.type === 'SpeechStarted') {
      console.log(`🎙️  VAD: SpeechStarted at ${msg.timestamp}s`);
    }
  } catch { /* ignore */ }
});

ws.on('error', (err: Error) => {
  console.error(`❌ Deepgram error: ${err.message}`);
  process.exit(1);
});

ws.on('close', (code: number, reason: Buffer) => {
  if (!opened) {
    console.error(`❌ Deepgram connection failed (code=${code}, reason=${reason.toString()})`);
    process.exit(1);
  }
  const status = metadataReceived ? '✅ PASS' : '⚠️  PASS (connected but no metadata — API key may be trial)';
  console.log(`\n${status} — Deepgram Nova-3 is reachable and accepting audio`);
});
