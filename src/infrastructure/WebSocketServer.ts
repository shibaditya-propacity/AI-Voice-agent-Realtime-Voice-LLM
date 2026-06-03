/**
 * WebSocketServer: HTTP upgrade routing for WebSocket connections.
 *
 * Path handled:
 *   /stream  — Twilio Media Stream connections (one per active call)
 *
 * Shares a single port with Express via the http.Server 'upgrade' event.
 */

import http from 'http';
import WebSocket, { WebSocketServer as WsServer } from 'ws';
import { URL } from 'url';
import { Logger } from '../shared/Logger';
// import { KnowlarityService } from '../modules/knowlarity/KnowlarityService'; // ← commented out
// import { handleKnowlarityStreamUpgrade } from '../modules/knowlarity/KnowlarityController'; // ← commented out
import { TwilioService } from '../modules/twilio/TwilioService';
import { handleTwilioStreamUpgrade } from '../modules/twilio/TwilioController';

const log = Logger.root('WebSocketServer');

export class WebSocketServer {
  private readonly wss: WsServer;
  // private readonly knowlarityService: KnowlarityService; // ← commented out
  private readonly twilioService: TwilioService;

  constructor(server: http.Server, twilioService: TwilioService) {
    this.twilioService = twilioService;
    this.wss = new WsServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket as never, head));

    log.info('WebSocketServer initialized');
  }

  private handleUpgrade(
    req: http.IncomingMessage,
    socket: import('stream').Duplex,
    head: Buffer,
  ): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    if (pathname === '/stream') {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const remoteAddress = req.socket.remoteAddress ?? 'unknown';
        log.info('Twilio media stream connected', { remoteAddress });

        this.wss.emit('connection', ws, req);
        // handleKnowlarityStreamUpgrade(ws, remoteAddress, this.knowlarityService); // ← commented out
        handleTwilioStreamUpgrade(ws, remoteAddress, this.twilioService);
      });
    } else {
      log.warn('WebSocket upgrade rejected — unknown path', { pathname });
      socket.destroy();
    }
  }

  async close(timeoutMs = 5_000): Promise<void> {
    return new Promise((resolve) => {
      for (const client of this.wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.close(1001, 'Server shutting down');
        }
      }

      const timer = setTimeout(() => {
        log.warn('WebSocketServer close timed out — forcing shutdown', { timeoutMs });
        resolve();
      }, timeoutMs);

      this.wss.close(() => {
        clearTimeout(timer);
        log.info('WebSocketServer closed');
        resolve();
      });
    });
  }

  get clientCount(): number {
    return this.wss.clients.size;
  }
}
