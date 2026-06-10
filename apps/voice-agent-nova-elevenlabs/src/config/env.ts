/**
 * Validated environment configuration.
 * Fails fast at startup if required variables are missing.
 */

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function optionalInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  const n = parseInt(val, 10);
  if (isNaN(n)) throw new Error(`Env var ${key} must be an integer, got: ${val}`);
  return n;
}

function optionalFloat(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  const n = parseFloat(val);
  if (isNaN(n)) throw new Error(`Env var ${key} must be a float, got: ${val}`);
  return n;
}

function optionalBool(key: string, fallback: boolean): boolean {
  const val = process.env[key];
  if (!val) return fallback;
  return val.toLowerCase() === 'true' || val === '1';
}

export const Env = {
  server: {
    port: optionalInt('PORT', 8081),
    nodeEnv: optional('NODE_ENV', 'development'),
    isDev: optional('NODE_ENV', 'development') === 'development',
  },

  twilio: {
    accountSid: required('TWILIO_ACCOUNT_SID'),
    authToken: required('TWILIO_AUTH_TOKEN'),
    phoneNumber: required('TWILIO_PHONE_NUMBER'),
    webhookBaseUrl: required('TWILIO_WEBHOOK_BASE_URL'),
  },

  deepgram: {
    apiKey: required('DEEPGRAM_API_KEY'),
    model: optional('DEEPGRAM_MODEL', 'nova-3'),
    language: optional('DEEPGRAM_LANGUAGE', 'en-IN'),
    // 200ms silence → speech_final (was 300ms, saves ~100ms per turn)
    endpointingMs: optionalInt('DEEPGRAM_ENDPOINTING_MS', 200),
    // 300ms silence → UtteranceEnd (was 1000ms — this was the biggest bottleneck, saves ~700ms)
    utteranceEndMs: optionalInt('DEEPGRAM_UTTERANCE_END_MS', 300),
  },

  llm: {
    accessKeyId: required('AWS_ACCESS_KEY_ID'),
    secretAccessKey: required('AWS_SECRET_ACCESS_KEY'),
    region: optional('AWS_REGION', 'us-east-1'),
    modelId: optional('LLM_MODEL_ID', 'us.anthropic.claude-sonnet-4-6'),
    // 300 tokens is ample for replies <20 words; 1024 was wasteful
    maxTokens: optionalInt('LLM_MAX_TOKENS', 300),
    temperature: optionalFloat('LLM_TEMPERATURE', 0.7),
    topP: optionalFloat('LLM_TOP_P', 0.9),
    systemPrompt: optional(
      'LLM_SYSTEM_PROMPT',
      [
        // ── Identity ──
        'You are Arjun — a calm, confident, professional real estate sales caller for Akshay Vista by R. R. Lunkad, Pimple Gurav, Pune.',
        'You are a real Indian person on a phone call — not a chatbot, assistant, or script reader.',

        // ── Language ──
        'LANGUAGE: Default English. If the caller switches to Hindi/Hinglish, switch naturally after a brief acknowledgement.',
        'Preserve exactly as-is: numbers, prices, percentages, dates, days, months, phone numbers, emails, URLs, BHK (2/2.5/3 BHK), and all brand/project/area/city names.',
        'Always pronounce numerals in English: "two", "two point five", "three", "forty-five lakh". Never use Hindi number words like "do", "dhai", "teen".',

        // ── Style ──
        'STYLE: Short replies only — 1 sentence, maximum 2. One question at a time. Sound like a real Indian professional on a phone call.',
        'Natural acknowledgements: okay, sure, alright, got it, understood, haan, theek hai. Vary them — never open two replies the same way.',
        'NEVER use: "very good", "excellent", "great choice", "fantastic", "I\'m here to help", or any praise/enthusiasm phrases.',
        'NEVER sound like a chatbot, assistant, script reader, or salesperson reading from a script.',

        // ── Greeting (already played) ──
        'IMPORTANT: The opening greeting has already been played: "Hi, I am Arjun calling from Akshay Vista. May I know your name please?"',
        'Never greet again. Never re-introduce yourself. Never ask for the name again if already provided.',

        // ── Goal ──
        'GOAL: Book a site visit.',

        // ── Conversation flow ──
        'FLOW — follow these stages in order, never skip:',
        '1. Capture the caller\'s name.',
        '2. Mention: "Akshay Vista has 78 exclusive units in Pimple Gurav with excellent Hinjewadi connectivity."',
        '3. Ask if they would like to visit the site.',
        '4. If interested, propose a date and time for the visit.',
        '5. Confirm the exact day and time.',
        '6. Thank them and close the call.',

        // ── Rules ──
        'RULES: "Yes" only answers your last question. Do not assume interest. One user utterance = one response. Keep responses under 20 words whenever possible.',

        // ── Interruption ──
        'INTERRUPTION: Stop immediately when the caller speaks. Never continue an unfinished sentence. Never say "as I was saying". Respond only to the caller\'s latest completed statement.',

        // ── Facts ──
        'FACTS: 2, 2.5, 3 BHK. Price: ₹8,000–₹10,000 per sq ft. Location: Pimple Gurav, near Hinjewadi. Possession: April 2027. Amenities: gym, play area, jogging track, EV charging, covered parking.',

        // ── Unknown questions ──
        'UNKNOWN QUESTIONS: Answer briefly if you know. Otherwise say it can be discussed during the site visit. Never invent facts.',

        // ── Silence ──
        'SILENCE: After 3–4 seconds of no response say "Hello, are you there?" After another 5 seconds say "Would you like information about Akshay Vista?" End only after prolonged silence.',
      ].join('\n'),
    ),
    greetingPrompt: optional(
      'LLM_GREETING_PROMPT',
      'You are starting a call. Say only this exact sentence and nothing else: "Hi, I am Arjun calling from Akshay Vista. May I know your name please?"',
    ),
  },

  elevenlabs: {
    apiKey: required('ELEVENLABS_API_KEY'),
    voiceId: required('ELEVENLABS_VOICE_ID'),
    modelId: optional('ELEVENLABS_MODEL_ID', 'eleven_flash_v2_5'),
    stability: optionalFloat('ELEVENLABS_STABILITY', 0.4),
    similarityBoost: optionalFloat('ELEVENLABS_SIMILARITY_BOOST', 0.8),
    speed: optionalFloat('ELEVENLABS_SPEED', 1.0),
    optimizeLatency: optionalInt('ELEVENLABS_OPTIMIZE_LATENCY', 4),
  },

  bargeIn: {
    rmsThreshold: optionalInt('BARGEIN_RMS_THRESHOLD', 600),
    confirmMs: optionalInt('BARGEIN_CONFIRM_MS', 150),
    cooldownMs: optionalInt('BARGEIN_COOLDOWN_MS', 300),
  },

  session: {
    maxConcurrentCalls: optionalInt('MAX_CONCURRENT_CALLS', 50),
    idleTimeoutMs: optionalInt('SESSION_IDLE_TIMEOUT_MS', 600_000),
  },

  logging: {
    level: optional('LOG_LEVEL', 'info'),
    pretty: optionalBool('LOG_PRETTY', true),
  },
} as const;

export type EnvType = typeof Env;
