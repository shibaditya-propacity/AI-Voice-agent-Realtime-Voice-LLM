/**
 * ExotelController: Express routes for Exotel webhooks + WebSocket upgrade.
 *
 * Routes:
 *   POST /webhooks/exotel/voice   — Returns ExoML to open a Media Stream
 *   POST /webhooks/exotel/status  — Call status callbacks
 *   POST /calls/outbound          — Internal API: initiate an outbound call
 *   GET  /health                  — Health check
 *
 * WebSocket:
 *   /stream  — Exotel connects here for bidirectional audio (same path as Twilio)
 *
 * ExoML differences from TwiML:
 *   - Webhook body: uses `Status` (not `CallStatus`) in status callbacks
 *   - XML response: same <Connect><Stream> structure as TwiML
 */

import { Request, Response, Router } from 'express';
import WebSocket from 'ws';
import { Env } from '../../config';
import { Logger } from '../../shared/Logger';
import { postCallLog } from '../../shared/DashboardClient';
import { ExotelService } from './ExotelService';
import { ExotelOutboundCallRequest } from './ExotelTypes';
import { MediaGatewayService } from '../media-gateway/MediaGatewayService';

const log = Logger.root('ExotelController');

// ─── ExoML Helper ─────────────────────────────────────────────────────────────

function exomlStreamResponse(streamUrl: string, callerNumber: string): string {
  // ExoML <Connect><Stream> is structurally identical to TwiML.
  // No <Say> before <Connect> — same reasoning as Twilio: delays the WebSocket
  // connection and creates a duplicate greeting over Nova's own opening.
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    '  <Connect>',
    `    <Stream url="${streamUrl}">`,
    `      <Parameter name="callerNumber" value="${callerNumber}"/>`,
    '    </Stream>',
    '  </Connect>',
    '</Response>',
  ].join('\n');
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function createExotelRouter(
  exotelService: ExotelService,
  mediaGateway: MediaGatewayService,
): Router {
  const router = Router();

  // ── Inbound / Outbound Call Voice Webhook ──────────────────────────────────

  router.post('/webhooks/exotel/voice', (req: Request, res: Response): void => {
    const callSid: string = req.body?.CallSid ?? '';
    const callerNumber: string = req.body?.From ?? '';
    const direction: string = req.body?.Direction ?? 'inbound';

    log.info('Exotel voice webhook', { callSid, callerNumber, direction });

    if (!callSid) {
      res.status(400).send('Missing CallSid');
      return;
    }

    let streamUrl: string;
    const baseUrl = Env.exotel.webhookBaseUrl;
    if (baseUrl) {
      streamUrl = baseUrl.replace(/^https?:\/\//, (m) => m === 'https://' ? 'wss://' : 'ws://') + '/stream';
    } else {
      const host = req.headers.host ?? 'localhost';
      streamUrl = `wss://${host}/stream`;
    }

    log.info('Returning ExoML with media stream', { callSid, streamUrl });
    res.type('text/xml').send(exomlStreamResponse(streamUrl, callerNumber));
  });

  // ── Call Status Callback ───────────────────────────────────────────────────
  // Exotel sends `Status` (not `CallStatus` like Twilio).
  // Exotel also includes: Duration, From, To, RecordingUrl (if recording enabled).

  router.post('/webhooks/exotel/status', (req: Request, res: Response): void => {
    const callSid: string = req.body?.CallSid ?? '';
    // Exotel uses `Status` field; fall back to `CallStatus` for forward-compat
    const callStatus: string = req.body?.Status ?? req.body?.CallStatus ?? '';
    const from: string = req.body?.From ?? '';
    const to: string = req.body?.To ?? '';
    const direction: string = req.body?.Direction ?? 'inbound';
    const duration: number = parseInt(String(req.body?.Duration ?? req.body?.DialCallDuration ?? '0'), 10) || 0;
    const recordingUrl: string = req.body?.RecordingUrl ?? '';

    log.info('Exotel status callback', { callSid, callStatus, duration, from, recordingUrl: recordingUrl || '(none)' });

    res.status(204).send();

    const isTerminal = ['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(callStatus);

    if (isTerminal) {
      // Tear down in-memory voice session
      mediaGateway.handleCallEnded(callSid, callStatus).catch((err) => {
        log.error('Error handling call end from status callback', err as Error);
      });

      // Persist CallLog to dashboard API (fire-and-forget)
      postCallLog({
        callSid,
        from,
        to,
        direction,
        duration,
        recordingUrl: recordingUrl || undefined,
      }).catch((err: Error) => {
        log.error('Failed to persist CallLog to dashboard API', err, { callSid });
      });
    }
  });

  // ── Outbound Call API ──────────────────────────────────────────────────────

  router.post('/calls/outbound', async (req: Request, res: Response): Promise<void> => {
    const { to, from, metadata } = req.body as Partial<ExotelOutboundCallRequest>;

    if (!to) {
      res.status(400).json({ error: 'Missing required field: to' });
      return;
    }

    const result = await exotelService.initiateOutboundCall({ to, from, metadata });

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
      provider: 'exotel',
      activeSessions: mediaGateway.activeSessionCount(),
      activeStreams: exotelService.activeStreamCount(),
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}

// ─── WebSocket Upgrade Handler ────────────────────────────────────────────────

export function handleExotelStreamUpgrade(
  ws: WebSocket,
  remoteAddress: string,
  exotelService: ExotelService,
): void {
  log.info('Exotel media stream WebSocket connected', { remoteAddress });
  exotelService.acceptStream(ws, remoteAddress);
}
