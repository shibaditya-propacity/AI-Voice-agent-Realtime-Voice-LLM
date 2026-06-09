import https from 'https';
import http from 'http';
import { Env } from '../config';
import { Logger } from './Logger';

const log = Logger.root('DashboardClient');

export interface CallLogPayload {
  callSid: string;
  from?: string | null;
  to?: string | null;
  direction?: string;
  duration?: number;
  language?: string;
  summary?: string;
  recordingUrl?: string;
  transcript?: Array<{
    role: 'USER' | 'ASSISTANT';
    content: string;
    createdAt?: string;
  }>;
}

async function postCallLogOnce(payload: CallLogPayload): Promise<void> {
  const apiUrl = Env.dashboard.apiUrl;
  const secret = Env.dashboard.internalSecret;

  const body = JSON.stringify(payload);
  const url = new URL('/calls/internal', apiUrl);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  await new Promise<void>((resolve, reject) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(secret ? { 'x-internal-secret': secret } : {}),
        },
      },
      (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Dashboard API returned ${res.statusCode}`));
        } else {
          resolve();
        }
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export async function postCallLog(payload: CallLogPayload): Promise<void> {
  const maxAttempts = 4;
  const delays = [2000, 5000, 15000]; // ms between retries

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await postCallLogOnce(payload);
      log.info('Call log posted to dashboard API', {
        callSid: payload.callSid,
        turns: payload.transcript?.length ?? 0,
        attempt,
      });
      return;
    } catch (err) {
      const isLast = attempt === maxAttempts;
      if (isLast) throw err;
      const delay = delays[attempt - 1] ?? 15000;
      log.warn(`Dashboard API post failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`, {
        callSid: payload.callSid,
        error: (err as Error).message,
      });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
