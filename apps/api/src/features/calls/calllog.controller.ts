import { Request, Response, NextFunction } from 'express';
import type { ApiResponse } from '@saas/types';
import { saveCallLog, TranscriptTurn } from './calllog.service';

/**
 * POST /calls/internal
 * Called by the voice server after each call ends to persist the call record.
 * Protected by INTERNAL_API_SECRET header.
 */
export async function internalSaveCallLog(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const secret = process.env.INTERNAL_API_SECRET;
    const provided = req.headers['x-internal-secret'];

    if (secret && provided !== secret) {
      res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Invalid internal secret' } });
      return;
    }

    const { callSid, from, to, direction, duration, language, summary, recordingUrl, transcript } = req.body as {
      callSid?: string;
      from?: string;
      to?: string;
      direction?: string;
      duration?: number;
      language?: string;
      summary?: string;
      recordingUrl?: string;
      transcript?: TranscriptTurn[];
    };

    if (!callSid) {
      res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'callSid is required' } });
      return;
    }

    const log = await saveCallLog({ callSid, from, to, direction, duration, language, summary, recordingUrl, transcript });
    const response: ApiResponse = { success: true, data: log };
    res.status(201).json(response);
  } catch (err) {
    next(err);
  }
}
