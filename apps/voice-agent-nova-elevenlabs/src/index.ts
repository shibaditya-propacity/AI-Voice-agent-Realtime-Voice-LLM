/**
 * Entry point: validate env, create app, start listening.
 *
 * Pipeline: Twilio → Deepgram Nova-3 → Bedrock Claude Sonnet 4.6 → ElevenLabs Flash v2.5 → Twilio
 */

import 'dotenv/config';
import { Env } from './config/env';
import { rootLogger } from './shared/logger';
import { createApp } from './app';
import { warmUpBedrock } from './llm/BedrockLLM';
import { loadGreetingAudio } from './tts/GreetingCache';

const log = rootLogger;

async function main(): Promise<void> {
  log.info('Voice Agent (Deepgram + Bedrock + ElevenLabs) starting', {
    port:      Env.server.port,
    nodeEnv:   Env.server.nodeEnv,
    llmModel:  Env.llm.modelId,
    sttModel:  Env.deepgram.model,
    ttsModel:  Env.elevenlabs.modelId,
    voiceId:   Env.elevenlabs.voiceId,
    language:  Env.deepgram.language,
  });

  // Load pre-recorded greeting audio (raw ulaw 8kHz mono)
  loadGreetingAudio('./assets/greet.raw');

  const { httpServer, shutdown } = createApp();

  httpServer.listen(Env.server.port, () => {
    log.info(`Server listening on port ${Env.server.port}`);
    log.info(`Health check: http://localhost:${Env.server.port}/health`);
    log.info(`Twilio webhook: POST /webhooks/twilio/voice`);
    log.info(`WebSocket stream: ws://localhost:${Env.server.port}/stream`);

    // Fire-and-forget: establish HTTP keep-alive + seed Bedrock prompt cache.
    // First real call will hit cache instead of cold-starting.
    void warmUpBedrock();
  });

  // ─── Graceful Shutdown ─────────────────────────────────────────────────────

  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

  for (const signal of signals) {
    process.on(signal, async () => {
      log.info(`Received ${signal}, shutting down...`);
      try {
        await shutdown();
        process.exit(0);
      } catch (err) {
        log.error('Error during shutdown', err as Error);
        process.exit(1);
      }
    });
  }

  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception', err);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection', reason instanceof Error ? reason : new Error(String(reason)));
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
