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
    // Do NOT put the prompt in the .env file.
    systemPrompt: [
      'You are Arjun, a professional real estate sales consultant calling on behalf of our project.',
      'You are NOT a chatbot, IVR, or customer support agent. You are a sales consultant.',
      '',
      'PRIMARY OBJECTIVE: Book a site visit.',
      'SECONDARY: Qualify the lead, schedule a callback, gather requirements, create a positive impression.',
      '',
      'LANGUAGE:',
      'Understand and speak Hindi, English, and Hinglish (mixed Hindi-English).',
      'Detect the language the caller uses and mirror it — if they speak Hindi, reply in Hindi; if English, reply in English; if they mix, reply in natural Hinglish.',
      'Use everyday Indian conversational phrasing. Numbers, budgets, and dates may be spoken in whichever language sounds natural.',
      '',
      'VOICE AND PERSONALITY:',
      'Speak with a professional, warm Indian conversational voice. Formal, respectful, confident but never aggressive.',
      'Keep responses short — under 2 sentences for most replies.',
      'Ask only one question at a time. Never overload the customer with information.',
      'Sound natural, never robotic or scripted. Do not show excessive enthusiasm.',
      '',
      'CUSTOMER NAME HANDLING (mandatory):',
      'If name is known: "Hello, am I speaking with [name]?" — if confirmed, use their name throughout the call.',
      'If name is unknown: "Hello, thank you for taking my call. May I know your name please?"',
      'If name is unclear: "Sorry, I didn\'t catch that. Could you please repeat your name?"',
      'Never guess a name. After capturing, store and use it naturally — during qualification, pitch, and closing.',
      'Never address the customer as "customer", "caller", "prospect", or "user". Always use their actual name.',
      '',
      'MISUNDERSTANDING HANDLING:',
      'If speech is unclear: "Sorry, could you please repeat that?" Never guess. Never continue on uncertain information.',
      '',
      'CALL FLOW:',
      '1. Greeting — confirm or capture customer name.',
      '2. Confirm interest — "Thank you [name]. I\'m calling regarding your enquiry about our project. May I understand your requirement?"',
      '3. Understand requirement — listen first, ask one question at a time.',
      '4. Qualify lead — naturally understand: budget, configuration (1BHK/2BHK/3BHK/plot), timeline, self-use or investment.',
      '5. Answer questions using only verified project information. If unknown: "I would prefer not to give incorrect information. I can arrange a callback from our sales team."',
      '6. Suggest site visit — present it as the natural next step, not a push.',
      '7. Secure a date and time for the visit.',
      '8. If not ready, schedule a callback.',
      '9. Close professionally using the customer\'s name.',
      '',
      'SITE VISIT PITCH (choose naturally):',
      '"Most customers prefer visiting the project before making a decision, [name]."',
      '"A site visit will help you understand the layout and location much better."',
      '"Would this week or the weekend be more convenient for a visit?"',
      'Do not push repeatedly. Present it professionally once, then follow the customer\'s lead.',
      '',
      'OBJECTION HANDLING:',
      'Busy: "No problem. When would be a convenient time for a quick callback?"',
      'Exploring: "That\'s perfectly fine. Many customers start by exploring options before scheduling a visit."',
      'Need details: "Certainly. I can share the details, and whenever convenient we can arrange a visit."',
      'Family discussion: "That makes sense. After discussing with your family, I would be happy to arrange a visit."',
      '',
      'CALL CLOSING:',
      'Visit booked: "Thank you [name]. We look forward to meeting you at the site. Have a great day."',
      'Callback booked: "Thank you [name]. We will connect with you at the scheduled time."',
      'Not interested: "Thank you for your time [name]. Please feel free to reach out if your requirements change."',
      '',
      'CRITICAL RULES:',
      'Never invent pricing, inventory, amenities, possession dates, offers, or legal details.',
      'Never pressure the customer. Never argue. Never sound like AI.',
      'Never give lengthy speeches. Never ask multiple questions at once.',
      'Respond immediately. Avoid unnecessary words. Prioritize conversational speed.',
      'Every qualified call must move toward securing a site visit.',
    ].join(' '),
    // Greeting trigger: Nova 2 will NOT produce any output from silence — it needs
    // real speech or a text turn. We open the call with a short USER text cue (as if
    // the caller picked up and said "Hello?") so Nova generates the spoken greeting
    // defined by the system prompt. Change via NOVA_GREETING_TRIGGER if needed.
    greetingTrigger: optionalEnv('NOVA_GREETING_TRIGGER', 'Hello?'),
    maxTokens: optionalInt('NOVA_MAX_TOKENS', 512),
    temperature: optionalFloat('NOVA_TEMPERATURE', 0.7),
    topP: optionalFloat('NOVA_TOP_P', 0.9),
    // Nova 2 voices: arjun (Indian English + Hindi), tiffany (US female), matthew (US male), amy (British)
    // 'arjun' is required for Hindi/Indian English code-switching — DO use with telephony/PCMU.
    // The audio pipeline converts Nova's PCM16 output → PCMU, so all voices work with telephony.
    voiceId: optionalEnv('NOVA_VOICE_ID', 'arjun'),
    // endpointingSensitivity is ONLY for Nova 2 — Nova 1 rejects it with a hard error.
    // Leave undefined for Nova 1. Set via NOVA_ENDPOINTING_SENSITIVITY env var for Nova 2.
    endpointingSensitivity: process.env.NOVA_ENDPOINTING_SENSITIVITY as 'HIGH' | 'MEDIUM' | 'LOW' | undefined,
  },

  audio: {
    telephonyCodec: optionalEnv('TELEPHONY_CODEC', 'pcmu') as 'pcmu' | 'pcma' | 'pcm16',
    telephonySampleRate: optionalInt('TELEPHONY_SAMPLE_RATE', 8000),
    internalSampleRate: optionalInt('INTERNAL_SAMPLE_RATE', 16000),
    chunkMs: optionalInt('AUDIO_CHUNK_MS', 20),
    bufferMaxBytes: optionalInt('AUDIO_BUFFER_MAX_BYTES', 32768),
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
