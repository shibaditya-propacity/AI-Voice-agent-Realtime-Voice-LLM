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
    // When true: uses language=multi (Nova-3 streaming code-switching mode).
    // Handles English, Hindi, and Hinglish within the same call.
    // NOTE: detect_language=true is NOT used — it only works for pre-recorded
    // audio and returns HTTP 400 on the streaming WebSocket endpoint.
    // en-IN alone cannot decode Hindi phonemes → use multi for Hindi support.
    multilingual: optionalBool('DEEPGRAM_MULTILINGUAL', true),
    // 200ms silence → speech_final (proven stable; 150ms causes empty transcripts)
    endpointingMs: optionalInt('DEEPGRAM_ENDPOINTING_MS', 200),
    // 250ms silence → UtteranceEnd (proven stable)
    utteranceEndMs: optionalInt('DEEPGRAM_UTTERANCE_END_MS', 250),
  },

  llm: {
    // Groq API (primary — ultra-low latency, ~50-150ms TTFT)
    groqApiKey: required('GROQ_API_KEY'),
    // Bedrock/Anthropic credentials (kept for fallback, not currently used)
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
    region: optional('AWS_REGION', 'us-east-1'),
    // Groq model: llama-3.1-8b-instant (fastest)
    modelId: optional('LLM_MODEL_ID', 'llama-3.1-8b-instant'),
    // 40 tokens — slightly more than Anthropic's 30 since Llama tokenizes differently
    maxTokens: optionalInt('LLM_MAX_TOKENS', 40),
    // Lower temperature = more focused, faster sampling
    temperature: optionalFloat('LLM_TEMPERATURE', 0.3),
    topP: optionalFloat('LLM_TOP_P', 0.9),
    // Max conversation history messages sent to LLM. Caps context growth on long
    // calls — prevents TTFT degradation. 10 messages = 5 turns of context.
    historyWindow: optionalInt('LLM_HISTORY_WINDOW', 10),
    systemPrompt: optional(
      'LLM_SYSTEM_PROMPT',
      [
        'You are a real-estate sales caller (NOT support, NOT chatbot, NOT customer service).',
        'GOAL: Book a site visit.',
        'GREETING already played. Never greet again.',
        'FIRST RESPONSE AFTER NAME (MANDATORY — include ALL): "Hi {name}, I\'m calling from Akshay Vista. We have homes in Pimple Gurav near Hinjewadi. Would you like a site visit?" Do NOT skip: company name, project name, location, site visit ask.',
        'LANGUAGE: Match caller — English/Hindi/Hinglish. Prefer Hinglish over formal Hindi. Keep brand names, project names, locations, BHK, numbers always in English. Example correct: "Akshay Vista mein 2 BHK aur 3 BHK homes available hain." Example wrong: "do BHK aur teen BHK ghar uplabdh hain." Numbers always English: "forty five lakh" not "paintalis lakh".',
        'STYLE: 8-20 words normally. First intro can be slightly longer. One sentence preferred. Sound like a real sales caller.',
        'QUESTION HANDLING — answer briefly then ask for site visit:',
        '"Price kya hai?" → "Around eight to ten thousand per sq ft. Would you like a site visit?"',
        '"Location?" → "Pimple Gurav near Hinjewadi. Would you like to visit?"',
        '"Amenities?" → "Gym, EV charging and play area. Interested in a site visit?"',
        '"Possession?" → "April 2027. Would you like a site visit?"',
        'NAME RULE: Use caller name at most once. Never repeat name.',
        'TOKEN CONTROL: Max 30 tokens. Never generate long descriptions.',
        'INTERRUPTION: Stop immediately. Respond only to latest utterance.',
        'FACTS: 2/2.5/3 BHK | 8,000-10,000/sqft | Pimple Gurav nr Hinjewadi, Pune | Apr 2027 | 78 units | R.R. Lunkad | Akshay Vista',
      ].join('\n'),
    ),
    greetingPrompt: optional(
      'LLM_GREETING_PROMPT',
      'You are starting a call. Output only this exact sentence, nothing else: "Hi, I am Arjun, a real estate sales agent. May I know your name please?"',
    ),
  },

  elevenlabs: {
    apiKey: required('ELEVENLABS_API_KEY'),
    voiceId: required('ELEVENLABS_VOICE_ID'),
    modelId: optional('ELEVENLABS_MODEL_ID', 'eleven_flash_v2_5'),
    stability: optionalFloat('ELEVENLABS_STABILITY', 0.4),
    similarityBoost: optionalFloat('ELEVENLABS_SIMILARITY_BOOST', 0.8),
    // 1.05 = 5% faster speech — barely perceptible but reduces audio duration
    // and TTS generation time. Safe for conversational use.
    speed: optionalFloat('ELEVENLABS_SPEED', 1.05),
    optimizeLatency: optionalInt('ELEVENLABS_OPTIMIZE_LATENCY', 4),
  },

  bargeIn: {
    rmsThreshold: optionalInt('BARGEIN_RMS_THRESHOLD', 600),
    confirmMs: optionalInt('BARGEIN_CONFIRM_MS', 150),
    cooldownMs: optionalInt('BARGEIN_COOLDOWN_MS', 300),
    // How long after TTS starts before any barge-in can fire.
    // 600ms was too short: PSTN echo (RMS ~32512) sustained for 597ms triggered it
    // at 608ms — only 8ms past the grace period. 1500ms eliminates PSTN echo
    // false triggers while still catching real interruptions after 1.5s of speech.
    graceMs: optionalInt('BARGEIN_GRACE_MS', 1500),
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
