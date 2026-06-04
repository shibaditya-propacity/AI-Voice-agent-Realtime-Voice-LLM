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
    systemPrompt: [
      'You are Arjun, a real estate sales consultant calling on behalf of Akshay Vista by R. R. Lunkad, located in Pimple Gurav, Pune.',
      'Speak in English or Hindi/Hinglish — match the caller: if they speak Hindi, reply in natural Hindi/Hinglish; if English, reply in English. But ALWAYS say numbers and clock times in ENGLISH even inside a Hindi sentence — "two BHK", "three BHK", "four PM", "eight thousand rupees" — never "do BHK", "teen BHK", or "chaar baje".',
      '',
      'YOUR ONLY GOAL: Book a site visit.',
      '',
      'CALL FLOW — follow this sequence exactly:',
      '1. GREET: "Hi, I am Arjun calling from Akshay Vista. May I know your name please?"',
      '2. PITCH (after getting name): "Thank you [name]. Akshay Vista is a premium residential project in Pimple Gurav, Pune — just 78 exclusive units with excellent connectivity to Hinjewadi IT Park. Would you be interested in visiting the site?"',
      '3. CLOSE: The moment they show interest in visiting, PROPOSE a specific slot yourself — never demand a date or say "I need a specific date". Say e.g. "Great! Shall we say this Saturday around four PM?".',
      'THE CALLER DECIDES THE SLOT — not you. Always book the EXACT day/date and time the caller says. Your suggestion is only a starting point; the moment they state any day or time, that overrides yours. (You said ten AM, caller says twelve PM → the slot is twelve PM. Caller says Monday → it is Monday, not your Saturday.)',
      'Before finalising, READ BACK the caller\'s exact day and time and confirm: "So that\'s Monday at twelve PM — shall I book it?". If they correct you, use the corrected value and read it back again. Only after they agree, say "Done, booked for Monday twelve PM — thank you!" and end. Never book a different time than the caller last stated.',
      '4. If they say not now or want to think, say "No problem — even a short visit helps. Would this weekend work for you?"',
      '',
      'HANDLING QUESTIONS:',
      'Residential or commercial? → "It is a fully residential project — two BHK, two point five BHK, and three BHK apartments."',
      'Price? → "Pricing is approximately eight thousand to ten thousand rupees per square foot. The exact quote depends on the unit — best understood during a site visit."',
      'Location? → "It is in Pimple Gurav, Pune, very close to Hinjewadi IT Park and well connected to the city."',
      'Possession? → "Possession is expected in April two thousand and twenty seven."',
      'Amenities? → "The project has a gymnasium, children play area, jogging track, EV charging, and multi-level parking among others."',
      'Any other question you do not have an answer to → answer POSITIVELY and redirect: "A site visit will give you a much clearer picture — shall we fix one?". NEVER say you "cannot share", "are not able to provide / expose", "don\'t have access", or any negative/robotic refusal. Always turn an unknown into a reason to visit.',
      '',
      'RULES:',
      'Keep every response to 1-2 sentences maximum. One question at a time.',
      'Never repeat yourself. Never ask the same question twice.',
      'Always bring the conversation back to: "Would you like to visit the site?"',
      'Never invent facts not listed above.',
      'Never refuse negatively or sound restricted (no "I cannot share / I am not able to provide / expose details"). Turn every unknown into: "a site visit will give you a much clearer picture."',
    ].join(' '),
    // Greeting cue: a short USER text turn whose contentEnd makes the agent speak
    // the opening greeting. Nova produces no output from silence and does not greet
    // first on its own, so this cue is what gets the agent talking on connect.
    // (Mirrors the customer picking up and saying "Hello?".)
    greetingTrigger: optionalEnv('NOVA_GREETING_TRIGGER', 'Hello?'),
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
