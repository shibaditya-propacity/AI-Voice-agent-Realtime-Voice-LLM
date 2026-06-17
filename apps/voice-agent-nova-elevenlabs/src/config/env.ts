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
    // 150ms silence → speech_final (tight but reliable on Nova-3 Hindi;
    // saves ~150ms per turn vs 300ms; 100ms causes split-utterance false finals)
    endpointingMs: optionalInt('DEEPGRAM_ENDPOINTING_MS', 150),
    // 1000ms silence → UtteranceEnd (Deepgram minimum is 1000ms for this param;
    // values below 1000 return HTTP 400. The is_final self-flush timer handles fast flushing.)
    utteranceEndMs: optionalInt('DEEPGRAM_UTTERANCE_END_MS', 1000),
    // Minimum confidence to accept a final transcript (0.0–1.0).
    // Transcripts below this are treated as noise and discarded.
    minConfidence: optionalFloat('DEEPGRAM_MIN_CONFIDENCE', 0.4),

    // ── Speculative Stable Interim Settings ─────────────────────────────
    // Base stability window (ms) — how long interim text must stay unchanged.
    // Lower = faster speculation but more invalidations. 120ms is sweet spot.
    stableInterimBaseMs: optionalInt('DEEPGRAM_STABLE_INTERIM_BASE_MS', 120),
    // Extended window for short transcripts (≤8 chars / ~1-2 words).
    // Prevents firing on "what", "मेरा" etc. 300ms lets more words arrive.
    stableInterimShortMs: optionalInt('DEEPGRAM_STABLE_INTERIM_SHORT_MS', 300),
    // Character threshold below which the extended window is used.
    stableShortCharThreshold: optionalInt('DEEPGRAM_STABLE_SHORT_CHAR_THRESHOLD', 8),
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
    // 24 tokens — hard cap for sub-second turns; keeps replies to ~one short
    // sentence (the model was overrunning "12 words" at 30 tokens / ~117 chars).
    // Shorter cap = fewer tokens to generate = lower total LLM time and earlier flush.
    maxTokens: optionalInt('LLM_MAX_TOKENS', 24),
    // Lower temperature = more focused, faster sampling
    temperature: optionalFloat('LLM_TEMPERATURE', 0.3),
    topP: optionalFloat('LLM_TOP_P', 0.9),
    // Speculative LLM generation from stable interims. Disabled by default:
    // it could drop the real answer on a mismatch (caller hears silence). The
    // ~150ms saving is not worth the reliability cost on a sales call.
    speculationEnabled: optionalBool('LLM_SPECULATION_ENABLED', false),
    // Max conversation history messages sent to LLM. Caps context growth on long
    // calls — prevents TTFT degradation. 4 messages = 2 turns of context.
    // Business state lives in [SESSION_STATE], NOT in history, so a tight window
    // is safe: the model never forgets collected info even after eviction.
    historyWindow: optionalInt('LLM_HISTORY_WINDOW', 4),
    // Slim, static persona + style core (~110 tokens). Facts live in
    // [PROPERTY_FACTS] and live state/instructions in [SESSION_STATE] +
    // [NEXT_ACTION], both injected at runtime. Keeping booking logic, the
    // site-visit workflow, and anti-hallucination rules OUT of this prompt is
    // deliberate: those are enforced in code (state machine + validation),
    // not by repeating instructions the small model often ignores.
    systemPrompt: optional(
      'LLM_SYSTEM_PROMPT',
      [
        '[ROLE] You are Arjun, a warm, professional OUTBOUND real estate sales consultant at Akshay Vista, Pune — a real person, never an AI, never break character. This is a sales call; your objective is to book a site visit.',
        'Speak natural Hinglish: Hindi in Devanagari, names and numbers in English. Say "8 thousand", not "8000".',
        'Reply in ONE short, crisp sentence — max 10 words, at most one question, no filler or repetition. Respond only to the latest message.',
        'ALWAYS answer the caller\'s question first using ONLY [PROPERTY_FACTS] — never ignore a question to push the visit, and never invent prices, sizes, dates, or amenities.',
        'After answering, guide toward a site visit as the natural next step using consultative lines ("project देखकर clarity बेहतर आएगी") — but never pitch it every single turn.',
        'Use only info marked ✓ in [SESSION_STATE]; never re-ask it. Address the caller by name once known.',
        'Do exactly what [NEXT_ACTION] says, nothing more. The opener already played — never greet again.',
      ].join('\n'),
    ),
    greetingPrompt: optional(
      'LLM_GREETING_PROMPT',
      'Hello, मैं Arjun बोल रहा हूँ, मैं एक real estate sales consultant हूँ, आपका नाम बता सकते हैं?',
    ),
  },

  // ─── TTS Provider Toggle ─────────────────────────────────────────────────
  // Set TTS_PROVIDER=sarvam to use Sarvam AI Bulbul v3, or elevenlabs for ElevenLabs.
  ttsProvider: optional('TTS_PROVIDER', 'sarvam') as 'elevenlabs' | 'sarvam',

  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY ?? '',
    voiceId: process.env.ELEVENLABS_VOICE_ID ?? '',
    modelId: optional('ELEVENLABS_MODEL_ID', 'eleven_flash_v2_5'),
    stability: optionalFloat('ELEVENLABS_STABILITY', 0.4),
    similarityBoost: optionalFloat('ELEVENLABS_SIMILARITY_BOOST', 0.8),
    // 1.05 = 5% faster speech — barely perceptible but reduces audio duration
    // and TTS generation time. Safe for conversational use.
    speed: optionalFloat('ELEVENLABS_SPEED', 1.05),
    optimizeLatency: optionalInt('ELEVENLABS_OPTIMIZE_LATENCY', 4),
  },

  sarvam: {
    apiKey: required('SARVAM_API_KEY'),
    modelId: optional('SARVAM_MODEL_ID', 'bulbul:v3'),
    speaker: optional('SARVAM_SPEAKER', 'shubh'),
    targetLanguageCode: optional('SARVAM_TARGET_LANGUAGE', 'hi-IN'),
    // 1.05 = 5% faster speech — matches ElevenLabs speed setting
    pace: optionalFloat('SARVAM_PACE', 1.05),
    temperature: optionalFloat('SARVAM_TEMPERATURE', 0.7),
  },

  humanization: {
    enabled: optionalBool('ENABLE_HUMANIZATION', true),
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
