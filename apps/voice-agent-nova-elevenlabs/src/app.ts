/**
 * Express application factory.
 *
 * Dependency graph (bottom-up):
 *   TwilioService
 *   SessionManager(TwilioService)
 *   TwilioController(TwilioService, SessionManager)
 *   WebSocketServer  ← attaches to HTTP server after creation
 */

import express from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer } from 'ws';
import { Env } from './config/env';
import { Logger } from './shared/logger';
import { TwilioService } from './telephony/TwilioService';
import { SessionManager } from './orchestration/SessionManager';
import { buildTwilioRouter } from './telephony/TwilioController';

const log = Logger.root('App');

export interface AppInstance {
  httpServer: http.Server;
  sessionManager: SessionManager;
  shutdown: () => Promise<void>;
}

export function createApp(): AppInstance {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // ─── Services ────────────────────────────────────────────────────────────

  const twilioService  = new TwilioService();
  const sessionManager = new SessionManager(twilioService);

  // Wire Twilio stream events → session manager
  twilioService.onStreamStarted(async (callSid, _session) => {
    await sessionManager.onCallStarted(callSid);
  });

  twilioService.onAudioReceived((callSid, audioBase64) => {
    sessionManager.handleInboundAudio(callSid, audioBase64);
  });

  twilioService.onStreamStopped(async (callSid) => {
    await sessionManager.endSession(callSid, 'stream_stopped');
  });

  // ─── Request Logger (debug: see ALL incoming requests) ───────────────────
  app.use((req, _res, next) => {
    log.info('HTTP request', {
      method: req.method,
      url: req.url,
      ip: req.ip,
      ua: req.headers['user-agent']?.substring(0, 60),
    });
    next();
  });

  // ─── Static Assets ────────────────────────────────────────────────────────
  // Serve greeting WAV for Twilio <Play> in outbound TwiML — lets Twilio play
  // the greeting immediately when the callee answers (before stream connects).
  app.use('/assets', express.static(path.join(__dirname, '..', 'assets')));

  // ─── Routes ──────────────────────────────────────────────────────────────

  app.use('/', buildTwilioRouter(twilioService, sessionManager));

  // ─── HTTP Server ──────────────────────────────────────────────────────────

  const httpServer = http.createServer(app);

  // ─── WebSocket Server ─────────────────────────────────────────────────────
  // noServer: true — we handle the HTTP upgrade manually so we can
  // route /stream separately from any other WebSocket paths.

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const url = request.url ?? '';
    const ua  = request.headers['user-agent'] ?? '';
    log.info('WS upgrade received', { url, ua, ip: request.socket.remoteAddress });

    if (url === '/stream' || url.startsWith('/stream?')) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        const remoteAddress = request.socket.remoteAddress ?? 'unknown';
        log.info('WebSocket upgrade: /stream', { remoteAddress });
        twilioService.acceptStream(ws, remoteAddress);
      });
    } else {
      log.warn('WebSocket upgrade rejected: unknown path', { url });
      socket.destroy();
    }
  });

  // ─── Shutdown ─────────────────────────────────────────────────────────────

  const shutdown = async (): Promise<void> => {
    log.info('Shutting down gracefully...');

    await sessionManager.shutdown();

    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    log.info('Shutdown complete');
  };

  return { httpServer, sessionManager, shutdown };
}
