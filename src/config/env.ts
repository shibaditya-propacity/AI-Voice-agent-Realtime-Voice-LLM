/**
 * Environment variable validation and typed configuration.
 * Fails fast at startup if required variables are missing.
 */

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`[Config] Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

function optionalInt(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new Error(`[Config] Environment variable ${key} must be an integer, got: "${raw}"`);
  }
  return parsed;
}

function optionalFloat(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = parseFloat(raw);
  if (isNaN(parsed)) {
    throw new Error(`[Config] Environment variable ${key} must be a number, got: "${raw}"`);
  }
  return parsed;
}

function optionalBool(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  return raw.toLowerCase() === 'true' || raw === '1';
}

// ─── Validated Configuration ─────────────────────────────────────────────────

export const Env = {
  server: {
    port: optionalInt('PORT', 8080),
    nodeEnv: optionalEnv('NODE_ENV', 'development'),
    get isProduction() {
      return this.nodeEnv === 'production';
    },
  },

  // ── Knowlarity (commented out — replaced by Twilio) ──────────────────────
  // knowlarity: {
  //   apiKey: requireEnv('KNOWLARITY_API_KEY'),
  //   apiSecret: requireEnv('KNOWLARITY_API_SECRET'),
  //   srNumber: optionalEnv('KNOWLARITY_SR_NUMBER', ''),
  //   callerId: optionalEnv('KNOWLARITY_CALLER_ID', ''),
  //   apiUrl: optionalEnv('KNOWLARITY_API_URL', 'https://kpi.knowlarity.com'),
  //   mediaWsUrl: optionalEnv('KNOWLARITY_MEDIA_WS_URL', 'wss://media.knowlarity.com'),
  //   webhookUrl: optionalEnv('KNOWLARITY_WEBHOOK_URL', ''),
  // },

  twilio: {
    accountSid: requireEnv('TWILIO_ACCOUNT_SID'),
    authToken: requireEnv('TWILIO_AUTH_TOKEN'),
    phoneNumber: requireEnv('TWILIO_PHONE_NUMBER'),
    // Public HTTPS URL of this server — Twilio will POST webhooks here
    webhookBaseUrl: optionalEnv('TWILIO_WEBHOOK_BASE_URL', ''),
  },

  krisp: {
    // API key removed — Krisp SDK is initialised via local model files only
    modelPath: optionalEnv('KRISP_MODEL_PATH', './krisp_models'),
    // Optional: path to a Krisp license file (leave empty if not required by your SDK version)
    licensePath: optionalEnv('KRISP_LICENSE_PATH', ''),
    frameSizeSamples: optionalInt('KRISP_FRAME_SIZE_SAMPLES', 160),
  },

  aws: {
    accessKeyId: requireEnv('AWS_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('AWS_SECRET_ACCESS_KEY'),
    region: optionalEnv('AWS_REGION', 'us-east-1'),
  },

  nova: {
    modelId: optionalEnv('NOVA_MODEL_ID', 'amazon.nova-2-sonic-v1:0'),
    // System prompt is hardcoded here — edit this source line to change agent behaviour.
    // Do NOT put the prompt in the .env file (NOVA_SYSTEM_PROMPT in .env is ignored).
    // Condensed prompt: every behavioral rule and fact below is preserved, but the
    // previously-duplicated INTERRUPTIONS / POST-INTERRUPTION / RULES restatements
    // are merged. A shorter system prompt means less prefill before Nova's first
    // response, cutting per-turn (and post-greeting) latency.
    systemPrompt: [
      // ── Identity ──
      'You are Arjun — a calm, confident, professional real estate sales caller for Akshay Vista by R. R. Lunkad, Pimple Gurav, Pune.',
      'You are a real Indian person having a phone conversation. You are NOT a chatbot, NOT an assistant, NOT reading a script.',
      '',
      // ── Language ──
      'LANGUAGE: Default English.',
      'If the caller asks for Hindi, say "Ji bilkul, main Hinglish mein baat kar sakta hoon" and switch to natural Hinglish.',
      'Never say "main Hindi mein baat kar sakta hoon" or "main shuddh Hindi mein baat kar sakta hoon."',
      'Stay in the chosen language until they switch back.',
      '',
      // ── Hinglish rules ──
      'HINGLISH RULES: Speak like an educated Indian professional on a phone call, not a translator.',
      'ALWAYS keep these in English even inside Hinglish: numbers, dates, days (Monday, Tuesday...), months, prices, percentages, BHK, brand names, company names, project names, area names, city names.',
      'Good: "Aaj Tuesday hai", "2 BHK available hai", "Price 45 lakh se start hoti hai."',
      'Bad: "Aaj Mangalvaar hai", "Do bedroom hall kitchen", "Paintaalis lakh."',
      '',
      // ── Human conversation style ──
      'SPEAKING STYLE: Short sentences. Natural wording. Conversational flow. 1-3 sentences max per reply, one question at a time.',
      'Use natural responses: ji, haan, okay, alright, samajh gaya, theek hai, bilkul, sure.',
      'NEVER use: "very good", "bohot accha", "excellent", "wonderful", "absolutely fantastic", repeated enthusiasm, corporate language, assistant-style language.',
      'Occasionally (5-10% of replies) use natural fillers: ji, okay, alright, ek second, let me check.',
      'Sound calm, confident, professional and human. You are having a phone conversation, not writing an email.',
      '',
      // ── Greeting ──
      'GREETING ALREADY PLAYED: The caller heard "Hi, I am Arjun calling from Akshay Vista. May I know your name please?" Their first words reply to this. Never re-greet or reintroduce yourself.',
      '',
      // ── Goal and stages ──
      'GOAL: Book a site visit. Follow stages in order. Never skip or assume unspoken agreement.',
      '',
      'STAGE 1 — NAME: Capture their name. If missing, ask once warmly. Don\'t advance without it.',
      'STAGE 2 — DISCOVERY: Briefly introduce — 78 exclusive units in Pimple Gurav, great Hinjewadi connectivity — then ask BHK preference (2, 2.5, or 3 BHK). Accept if volunteered anytime.',
      'STAGE 3 — VISIT: Ask if they\'d like to visit the site. Need explicit yes. "Yes" to a property question does NOT mean visit agreement — ask about the visit separately. If hesitant, suggest a quick weekend visit.',
      'STAGE 4 — SCHEDULE: Suggest a slot casually. Caller\'s choice always overrides yours. Read back their exact day and time to confirm. If corrected, accept and re-confirm. Once confirmed, book it, thank them, wrap up.',
      '',
      // ── Conversation rules ──
      'RULES: One utterance = one answer. "Yes"/"haan" confirms only your last question. Never advance two stages at once.',
      'On interruption: capture any info shared (name, BHK, timing), continue forward from your current stage — never repeat what was cut off, never apologise, never say "as I was saying."',
      '',
      // ── Facts ──
      'FACTS — answer briefly, return to your current stage:',
      'Fully residential. 2, 2.5, 3 BHK options.',
      'Price: approximately 8,000 to 10,000 per square foot — best discussed at a visit.',
      'Location: Pimple Gurav, near Hinjewadi IT Park.',
      'Possession: April 2027.',
      'Amenities: gym, play area, jogging track, EV charging, covered parking.',
      'Unknown question: stay positive, suggest a visit. Never say "I cannot share that." Never invent facts.',
      '',
      // ── Silence handling ──
      'SILENCE: Bracketed instructions like [The caller has been silent...] — say exactly what they ask, nothing else.',
    ].join(' '),
    // Static opening greeting. Nova 2 Sonic does NOT speak first (it only responds
    // to caller audio), so the opening greeting is a pre-recorded WAV played the
    // instant the call connects. Put a 1–2s recording of the Stage-1 greeting here.
    // Loaded once at boot, resampled, and cached. If the file is missing/invalid the
    // agent simply has no opening greeting (it still responds once the caller speaks).
    // Must be 16-bit PCM WAV (any sample rate / mono or stereo).
    greetingWavPath: optionalEnv('NOVA_GREETING_WAV_PATH', './assets/greeting.wav'),
    maxTokens: optionalInt('NOVA_MAX_TOKENS', 512),
    temperature: optionalFloat('NOVA_TEMPERATURE', 0.7),
    topP: optionalFloat('NOVA_TOP_P', 0.9),
    // Nova 2 voices: arjun (Indian English + Hindi), tiffany (US female), matthew (US male), amy (British)
    // 'arjun' is required for Hindi/Indian English code-switching — DO use with telephony/PCMU.
    // The audio pipeline converts Nova's PCM16 output → PCMU, so all voices work with telephony.
    voiceId: optionalEnv('NOVA_VOICE_ID', 'arjun'),
    // How quickly Nova decides the caller finished speaking:
    //   HIGH = fastest reply but clips callers at natural pauses (dropped words,
    //          choppy turns, name loops); MEDIUM = waits for full utterances
    //          (recommended); LOW = most patient.
    // Defaults to MEDIUM (best balance for telephony). Override with
    // NOVA_ENDPOINTING_SENSITIVITY. For Nova 1 (which rejects this field) set the
    // env var to "NONE" to omit it.
    endpointingSensitivity:
      process.env.NOVA_ENDPOINTING_SENSITIVITY === 'NONE'
        ? undefined
        : (optionalEnv('NOVA_ENDPOINTING_SENSITIVITY', 'MEDIUM') as 'HIGH' | 'MEDIUM' | 'LOW'),
    // Sample rate Nova produces its SPEECH OUTPUT at. Nova Sonic's native rate is
    // 24000Hz. The outbound pipeline downsamples this to 8kHz telephony — it MUST
    // match what Nova actually emits or playback sounds slow/garbled ("harsh").
    // If audio still sounds wrong, try 16000 here. (Input audio stays at
    // internalSampleRate; this is output only.)
    audioOutputSampleRate: optionalInt('NOVA_OUTPUT_SAMPLE_RATE', 24000),
    // How often to re-warm the Bedrock connection so it never idles out between
    // calls (keeps the first call after a quiet period fast). AWS idle-closes HTTP/2
    // connections after ~5 min, so re-warm a bit under that. Set 0 to disable.
    prewarmIntervalMs: optionalInt('NOVA_PREWARM_INTERVAL_MS', 240_000),
    // If the caller says nothing for this many ms after the agent finishes speaking,
    // inject a silence re-engagement cue so Nova asks "Are you still there?".
    // Set to 0 to disable silence re-engagement entirely.
    silenceTimeoutMs: optionalInt('NOVA_SILENCE_TIMEOUT_MS', 3_000),
    // Text injected as a USER turn when silence is detected. Nova responds to this
    // cue with the re-engagement phrase defined in its system prompt context.
    silencePrompt: optionalEnv('NOVA_SILENCE_PROMPT', '[The caller has been silent for several seconds. Say exactly: "I may not have heard you. Are you still there?"]'),
  },

  audio: {
    telephonyCodec: optionalEnv('TELEPHONY_CODEC', 'pcmu') as 'pcmu' | 'pcma' | 'pcm16',
    telephonySampleRate: optionalInt('TELEPHONY_SAMPLE_RATE', 8000),
    internalSampleRate: optionalInt('INTERNAL_SAMPLE_RATE', 16000),
    chunkMs: optionalInt('AUDIO_CHUNK_MS', 20),
    bufferMaxBytes: optionalInt('AUDIO_BUFFER_MAX_BYTES', 32768),
    // Energy-VAD thresholds used to timestamp caller speech-end for latency
    // measurement (int16 RMS, and sustained-silence window in ms).
    vadRmsThreshold: optionalInt('VAD_RMS_THRESHOLD', 700),
    vadSilenceHangoverMs: optionalInt('VAD_SILENCE_HANGOVER_MS', 120),
    // Proactive client-side barge-in: immediately interrupt agent playback when the
    // caller's RMS energy exceeds vadRmsThreshold, WITHOUT waiting for Nova's own VAD.
    // DEFAULT OFF. Nova 2 Sonic handles barge-in natively and gracefully; this RMS
    // heuristic false-triggers on telephony echo of the agent's own voice and on
    // caller backchannel ("haan", "ok"), cancelling the agent's turn with no
    // replacement → the agent goes silent (notably when the caller talks over it,
    // e.g. asking to switch to Hindi). Enable only if you specifically need
    // interruption faster than Nova's endpointing.
    proactiveBargeIn: optionalBool('AUDIO_PROACTIVE_BARGEIN', false),
  },

  session: {
    maxConcurrentCalls: optionalInt('MAX_CONCURRENT_CALLS', 100),
    idleTimeoutMs: optionalInt('SESSION_IDLE_TIMEOUT_MS', 600_000),
  },

  logging: {
    level: optionalEnv('LOG_LEVEL', 'info'),
    pretty: optionalBool('LOG_PRETTY', false),
  },
} as const;

export type EnvConfig = typeof Env;
