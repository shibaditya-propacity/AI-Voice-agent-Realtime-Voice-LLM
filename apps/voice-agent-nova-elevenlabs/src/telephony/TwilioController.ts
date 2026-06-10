/**
 * TwilioController: Express routes for Twilio webhooks and outbound calls.
 *
 *   POST /webhooks/twilio/voice   — Twilio calls this when a call connects
 *   POST /webhooks/twilio/status  — Lifecycle callbacks (answered, completed, etc.)
 *   POST /calls/outbound          — Internal API: initiate an outbound call
 *   GET  /health                  — Service health check
 */

import { Router, Request, Response } from 'express';
import { Env } from '../config/env';
import { Logger } from '../shared/logger';
import { TwilioService } from './TwilioService';
import { SessionManager } from '../orchestration/SessionManager';
import type { OutboundCallRequest } from './types';

const log = Logger.root('TwilioController');

export function buildTwilioRouter(
  twilioService: TwilioService,
  sessionManager: SessionManager,
): Router {
  const router = Router();

  // ─── Voice Webhook ─────────────────────────────────────────────────────────
  // Twilio calls this when a call is connected (inbound or outbound answered).
  // We return TwiML that opens a bidirectional Media Stream WebSocket.

  router.post('/webhooks/twilio/voice', (req: Request, res: Response): void => {
    const callSid      = req.body?.CallSid as string | undefined;
    const callerNumber = req.body?.From    as string | undefined;

    log.info('Incoming voice webhook', { callSid, callerNumber });

    const streamUrl = Env.twilio.webhookBaseUrl
      .replace(/^https?:\/\//, 'wss://')
      .replace(/^http:\/\//, 'ws://')
      + '/stream';

    // Build TwiML. No <Say> before <Connect> — that would block until TTS
    // completes and delay the stream by 3-10 seconds.
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="callerNumber" value="${callerNumber ?? ''}"/>
    </Stream>
  </Connect>
</Response>`;

    res.set('Content-Type', 'text/xml');
    res.send(twiml);
  });

  // ─── Status Callback ───────────────────────────────────────────────────────

  router.post('/webhooks/twilio/status', (req: Request, res: Response): void => {
    const callSid     = req.body?.CallSid      as string | undefined;
    const callStatus  = req.body?.CallStatus   as string | undefined;
    const errorCode   = req.body?.ErrorCode    as string | undefined;
    const errorMessage = req.body?.ErrorMessage as string | undefined;

    if (errorCode) {
      log.warn('Twilio call error', { callSid, callStatus, errorCode, errorMessage });
    } else {
      log.info('Twilio call status', { callSid, callStatus });
    }

    if (callStatus === 'completed' || callStatus === 'failed' || callStatus === 'no-answer' || callStatus === 'busy' || callStatus === 'canceled') {
      if (callSid) sessionManager.endSession(callSid, callStatus);
    }

    res.sendStatus(204);
  });

  // ─── Outbound Call API ─────────────────────────────────────────────────────

  router.post('/calls/outbound', async (req: Request, res: Response): Promise<void> => {
    const { to, from, metadata } = req.body as Partial<OutboundCallRequest>;

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

  // ─── Health ────────────────────────────────────────────────────────────────

  router.get('/health', (_req: Request, res: Response): void => {
    res.json({
      status: 'ok',
      provider: 'twilio',
      pipeline: 'deepgram-nova3 → bedrock-claude → elevenlabs-flash-v2.5',
      activeCalls: twilioService.activeStreamCount,
      activeSessions: sessionManager.activeCount,
      uptime: Math.floor(process.uptime()),
    });
  });

  return router;
}
