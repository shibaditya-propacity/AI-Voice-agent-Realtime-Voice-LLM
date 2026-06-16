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

  // ── Telephony provider selection ─────────────────────────────────────────
  // Set TELEPHONY_PROVIDER=exotel to activate Exotel; default is twilio.
  telephonyProvider: optionalEnv('TELEPHONY_PROVIDER', 'twilio') as 'twilio' | 'exotel',

  twilio: {
    accountSid: optionalEnv('TWILIO_ACCOUNT_SID', ''),
    authToken: optionalEnv('TWILIO_AUTH_TOKEN', ''),
    phoneNumber: optionalEnv('TWILIO_PHONE_NUMBER', ''),
    // Public HTTPS URL of this server — Twilio will POST webhooks here
    webhookBaseUrl: optionalEnv('TWILIO_WEBHOOK_BASE_URL', ''),
  },

  exotel: {
    // Exotel API credentials (from Exotel dashboard → Settings → API)
    apiKey: optionalEnv('EXOTEL_API_KEY', ''),
    apiToken: optionalEnv('EXOTEL_API_TOKEN', ''),
    // Exotel Account SID (shown in Exotel dashboard, e.g. "propacity2")
    accountSid: optionalEnv('EXOTEL_ACCOUNT_SID', ''),
    // Exotel API subdomain — full host used in REST calls, e.g. api.exotel.in
    // Matches {{SubDomain}} in the Exotel Postman collection.
    apiSubdomain: optionalEnv('EXOTEL_API_SUBDOMAIN', 'api.exotel.in'),
    // ExoPhone virtual number in E.164 format, e.g. +918045678901
    phoneNumber: optionalEnv('EXOTEL_PHONE_NUMBER', ''),
    // Public HTTPS base URL of this server — Exotel will POST webhooks here
    webhookBaseUrl: optionalEnv('EXOTEL_WEBHOOK_BASE_URL', ''),
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
    // Condensed system prompt (~300 tokens). Conversation-flow control is handled
    // by the application's state machine — the LLM only handles style and tone.
    // Dynamic context ([PROPERTY FACTS], [SESSION STATE], [NEXT ACTION]) is
    // injected as USER text blocks before each response.
    systemPrompt: [
      'You are Arjun — a calm, confident real estate sales caller for Akshay Vista, Pimple Gurav, Pune. You are a real person on a phone call.',
      'LANGUAGE: Default English. Switch to Hinglish if asked — speak like an educated Indian professional.',
      'Preserve exactly: numbers, prices, dates, days, BHK, brand names. Say numerals in English only.',
      'STYLE: 1 short sentence per reply, under 12 words. One question at a time. Sound human, not scripted.',
      'Vary acknowledgements: okay, sure, alright, got it, haan, theek hai. Never praise or use enthusiasm.',
      'GREETING DONE: You already said "Hi, I am Arjun calling from Akshay Vista. May I know your name?" — never re-greet or re-ask.',
      'INTERRUPTION: Drop unfinished sentence. Never apologise or resume. Answer caller\'s latest utterance only.',
      'Follow [NEXT ACTION] directives exactly. Only state facts from [PROPERTY FACTS]. Never invent facts.',
      'SILENCE: Bracketed instructions — say exactly what they ask, nothing else.',
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
    silenceTimeoutMs: optionalInt('NOVA_SILENCE_TIMEOUT_MS', 8_000),
    // Text injected as a USER turn when silence is detected. Nova responds to this
    // cue with the re-engagement phrase defined in its system prompt context.
    silencePrompt: optionalEnv('NOVA_SILENCE_PROMPT', '[The caller has been silent for several seconds. Say exactly: "I may not have heard you. Are you still there?"]'),
    // When a FINAL caller transcript is captured while the session is INTERRUPTED
    // (barge-in), Nova often never answers it — it resumes its old response and
    // ignores the caller. With this on, the captured transcript is promoted into an
    // explicit new USER turn so Nova responds to what the caller actually said.
    // Set false to revert to "store but don't promote". See NovaSessionManager.onContentEnd.
    promoteInterruptedTranscript: optionalBool('NOVA_PROMOTE_INTERRUPTED_TRANSCRIPT', true),
    // Promotion delay (ms). 0 = fire immediately (synchronous, no timer). Any
    // positive value defers promotion by that many ms so Nova can handle the barge-in
    // natively (control token or fresh completionStart). If Nova responds within the
    // window, the pending promotion is cancelled — no double response. Default 0:
    // proactive barge-in (AudioRouter RMS) never triggers a native Nova response, so
    // deferring only adds latency. The user hears a response ~1.5s faster.
    promoteInterruptedDelayMs: optionalInt('NOVA_PROMOTE_INTERRUPTED_DELAY_MS', 0),
    // How the conversation is primed on connect:
    //   'none' (default) — send NO cue. Nova stays silent after the greeting and the
    //       caller's spoken reply (their name) becomes the first real, audio-driven
    //       turn — exactly like every later turn, which already transcribe correctly.
    //       This is the fix for the first turn answering a text cue with a literal
    //       "[caller's name]" placeholder and talking over the caller's name.
    //   'cue' — a USER text turn (firstTurnCue) whose contentEnd makes Nova respond
    //       immediately. Use this only if 'none' leaves Nova silent after the greeting
    //       (i.e. its VAD doesn't drive the first turn on your account).
    //   'assistant' — inject the greeting as Nova's OWN prior turn. NOTE: Nova Sonic's
    //       bidirectional API REJECTS an injected ASSISTANT text turn → nova-init-
    //       failure / dropped call. Do NOT use unless your account accepts it.
    firstTurnMode: ((m) => (m === 'cue' || m === 'assistant' || m === 'none' ? m : 'none'))(
      optionalEnv('NOVA_FIRST_TURN_MODE', 'none'),
    ) as 'none' | 'cue' | 'assistant',
    // First-turn speech gate: after the greeting, hold caller audio OUT of Nova until
    // the caller actually starts speaking (energy > VAD threshold), so Nova can't
    // endpoint on the post-greeting silence and answer the prime turn early — which
    // is what made it talk over / drop the caller's name. A fallback after this many
    // ms force-opens the gate so a silent caller still triggers a Nova re-engagement.
    // Set 0 to disable the gate (revert to feeding audio immediately when the mic opens).
    firstTurnSpeechGateMs: optionalInt('NOVA_FIRST_TURN_SPEECH_GATE_MS', 1_500),
    // The exact words the opening greeting WAV speaks. Used by 'assistant' mode only.
    // Keep this in sync with assets/greeting.wav.
    greetingText: optionalEnv('NOVA_GREETING_TEXT', 'Hi, I am Arjun calling from Akshay Vista. May I know your name please?'),
    // USER text cue used in 'cue' mode. Its contentEnd makes Nova respond — a
    // bracketed directive telling it not to re-greet/re-ask, just answer the name.
    firstTurnCue: optionalEnv(
      'NOVA_FIRST_TURN_CUE',
      '[The call just connected. Your opening line "Hi, I am Arjun calling from Akshay Vista. May I know your name please?" has already been played to the caller — the greeting AND the name request are done. Do NOT greet again and do NOT ask for the name again. Wait for the caller to give their name, then respond to it naturally with a brief acknowledgement and continue.]',
    ),
  },

  // ── Groq (optional — used for entity extraction fallback) ─────────────────
  groq: {
    apiKey: optionalEnv('GROQ_API_KEY', ''),
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
    // Linear gain applied ONLY to the PCM16 audio forwarded to Nova (after Krisp),
    // so quiet callers (e.g. a softly-spoken "yes") are loud enough for Nova's
    // ASR/VAD to transcribe — otherwise the agent treats it as silence and loops on
    // "I may not have heard you. Are you still there?". Applied in NovaAudioStreamer
    // AFTER the barge-in RMS check and the first-turn speech gate, so neither of those
    // detectors changes (no new false barge-ins / early gate opens). Samples are
    // clamped to the int16 range. 1.0 = off. ~2.0 (+6dB) suits quiet telephony;
    // lower it if loud callers start distorting.
    inputGain: optionalFloat('AUDIO_INPUT_GAIN', 2.0),
    // Proactive client-side barge-in: immediately interrupt agent playback when the
    // caller's RMS energy (measured on post-Krisp noise-suppressed audio) exceeds
    // vadRmsThreshold, WITHOUT waiting for Nova's own VAD. Running on clean audio
    // avoids false positives from telephony echo of the agent's own voice.
    // DEFAULT ON. Complements Nova's native barge-in with faster client-side
    // interruption for true real-time barge-in behavior.
    proactiveBargeIn: optionalBool('AUDIO_PROACTIVE_BARGEIN', true),
    // Proactive barge-in confirmation: the caller's RMS must stay above
    // vadRmsThreshold for this many ms of (near-)continuous speech before playback
    // is interrupted. Filters noise, echo, breathing and handset artifacts (which
    // don't sustain). A word-bearing transcript from Nova also confirms instantly.
    bargeInConfirmMs: optionalInt('AUDIO_BARGEIN_CONFIRM_MS', 400),
  },

  session: {
    maxConcurrentCalls: optionalInt('MAX_CONCURRENT_CALLS', 100),
    idleTimeoutMs: optionalInt('SESSION_IDLE_TIMEOUT_MS', 600_000),
  },

  logging: {
    level: optionalEnv('LOG_LEVEL', 'info'),
    pretty: optionalBool('LOG_PRETTY', false),
  },

  // ── Dashboard API integration ────────────────────────────────────────────
  // Voice server calls this after each call to persist the CallLog + recording.
  dashboard: {
    apiUrl: optionalEnv('DASHBOARD_API_URL', 'http://localhost:3001'),
    internalSecret: optionalEnv('INTERNAL_API_SECRET', ''),
  },
} as const;

export type EnvConfig = typeof Env;
