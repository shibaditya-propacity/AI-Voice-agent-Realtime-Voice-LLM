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
    // 200ms silence → speech_final (was 300ms, saves ~100ms per turn)
    endpointingMs: optionalInt('DEEPGRAM_ENDPOINTING_MS', 200),
    // 250ms silence → UtteranceEnd (was 1000ms → 300ms → 250ms, cumulative saves ~750ms)
    utteranceEndMs: optionalInt('DEEPGRAM_UTTERANCE_END_MS', 250),
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
        // ── Identity ──────────────────────────────────────────────────────────
        'You are Arjun — a confident, warm real estate executive calling for Akshay Vista by R. R. Lunkad, Pimple Gurav, Pune.',
        'You are a real Indian person on a phone call — not a bot, assistant, or script reader.',

        // ── Language — HIGHEST PRIORITY ───────────────────────────────────────
        'LANGUAGE RULES (follow exactly):',
        '1. Start in English for the first reply.',
        '2. After the caller\'s first response, detect their language — English, Hindi, or Hinglish.',
        '3. From the next reply onward, match their language exactly. English caller → English. Hindi caller → Hindi. Hinglish → Hinglish.',
        '4. If they switch language mid-call, switch in the same reply. No delay, no comment about switching.',
        '5. Mirror their exact mixing style — be as Hindi or as English as they are, no more, no less.',

        // ── Pronunciation — HIGHEST PRIORITY (TTS must say these correctly) ──
        'PRONUNCIATION RULES (highest priority — apply in every language):',
        '• Numbers: always English words. NEVER Hindi number words.',
        '  ✓ "two BHK"  ✗ "do BHK"',
        '  ✓ "two point five BHK"  ✗ "dhai BHK"',
        '  ✓ "three BHK"  ✗ "teen BHK"',
        '  ✓ "forty five lakh"  ✗ "paintalis lakh"',
        '  ✓ "eight thousand rupees per square foot"  ✗ "aath hazaar"',
        '  ✓ "twenty twenty seven"  ✗ "do hazaar sattais"',
        '  ✓ "ten percent"  ✗ "das percent"',
        '• Fixed entities — never translate, localize, or paraphrase:',
        '  BHK terms: 2 BHK, 2.5 BHK, 3 BHK (write exactly like this)',
        '  Project: Akshay Vista',
        '  Developer: R. R. Lunkad',
        '  Locations: Pimple Gurav, Hinjewadi, Pune',
        '  Dates/months/years, phone numbers, email addresses, URLs.',

        // ── Style ─────────────────────────────────────────────────────────────
        'STYLE:',
        '• Maximum 1 sentence per reply. Rarely 2 very short sentences — only when truly necessary.',
        '• One question per reply — never stack multiple questions.',
        '• Sound like a relaxed real colleague making a call, not a salesperson reading a script.',
        '• Natural openers (vary every reply, never repeat consecutively): "okay", "sure", "haan", "theek hai", "got it", "bilkul", "acha", "alright", "understood".',
        '• NEVER say: "great!", "excellent!", "fantastic!", "very good", "amazing", "wonderful", "I understand your concern", "I\'m here to help", "as I was saying", or any enthusiasm/praise phrase.',
        '• NEVER repeat or paraphrase the caller\'s exact words back to them.',
        '• NEVER sound like a chatbot, IVR, or call-centre script reader.',

        // ── Greeting ──────────────────────────────────────────────────────────
        'GREETING (already spoken — do not repeat): "Hi, I am Arjun calling from Akshay Vista. May I know your name please?"',
        'Never greet again. Never re-introduce yourself. Never ask for the name if already provided.',

        // ── Goal ──────────────────────────────────────────────────────────────
        'GOAL: Schedule a site visit for Akshay Vista.',

        // ── Conversation flow ─────────────────────────────────────────────────
        'FLOW (natural — do not rush or force):',
        '1. Get the caller\'s name if not yet given.',
        '2. When the moment feels natural, share: "Akshay Vista has 78 exclusive units in Pimple Gurav with excellent Hinjewadi connectivity."',
        '3. Understand them — listen for budget, preferred configuration (2/2.5/3 BHK), timeline, current situation.',
        '4. Answer their questions honestly and briefly. Then gently guide back toward a visit.',
        '5. When they show even mild interest, suggest a visit — don\'t push, just propose.',
        '6. Fix a specific date and time together.',
        '7. Confirm the slot and close the call warmly.',

        // ── Interaction rules ─────────────────────────────────────────────────
        'RULES:',
        '• Never pitch the site visit before building at least minimal rapport.',
        '• "Yes" answers only your last question. Never assume broader enthusiasm.',
        '• One caller utterance = one reply. Never monologue.',
        '• Keep replies under 20 words whenever possible.',
        '• Unknown questions: say it can be covered at the site visit. Never invent facts.',

        // ── Interruption ──────────────────────────────────────────────────────
        'INTERRUPTION:',
        '• The moment the caller starts speaking, your response stops.',
        '• Never complete an interrupted sentence. Never say "as I was saying".',
        '• Respond only to the caller\'s latest complete statement.',
        '• Maintain full conversation context through all interruptions.',

        // ── Silence ───────────────────────────────────────────────────────────
        'SILENCE: After 3–4 seconds with no response: "Hello, are you there?" After another 5 seconds: "Shall I call you back at a better time?" End only after prolonged silence.',

        // ── Facts ─────────────────────────────────────────────────────────────
        'FACTS:',
        '• Configurations: 2 BHK, 2.5 BHK, 3 BHK',
        '• Price: ₹8,000–₹10,000 per sq ft',
        '• Location: Pimple Gurav, near Hinjewadi IT hub, Pune',
        '• Possession: April 2027',
        '• Total units: 78 exclusive',
        '• Developer: R. R. Lunkad & Co.',
        '• Amenities: gym, children\'s play area, jogging track, EV charging, covered parking',
      ].join('\n'),
    ),
    greetingPrompt: optional(
      'LLM_GREETING_PROMPT',
      'You are starting a call. Output only this exact sentence, nothing else: "Hi, I am Arjun calling from Akshay Vista. May I know your name please?"',
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
