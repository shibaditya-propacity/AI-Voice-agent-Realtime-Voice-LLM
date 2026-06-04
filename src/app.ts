/**
 * Express application factory.
 *
 * Dependency graph (bottom-up):
 *
 *   CodecConverter → AudioProcessor
 *   SessionStore   → SessionManager
 *   KrispService
 *   NovaSessionManager(SessionManager)
 *   TwilioService
 *   AudioRouter(AudioProcessor, KrispService, NovaSessionManager, TwilioService, SessionManager)
 *   MediaSessionCoordinator(SessionManager, KrispService, NovaSessionManager, AudioRouter)
 *   MediaGatewayService(TwilioService, AudioRouter, MediaSessionCoordinator)
 *   TwilioController(TwilioService, MediaGatewayService)
 */

import express, { Application, Request, Response, NextFunction } from 'express';
import { Logger } from './shared/Logger';
import { CodecConverter } from './modules/audio/CodecConverter';
import { AudioProcessor } from './modules/audio/AudioProcessor';
import { SessionStore } from './modules/session/SessionStore';
import { SessionManager } from './modules/session/SessionManager';
import { KrispService } from './modules/krisp/KrispService';
import { NovaSessionManager } from './modules/nova/NovaSessionManager';
// import { KnowlarityService } from './modules/knowlarity/KnowlarityService'; // ← commented out: replaced by Twilio
// import { createKnowlarityRouter } from './modules/knowlarity/KnowlarityController'; // ← commented out
import { TwilioService } from './modules/twilio/TwilioService';
import { createTwilioRouter } from './modules/twilio/TwilioController';
import { AudioRouter } from './modules/media-gateway/AudioRouter';
import { MediaSessionCoordinator } from './modules/media-gateway/MediaSessionCoordinator';
import { MediaGatewayService } from './modules/media-gateway/MediaGatewayService';

const log = Logger.root('App');

export interface AppServices {
  // knowlarityService: KnowlarityService; // ← commented out
  twilioService: TwilioService;
  mediaGateway: MediaGatewayService;
  sessionManager: SessionManager;
  novaSessionManager: NovaSessionManager;
}

export function createApp(): { app: Application; services: AppServices } {
  const app = express();

  // ── Middleware ──────────────────────────────────────────────────────────────
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  app.use((req: Request, _res: Response, next: NextFunction) => {
    log.debug(`${req.method} ${req.path}`, { ip: req.ip });
    next();
  });

  // ── Service Instantiation ───────────────────────────────────────────────────

  const codecConverter = new CodecConverter();
  const audioProcessor = new AudioProcessor(codecConverter);

  const sessionStore = new SessionStore();
  const sessionManager = new SessionManager(sessionStore);

  const krispService = new KrispService();

  const novaSessionManager = new NovaSessionManager(sessionManager);

  // const knowlarityService = new KnowlarityService(); // ← commented out
  const twilioService = new TwilioService();

  const audioRouter = new AudioRouter(
    audioProcessor,
    krispService,
    novaSessionManager,
    // knowlarityService, // ← commented out
    twilioService,
    sessionManager,
  );

  const coordinator = new MediaSessionCoordinator(
    sessionManager,
    krispService,
    novaSessionManager,
    audioRouter,
  );

  const mediaGateway = new MediaGatewayService(
    // knowlarityService, // ← commented out
    twilioService,
    audioRouter,
    coordinator,
  );

  // ── Routes ──────────────────────────────────────────────────────────────────
  // app.use('/', createKnowlarityRouter(knowlarityService, mediaGateway)); // ← commented out
  app.use('/', createTwilioRouter(twilioService, mediaGateway));

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error('Unhandled Express error', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  log.info('Express application created');

  return {
    app,
    services: { twilioService, mediaGateway, sessionManager, novaSessionManager },
  };
}
