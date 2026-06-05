/**
 * Application entry point.
 *
 * Boot sequence:
 *   1. Load and validate environment variables
 *   2. Create the Express app and all services
 *   3. Attach the WebSocket server
 *   4. Start listening
 *   5. Register graceful shutdown handlers
 */

import 'dotenv/config';
import http from 'http';
import { Env } from './config';
import { callTrace } from './shared/CallTraceLogger';
import { rootLogger as log } from './shared/Logger';
import { createApp } from './app';
import { WebSocketServer } from './infrastructure/WebSocketServer';

async function main(): Promise<void> {
  log.info('Starting Voice AI Agent', {
    nodeEnv: Env.server.nodeEnv,
    port: Env.server.port,
    novaModel: Env.nova.modelId,
  });

  // 1. Build app + services
  const { app, services } = createApp();

  // 2. Create HTTP server (shared with WebSocket)
  const httpServer = http.createServer(app);

  // 3. Attach WebSocket server
  const wsServer = new WebSocketServer(httpServer, services.twilioService);

  // 4. Load the static greeting WAV BEFORE accepting calls so the very first call can
  //    play it the instant it connects (Nova 2 Sonic does not speak first). This is a
  //    fast local file read — not a Bedrock call — so boot is not meaningfully delayed.
  //
  //    BUILD MARKER: if you do NOT see "[GREETING] step0" in the logs, you are running
  //    an OLD process — rebuild (`npm run build`) and restart before testing.
  log.info('[GREETING] step0 — static-greeting pipeline ACTIVE — loading greeting WAV BEFORE accepting calls');
  try {
    await services.novaSessionManager.prepareGreeting();
  } catch (err) {
    // prepareGreeting already swallows load errors; belt-and-suspenders so a rejection
    // can never block boot or crash via unhandledRejection.
    log.error('[GREETING] step1 prepareGreeting() rejected — calls will have no opening greeting', err as Error);
  }

  // 4b. Pre-warm the Bedrock connection now and keep it warm on an interval so the
  //     first call (and calls after a quiet period) connect fast.
  services.novaSessionManager.startPeriodicPrewarm();

  // 5. NOW start listening — the greeting cache is ready, so every call (including the
  //    first) gets the instant greeting.
  await new Promise<void>((resolve, reject) => {
    httpServer.listen(Env.server.port, () => {
      log.info(`Server listening on port ${Env.server.port} — ready to accept calls`, {
        pid: process.pid,
        port: Env.server.port,
        greetingCached: services.novaSessionManager.getCachedGreeting() !== null,
      });
      resolve();
    });
    httpServer.on('error', reject);
  });

  // 5. Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    log.info(`Received ${signal} — shutting down gracefully`);

    // Stop accepting new HTTP connections
    httpServer.close(() => log.info('HTTP server closed'));

    // Close all WebSocket connections
    await wsServer.close();

    // Stop the periodic Bedrock re-warm timer
    services.novaSessionManager.stopPeriodicPrewarm();

    // Unsubscribe MediaGatewayService internal event handlers
    services.mediaGateway.dispose();

    // Dispose session manager (clears idle timer)
    services.sessionManager.dispose();

    // Flush any in-progress call traces to disk
    callTrace.dispose();

    log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Log uncaught errors without crashing (for production resilience)
  process.on('uncaughtException', (err) => {
    log.fatal('Uncaught exception', err);
    // Exit after logging — let the process manager restart
    process.exit(1);
  });

  // Bug fix: unhandledRejection must also exit — a dangling rejected promise
  // means the process is in an unknown state and should be restarted cleanly.
  process.on('unhandledRejection', (reason) => {
    log.fatal('Unhandled promise rejection', reason instanceof Error ? reason : new Error(String(reason)));
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
