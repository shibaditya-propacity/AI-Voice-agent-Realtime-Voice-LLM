/**
 * Minimal Env mock for unit tests.
 * Avoids reading process.env / dotenv at test startup.
 */
export const Env = {
  audio: {
    telephonyCodec: 'pcmu' as const,
    telephonySampleRate: 8000,
    internalSampleRate: 16000,
    chunkMs: 20,
    bufferMaxBytes: 64_000,
    vadRmsThreshold: 500,
    vadSilenceHangoverMs: 300,
    proactiveBargeIn: false,
  },
  nova: {
    modelId: 'amazon.nova-2-sonic-v1:0',
    systemPrompt: 'You are a test agent.',
    maxTokens: 1024,
    temperature: 0.7,
    topP: 0.9,
    voiceId: 'test-voice',
    audioOutputSampleRate: 24000,
    endpointingSensitivity: 'MEDIUM' as const,
    greetingTrigger: 'Hello?',
    prewarmIntervalMs: 240_000,
  },
  aws: {
    region: 'us-east-1',
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
  },
  server: {
    port: 3000,
    nodeEnv: 'test',
  },
  session: {
    maxConcurrentCalls: 10,
    idleTimeoutMs: 300_000,
  },
  logging: {
    level: 'silent',
    pretty: false,
  },
};
