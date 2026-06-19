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

    // ── Keyword Boosting ────────────────────────────────────────────────
    // Deepgram keyword boosting: domain-specific terms that the Hindi acoustic
    // model commonly misrecognizes (e.g. "site visit" → "certificate").
    // Format: comma-separated "term:intensifier" pairs. Intensifier 1-10.
    // These are sent as the `keywords` query param on the Deepgram WS URL.
    keywords: optional(
      'DEEPGRAM_KEYWORDS',
      'site visit:5,site:3,visit:3,amenities:2,BHK:3,possession:2,schedule:2,interested:2,morning:1,afternoon:1,evening:1,book:2,booking:2',
    ),

    // ── Transcript Validation (noise/filler rejection) ──────────────────
    // Minimum character length for a transcript to be accepted.
    minTranscriptLength: optionalInt('DEEPGRAM_MIN_TRANSCRIPT_LENGTH', 2),
    // Minimum speech segment duration (ms) to accept a transcript.
    // Shorter segments are rejected unless confidence exceeds highConfidenceBypass.
    minSpeechDurationMs: optionalInt('DEEPGRAM_MIN_SPEECH_DURATION_MS', 200),
    // Confidence above which the duration gate is bypassed (very clear short speech).
    highConfidenceBypass: optionalFloat('DEEPGRAM_HIGH_CONFIDENCE_BYPASS', 0.85),
    // Adaptive confidence thresholds by transcript length:
    //   - Short (1-2 chars): likely noise artifacts → require high confidence
    //   - Medium (1-2 words): possibly filler → moderate confidence
    //   - Long (3+ words): likely real speech → lower threshold is safe
    confidenceShort: optionalFloat('DEEPGRAM_CONFIDENCE_SHORT', 0.65),
    confidenceMedium: optionalFloat('DEEPGRAM_CONFIDENCE_MEDIUM', 0.5),
    // Hindi model (language=hi) returns lower confidence on Hinglish speech
    // (typical range 0.4-0.7). 0.4 matches minConfidence — any 3+ word
    // transcript that passes the base gate is real speech, not noise.
    confidenceLong: optionalFloat('DEEPGRAM_CONFIDENCE_LONG', 0.4),
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
    // Adaptive token tiers (max_completion_tokens is a CEILING, not a target —
    // short answers finish naturally well below it, so a higher ceiling is
    // near-free for latency and only prevents cut-offs). Defaults are sized for
    // Devanagari/Hinglish output, which is ~2× more token-dense than English:
    //   short factual (price/location)      → tokensShort
    //   normal / amenities list / multi      → tokensNormal
    //   comparison / genuinely long          → tokensLong
    // Sized so a normal reply NEVER truncates mid-sentence. The model often
    // emits a list + an appended visit question in Devanagari (transliterated
    // English nouns are very token-dense), which overflowed the old 64/80
    // SHORT ceiling and cut off mid-word ("…क्या आप" → silence). These are
    // CEILINGS, not targets — a price/location reply still finishes ~20 tokens
    // in, so the higher cap is near-free for latency and only prevents cut-offs.
    tokensShort:  optionalInt('LLM_TOKENS_SHORT', 128),
    tokensNormal: optionalInt('LLM_TOKENS_NORMAL', 176),
    tokensLong:   optionalInt('LLM_TOKENS_LONG', 256),
    // Lower temperature = more focused, faster sampling
    temperature: optionalFloat('LLM_TEMPERATURE', 0.3),
    topP: optionalFloat('LLM_TOP_P', 0.9),
    // Speculative LLM generation from stable interims. Starts LLM+TTS on a
    // stable interim before speech_final, overlapping the endpointing/
    // utterance-end window (~850-1000ms) so the answer is ready the moment
    // the caller stops talking.
    // SAFE because speculative audio is GATED: it is held (never sent to Twilio)
    // until speech_final confirms the text — on match it plays, on mismatch it
    // is discarded silently. This removed the old mid-sentence-silence failure
    // (aborting audible playback) while keeping the latency win. See
    // CallOrchestrator beginSpeculativeHold / releaseSpeculativeAudio.
    speculationEnabled: optionalBool('LLM_SPECULATION_ENABLED', true),
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
        '[ROLE] You are Arjun, a warm real OUTBOUND sales consultant at Akshay Vista, Pune (never an AI, never break character). Goal: book a site visit.',
        'Reply in natural Hindi in Devanagari script, keeping proper names and common English nouns in English (gym, swimming pool, site visit). Write everything as it should be SPOKEN ALOUD: spell out units and avoid abbreviations (write "square feet", not "sqft"; "do BHK" spoken, not "2BHK"), keep numbers spoken (say "8 thousand"). NEVER use Roman-script Hindi (write ठीक है, not theek hai). Reply in ONE crisp sentence, ≤12 words, ≤1 question. Respond only to the latest message.',
        'ACKNOWLEDGEMENTS are auto-prepended by the system when appropriate — never start your reply with okay/sure/got it/right/great/thik hain or any filler. Never praise or use enthusiasm.',
        'Answer from [PROPERTY_FACTS] only — one key fact, never invent prices/sizes/dates/amenities. Answer exactly what was asked (budget→price, location→location).',
        'If unclear/garbled, ask them to repeat. If the answer is NOT in [PROPERTY_FACTS] (e.g. financing, loans, legal, possession paperwork), do NOT guess, invent, or claim you can explain it — say you do not have that detail and warmly invite them to visit the site where our team will help. Never make up prices/sizes/dates/amenities.',
        'Mention a site visit or scheduling ONLY when [NEXT_ACTION] says so, OR when the answer is not in [PROPERTY_FACTS] (then invite a visit so the team can help) — otherwise never add a visit line, even after answering. For visit timing use only "today"/"tomorrow"/"this weekend"; never a specific calendar date, clock time, or "fixed/available" claim.',
        'Never say "और कुछ?"/"aur kuch?"/"anything else?" or any filler closing. If [SESSION_STATE] shows the caller declined a visit, never raise scheduling again.',
        'Use only ✓ info in [SESSION_STATE]; never re-ask it; address them by name once known. Do exactly what [NEXT_ACTION] says, nothing more. The opener already played — never greet again.',
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

  audio: {
    // Raw mulaw bytes to buffer before starting Twilio playback (8000 B/s).
    // This is a direct latency↔underrun tradeoff: every turn waits to
    // accumulate this much audio before the bot is heard. 2400 B = 300ms,
    // ~2× the worst observed inter-chunk gap (~140ms) — enough to ride out
    // Sarvam jitter without the audible delay a deeper prime adds. Raise only
    // if AUDIO_BUFFER_UNDERRUN / TTS_CHUNK_GAP start appearing in logs.
    minBufferBytes: optionalInt('MIN_AUDIO_BUFFER_BYTES', 2400),
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
    // at 608ms — only 8ms past the grace period. 2500ms gives the bot a clean
    // opening window: PSTN echo and the caller's own trailing audio cannot cut
    // the response short in the first 2.5s; real interruptions still register
    // after that. (Also gates STT echo-unmute — see muteSTTForEchoBurst.)
    graceMs: optionalInt('BARGEIN_GRACE_MS', 2500),
  },

  sttWatchdog: {
    // Max ms to wait for a valid transcript after SpeechStarted fires in LISTENING.
    // If no valid transcript arrives within this window, cancel the pending turn
    // and reset to LISTENING — prevents silent/stuck states after failed STT.
    timeoutMs: optionalInt('STT_WATCHDOG_TIMEOUT_MS', 1500),
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
