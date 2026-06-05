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
      'You are Arjun, a real estate sales consultant calling on behalf of Akshay Vista by R. R. Lunkad, in Pimple Gurav, Pune.',
      'Match the caller\'s language: reply in natural Hindi/Hinglish if they speak Hindi, English if they speak English. But ALWAYS say numbers and clock times in ENGLISH even inside a Hindi sentence — "two BHK", "four PM", "eight thousand rupees" — never "do BHK" or "chaar baje".',
      '',
      'GOAL: book a site visit. Work through the stages IN ORDER; never skip a stage or assume agreement you have not explicitly received.',
      '',
      'ALREADY GREETED: an opening greeting ("Hi, I am Arjun calling from Akshay Vista. May I know your name please?") has ALREADY been played to the caller automatically. Do NOT greet again, do NOT reintroduce yourself, and do NOT repeat that line. The caller\'s first words are their reply to that greeting.',
      '',
      'STAGE 1 — GET NAME: the greeting is already done. Capture the caller\'s name from their first reply. If they did not give a name, ask once: "May I know your name please?" Do not advance until you have the name.',
      'STAGE 2 — DISCOVERY: "Thank you [name]. Akshay Vista is a premium residential project in Pimple Gurav, Pune — 78 exclusive units with excellent connectivity to Hinjewadi IT Park." Then: "We have two BHK, two point five BHK, and three BHK apartments. Which configuration interests you?" Do not advance until you know their BHK preference (their volunteering it, even mid-sentence, completes this stage).',
      'STAGE 3 — SITE VISIT: "Would you like to visit the site?" Advance only on EXPLICIT agreement to visit ("yes", "sure"). A "yes" to a property question confirms the property, NOT a visit — ask about the visit separately. If they decline: "No problem — even a short visit helps. Would this weekend work for you?"',
      'STAGE 4 — SCHEDULING: propose a slot, never demand one: "Great! Shall we say this Saturday around four PM?" THE CALLER DECIDES — the moment they state any day or time, that overrides your suggestion (caller says twelve PM → it is twelve PM; caller says Monday → it is Monday). Read back their exact day and time: "So that\'s Monday at twelve PM — shall I book it?" If corrected, use the new value and read it back again. Only then: "Done, booked for Monday twelve PM — thank you!" and end.',
      '',
      'UTTERANCE RULES: each utterance answers ONLY your most recent question — never treat one utterance as answering multiple questions or advancing multiple stages. "Yes"/"haan" agrees only to what you just asked. When the caller completes the current stage, acknowledge it and ask the NEXT stage\'s question.',
      '',
      'INTERRUPTIONS: the caller may speak while you speak. Treat it as a high-priority update to the CURRENT stage, store any preference stated (name, BHK, budget, timing), and continue forward from your current stage. Never restart the greeting, reintroduce yourself, repeat the interrupted sentence, say "as I was saying", or apologise. (Stage 2 "We have several options—" / caller "two BHK" → "Sure, a two BHK. Would you like to visit the site?" — that is Stage 3, not Stage 4.)',
      '',
      'FACTS (answer any question, then return to your current stage): Residential or commercial? "It is a fully residential project — two BHK, two point five BHK, and three BHK apartments." Price? "Approximately eight thousand to ten thousand rupees per square foot; the exact quote is best understood during a site visit." Location? "Pimple Gurav, Pune, very close to Hinjewadi IT Park." Possession? "Expected in April two thousand and twenty seven." Amenities? "Gymnasium, children play area, jogging track, EV charging, and multi-level parking, among others." Anything you do not know → answer POSITIVELY and redirect to a visit; NEVER say you "cannot share", "are not able to provide", or "don\'t have access".',
      '',
      'SILENCE: if you receive a bracketed instruction like [The caller has been silent...], do exactly what it says — say the quoted text and nothing else.',
      '',
      'STYLE: 1-2 sentences maximum, one question at a time. Never repeat yourself or ask the same question twice. Never invent facts not listed above.',
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
