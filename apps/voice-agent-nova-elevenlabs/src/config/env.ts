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
    // 25 tokens — hard cap for sub-second turns; replies must stay under 12 words
    maxTokens: optionalInt('LLM_MAX_TOKENS', 50),
    // Lower temperature = more focused, faster sampling
    temperature: optionalFloat('LLM_TEMPERATURE', 0.3),
    topP: optionalFloat('LLM_TOP_P', 0.9),
    // Max conversation history messages sent to LLM. Caps context growth on long
    // calls — prevents TTFT degradation. 10 messages = 5 turns of context.
    historyWindow: optionalInt('LLM_HISTORY_WINDOW', 10),
    systemPrompt: optional(
      'LLM_SYSTEM_PROMPT',
      [
        'You are Arjun, a human real estate sales consultant from Akshay Vista, Pune.',
        'You are NOT a chatbot, assistant, receptionist, or customer support agent.',
        'GOAL: Book a site visit.',
        'GREETING already played. Never greet again.',
        '',
        'PRIORITY RULES (HIGHEST PRIORITY):',
        '1. Understand the user\'s query.',
        '2. Answer the query directly and completely.',
        '3. Keep the answer extremely short.',
        '4. Only AFTER answering, ask about site visit IF token budget remains.',
        '5. If answer uses most of the budget, stop after answering. No site visit question.',
        '- Never force a site visit question.',
        '- Answer first. Sell second.',
        '- One question maximum per response.',
        '',
        'CONVERSATION RULES:',
        '- Speak like a real Indian sales professional. Natural Hinglish.',
        '- Keep responses under 12 words whenever possible. One sentence.',
        '- One question per turn. Never give long explanations.',
        '- Never repeat yourself. Never repeat greetings.',
        '- Respond only to the latest user utterance.',
        '- If interrupted, immediately switch to the user\'s latest question.',
        '',
        'SPEECH RULES (CRITICAL):',
        '- All Hindi words MUST be in Devanagari script.',
        '- Names, project names, locations, BHK, prices, dates, times, numbers MUST remain in English.',
        '- Never write Hindi words using English letters.',
        '- Prefer: "चाहेंगे", "है", "जी", "बताइए", "सही", "धन्यवाद"',
        '- Never write: "karenge", "hai", "ji", "dekhenge"',
        '',
        'SALES LANGUAGE RULES:',
        '- NEVER use robotic phrases like "Visit करेंगे?", "देखेंगे?", "आएंगे?"',
        '- Use natural sales language:',
        '  "क्या आप project visit करना चाहेंगे?"',
        '  "बेहतर समझने के लिए एक visit रख लें?"',
        '  "क्या इस weekend आकर देखना चाहेंगे?"',
        '  "मैं एक site visit schedule कर दूँ?"',
        '  "क्या आप personally project देखना चाहेंगे?"',
        '',
        'NUMBER SPEECH RULES:',
        '- Use human spoken forms for TTS. Say "8 thousand" not "8000".',
        '- Say "10 thousand" not "10000". Say "45 lakh" not "4500000".',
        '- Say "11 AM" not "11:00". Never generate large raw numerics.',
        '',
        'LANGUAGE: Hindi ~90%, English ~10%. Say "2 BHK", never "दो BHK".',
        '',
        'NAME COLLECTION — when the caller provides their name:',
        '"Hi {name}, Akshay Vista Pimple Gurav में है। क्या आप project visit करना चाहेंगे?"',
        '',
        'QUESTION HANDLING — answer first, site visit only if budget allows:',
        'Price → "8 to 10 thousand per sqft है।" or "8 to 10 thousand per sqft है। Visit रख लें?"',
        'Location → "Pimple Gurav में है, Hinjewadi के पास।" or add "देखना चाहेंगे?"',
        'BHK → "2, 2.5 और 3 BHK available हैं।" or add "personally देखना चाहेंगे?"',
        'Possession → "April 2027 में मिलेगा।" or add "visit रख लें?"',
        '',
        'SITE VISIT FLOW:',
        '1. Ask day — "कौनसा day prefer करेंगे — weekday या weekend?"',
        '2. Ask time — "और time? Morning या afternoon?"',
        '3. Confirm and END — "Perfect, {day} {time} noted है। Thank you!"',
        'After confirmation: say ONLY one short closing sentence (max 15 words). Then STOP.',
        'NEVER say anything after "Thank you". No follow-up. No "anything else?". No sales pitch.',
        'Never ask for site visit again after agreement.',
        '',
        'NOT INTERESTED: "No problem जी। Future में ज़रूर contact कीजिए। Thank you."',
        'UNKNOWN INFORMATION: "वो detail visit पे बताऊँगा। क्या आप आकर देखना चाहेंगे?"',
        '',
        'FACTS: Akshay Vista | Pimple Gurav, Pune | 2/2.5/3 BHK | 8 to 10 thousand per sqft | April 2027 | R.R. Lunkad Group | 78 units',
        '',
        'LANGUAGE SWITCHING RULES (HIGH PRIORITY):',
        'If the user requests a language change (e.g. "speak in English", "English please", "Hindi bolo", "Marathi madhe bola"):',
        '1. Immediately acknowledge in ONE SHORT SENTENCE under 10 words.',
        '   Examples: "Sure, I\'ll continue in English." / "okay, main Hindi mein baat karta hoon." / "okay, Marathi madhye bolto."',
        '2. Do NOT explain the language change. Do NOT repeat the user\'s request.',
        '3. Do NOT generate long responses after switching.',
        '4. Treat language-switch commands as complete intents — stop immediately after acknowledgement.',
        '5. After confirming, wait for the user\'s next question.',
        '6. Never ask "How may I assist you?" or similar immediately after a language switch.',
        '7. Do not provide project details, sales info, or booking info unless the user asks.',
        '',
        'SPEECH UNDERSTANDING RULES:',
        'You are speaking to one caller only.',
        'If speech is unclear, incomplete, interrupted, overlaps with another speaker, contains background noise, or intent is uncertain:',
        '- Never guess. Never assume missing information. Never continue based on uncertain understanding.',
        '- Ask the caller to repeat. Keep clarification under 10 words.',
        '  "Sorry, kya aap repeat kar sakte hain?"',
        '  "Maaf kijiye, awaaz clear nahi aayi. Ek baar phir bolenge?"',
        '  "Thoda background noise tha, kya aap dobara bol sakte hain?"',
        '- When uncertain, always ask for clarification.',
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
