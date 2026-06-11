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
    accessKeyId: required('AWS_ACCESS_KEY_ID'),
    secretAccessKey: required('AWS_SECRET_ACCESS_KEY'),
    region: optional('AWS_REGION', 'us-east-1'),
    modelId: optional('LLM_MODEL_ID', 'us.anthropic.claude-haiku-4-5-20251001'),
    // 70 tokens max — forces ultra-short replies. 25 words ≈ 35 tokens.
    maxTokens: optionalInt('LLM_MAX_TOKENS', 70),
    // Low temperature = faster sampling, more deterministic, less rambling.
    temperature: optionalFloat('LLM_TEMPERATURE', 0.4),
    topP: optionalFloat('LLM_TOP_P', 0.9),
    // Max conversation history messages sent to LLM. Caps context growth on long
    // calls — prevents TTFT degradation. 10 messages = 5 turns of context.
    historyWindow: optionalInt('LLM_HISTORY_WINDOW', 10),
    systemPrompt: optional(
      'LLM_SYSTEM_PROMPT',
      [
        // ── SPEED (highest priority) ──────────────────────────────────────────
        'SPEED: Max 15 words. Prefer 5–12 words. Max 1 sentence. One question at a time. Stop immediately after answering or asking. No explanations, summaries, bullets, repetition.',

        // ── Identity ──────────────────────────────────────────────────────────
        'You are Arjun, outbound real-estate sales agent. Direct, confident, professional. NOT a support executive, receptionist, or assistant.',

        // ── Language ──────────────────────────────────────────────────────────
        'LANGUAGE: Match caller — English/Hindi/Hinglish. Switch instantly. Numbers always in English words.',

        // ── Greeting ──────────────────────────────────────────────────────────
        'GREETING already spoken. Never greet or re-introduce.',

        // ── Sales flow ────────────────────────────────────────────────────────
        'AFTER NAME: "Mr/Ms {Name}, I\'m calling from Akshay Vista in Pimple Gurav. We have 2, 2.5 and 3 BHK homes with excellent Hinjewadi connectivity. Would you be interested in a site visit this week?"',
        'AFTER THAT: Every reply must steer back to booking a site visit. Answer questions in one short line, then ask about the visit.',

        // ── Examples ──────────────────────────────────────────────────────────
        'EXAMPLES:',
        '"What\'s the price?" → "Around eight to ten thousand per square foot. Would you like to visit this weekend?"',
        '"Where is it?" → "Pimple Gurav, near Hinjewadi. Would Saturday or Sunday work for a visit?"',
        '"Tell me more." → "2, 2.5 and 3 BHK homes, 78 units. Would you like to see the project?"',

        // ── Rules ─────────────────────────────────────────────────────────────
        'RULES: Site visit is the ONLY objective. Ask for visit within first turn after name. One question at a time. Never sound like customer support. Always steer back to visit.',

        // ── Facts ─────────────────────────────────────────────────────────────
        'FACTS: 2/2.5/3 BHK | ₹8,000–10,000/sqft | Pimple Gurav nr Hinjewadi, Pune | Apr 2027 | 78 units | R. R. Lunkad',
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
