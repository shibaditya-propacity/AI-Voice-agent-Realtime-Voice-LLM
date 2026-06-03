/**
 * KnowlarityController: HTTP + WebSocket entry points for Knowlarity events.
 *
 * Exposes:
 *   POST  /webhooks/knowlarity  — call lifecycle events (inbound, hangup, etc.)
 *   GET   /stream               — WebSocket upgrade point for media streams
 *   POST  /calls/outbound       — initiate outbound call (internal API)
 */

import { Request, Response, Router } from 'express';
import WebSocket from 'ws';
import { Logger } from '../../shared/Logger';
import { KnowlarityWebhookEvent, OutboundCallRequest } from './KnowlarityTypes';
import { KnowlarityService } from './KnowlarityService';
import { MediaGatewayService } from '../media-gateway/MediaGatewayService';

const log = Logger.root('KnowlarityController');

export function createKnowlarityRouter(
  knowlarityService: KnowlarityService,
  mediaGateway: MediaGatewayService,
): Router {
  const router = Router();

  // ── Webhook: Call Lifecycle Events ─────────────────────────────────────────

  router.post('/webhooks/knowlarity', (req: Request, res: Response): void => {
    const event = req.body as KnowlarityWebhookEvent;

    if (!event?.event || !event?.call_id) {
      res.status(400).json({ error: 'Invalid webhook payload' });
      return;
    }

    log.info('Knowlarity webhook received', {
      eventType: event.event,
      callId: event.call_id,
      caller: event.caller_number,
    });

    // Respond to Knowlarity quickly — process asynchronously
    res.status(200).json({ status: 'ok' });

    setImmediate(() => handleWebhookEvent(event, mediaGateway));
  });

  // ── Outbound Call: Internal API ────────────────────────────────────────────

  router.post('/calls/outbound', async (req: Request, res: Response): Promise<void> => {
    const { to, callerId, metadata } = req.body as Partial<OutboundCallRequest>;

    if (!to || !callerId) {
      res.status(400).json({ error: 'Missing required fields: to, callerId' });
      return;
    }

    try {
      const result = await knowlarityService.initiateOutboundCall({ to, callerId, metadata });
      if (result.status === 'failed') {
        res.status(502).json({ error: result.message });
        return;
      }
      res.status(202).json(result);
    } catch (err) {
      log.error('Outbound call API error', err as Error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Health ──────────────────────────────────────────────────────────────────

  router.get('/health', (_req: Request, res: Response): void => {
    res.json({
      status: 'ok',
      activeSessions: mediaGateway.activeSessionCount(),
      activeStreams: knowlarityService.activeStreamCount(),
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}

// ─── Webhook Event Handler ────────────────────────────────────────────────────

function handleWebhookEvent(event: KnowlarityWebhookEvent, mediaGateway: MediaGatewayService): void {
  switch (event.event) {
    case 'CALL_INITIATED':
      log.info('Call initiated', { callId: event.call_id, direction: event.call_type });
      break;

    case 'CALL_ANSWERED':
      log.info('Call answered', { callId: event.call_id });
      // Media stream WebSocket will arrive shortly — MediaGateway handles it
      break;

    case 'CALL_HANGUP':
    case 'CALL_FAILED':
    case 'CALL_BUSY':
    case 'CALL_NO_ANSWER':
      log.info(`Call ended (${event.event})`, {
        callId: event.call_id,
        cause: event.hangup_cause,
      });
      // Trigger session teardown if not already done via stream 'stop' event
      mediaGateway.handleCallEnded(event.call_id, event.event.toLowerCase() as 'call_hangup').catch(
        (err) => log.error('Error handling call end', err as Error),
      );
      break;

    case 'DTMF_RECEIVED':
      log.debug('DTMF', { callId: event.call_id, digit: event.dtmf_digit });
      break;

    default:
      log.debug('Unhandled webhook event', { event: event.event });
  }
}

// ─── WebSocket Upgrade Handler ────────────────────────────────────────────────

/**
 * Called by the WebSocketServer when Knowlarity upgrades a connection
 * to the /stream path.
 */
export function handleKnowlarityStreamUpgrade(
  ws: WebSocket,
  remoteAddress: string,
  knowlarityService: KnowlarityService,
): void {
  log.info('Knowlarity media stream WebSocket connected', { remoteAddress });
  knowlarityService.acceptStream(ws, remoteAddress);
}
