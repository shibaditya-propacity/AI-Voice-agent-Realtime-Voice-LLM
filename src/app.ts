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

import fs from 'fs';
import path from 'path';
import express, { Application, Request, Response, NextFunction } from 'express';
import { Env } from './config';
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
import { ExotelService } from './modules/exotel/ExotelService';
import { createExotelRouter } from './modules/exotel/ExotelController';
import { TelephonyProvider } from './modules/telephony/TelephonyProvider';
import { AudioRouter } from './modules/media-gateway/AudioRouter';
import { MediaSessionCoordinator } from './modules/media-gateway/MediaSessionCoordinator';
import { MediaGatewayService } from './modules/media-gateway/MediaGatewayService';

const log = Logger.root('App');

export interface AppServices {
  // knowlarityService: KnowlarityService; // ← commented out
  telephonyProvider: TelephonyProvider;
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

  // ── Telephony provider selection (TELEPHONY_PROVIDER=twilio|exotel) ─────────
  const isExotel = Env.telephonyProvider === 'exotel';

  if (isExotel) {
    if (!Env.exotel.apiKey || !Env.exotel.apiToken || !Env.exotel.accountSid) {
      throw new Error('Exotel provider requires EXOTEL_API_KEY, EXOTEL_API_TOKEN, EXOTEL_ACCOUNT_SID');
    }
  } else {
    if (!Env.twilio.accountSid || !Env.twilio.authToken || !Env.twilio.phoneNumber) {
      throw new Error('Twilio provider requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER');
    }
  }

  const telephonyProvider: TelephonyProvider = isExotel
    ? new ExotelService()
    : new TwilioService();
  log.info(`Telephony provider: ${isExotel ? 'exotel' : 'twilio'}`);

  const audioRouter = new AudioRouter(
    audioProcessor,
    krispService,
    novaSessionManager,
    // knowlarityService, // ← commented out
    telephonyProvider,
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
    telephonyProvider,
    audioRouter,
    coordinator,
  );

  // ── Routes ──────────────────────────────────────────────────────────────────

  // Call events log reader — dashboard uses this to fetch per-call JSONL traces
  app.get('/calls/:callSid/events', (req: Request, res: Response) => {
    const callSid = String(req.params.callSid);
    // Sanitize: only allow Twilio/Exotel SID characters
    if (!/^[A-Za-z0-9_-]{10,64}$/.test(callSid)) {
      res.status(400).json({ error: 'Invalid callSid' });
      return;
    }
    const filePath = path.join(process.cwd(), 'logs', 'calls', `${callSid}.jsonl`);
    if (!fs.existsSync(filePath)) {
      res.json({ events: [] });
      return;
    }
    try {
      const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
      const events = lines
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
      res.json({ events });
    } catch {
      res.status(500).json({ error: 'Failed to read call events' });
    }
  });

  // app.use('/', createKnowlarityRouter(knowlarityService, mediaGateway)); // ← commented out
  if (isExotel) {
    app.use('/', createExotelRouter(telephonyProvider as ExotelService, mediaGateway));
  } else {
    app.use('/', createTwilioRouter(telephonyProvider as TwilioService, mediaGateway));
  }

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
    services: { telephonyProvider, mediaGateway, sessionManager, novaSessionManager },
  };
}
