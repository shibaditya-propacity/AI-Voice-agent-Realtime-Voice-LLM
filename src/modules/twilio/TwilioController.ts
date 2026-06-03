/**
 * TwilioController: Express routes for Twilio webhooks + WebSocket upgrade.
 *
 * Routes:
 *   POST /webhooks/twilio/voice   — Returns TwiML to open a Media Stream
 *   POST /webhooks/twilio/status  — Call status callbacks (answered, completed, …)
 *   POST /calls/outbound          — Internal API: initiate an outbound call
 *   GET  /health                  — Health check
 *
 * WebSocket:
 *   /stream  — Twilio calls this path to open the bidirectional audio stream
 */

import { Request, Response, Router } from 'express';
import WebSocket from 'ws';
import { Logger } from '../../shared/Logger';
import { TwilioService } from './TwilioService';
import { TwilioOutboundCallRequest } from './TwilioTypes';
import { MediaGatewayService } from '../media-gateway/MediaGatewayService';

const log = Logger.root('TwilioController');

// ─── TwiML Helpers ────────────────────────────────────────────────────────────

const GREETING_TEXT = 'Hello, this is Arjun calling from PropCity. Please go ahead.';

function twimlStreamResponse(streamUrl: string, callerNumber: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    '  <Say voice="man" language="en-IN">',
    `    ${GREETING_TEXT}`,
    '  </Say>',
    '  <Connect>',
    `    <Stream url="${streamUrl}">`,
    `      <Parameter name="callerNumber" value="${callerNumber}"/>`,
    '    </Stream>',
    '  </Connect>',
    '</Response>',
  ].join('\n');
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function createTwilioRouter(
  twilioService: TwilioService,
  mediaGateway: MediaGatewayService,
): Router {
  const router = Router();

  // ── Inbound / Outbound Call Voice Webhook ──────────────────────────────────
  // Twilio POSTs here when a call is answered. We return TwiML to open a stream.

  router.post('/webhooks/twilio/voice', (req: Request, res: Response): void => {
    const callSid: string = req.body?.CallSid ?? '';
    const callerNumber: string = req.body?.From ?? '';
    const direction: string = req.body?.Direction ?? 'inbound';

    log.info('Twilio voice webhook', { callSid, callerNumber, direction });

    if (!callSid) {
      res.status(400).send('Missing CallSid');
      return;
    }

    // Construct the WebSocket URL for the media stream.
    // Twilio requires wss:// — derive it from the Host header or the configured base URL.
    const host = req.headers.host ?? '';
    const streamUrl = `wss://${host}/stream`;

    res.type('text/xml').send(twimlStreamResponse(streamUrl, callerNumber));
  });

  // ── Call Status Callback ───────────────────────────────────────────────────

  router.post('/webhooks/twilio/status', (req: Request, res: Response): void => {
    const callSid: string = req.body?.CallSid ?? '';
    const callStatus: string = req.body?.CallStatus ?? '';

    log.info('Twilio status callback', { callSid, callStatus });

    res.status(204).send();

    if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(callStatus)) {
      mediaGateway.handleCallEnded(callSid, callStatus).catch((err) => {
        log.error('Error handling call end from status callback', err as Error);
      });
    }
  });

  // ── Outbound Call API ──────────────────────────────────────────────────────

  router.post('/calls/outbound', async (req: Request, res: Response): Promise<void> => {
    const { to, from, metadata } = req.body as Partial<TwilioOutboundCallRequest>;

    if (!to) {
      res.status(400).json({ error: 'Missing required field: to' });
      return;
    }

    const result = await twilioService.initiateOutboundCall({ to, from, metadata });

    if (result.status === 'failed') {
      res.status(502).json({ error: result.message });
      return;
    }

    res.status(202).json(result);
  });

  // ── Health ─────────────────────────────────────────────────────────────────

  router.get('/health', (_req: Request, res: Response): void => {
    res.json({
      status: 'ok',
      activeSessions: mediaGateway.activeSessionCount(),
      activeStreams: twilioService.activeStreamCount(),
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}

// ─── WebSocket Upgrade Handler ────────────────────────────────────────────────

/**
 * Called by WebSocketServer when Twilio upgrades a connection to /stream.
 */
export function handleTwilioStreamUpgrade(
  ws: WebSocket,
  remoteAddress: string,
  twilioService: TwilioService,
): void {
  log.info('Twilio media stream WebSocket connected', { remoteAddress });
  twilioService.acceptStream(ws, remoteAddress);
}
