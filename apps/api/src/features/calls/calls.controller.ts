import { Response, NextFunction } from 'express';
import type { AuthRequest } from '../../middleware/auth.middleware';
import type { ApiResponse } from '@saas/types';
import { getCallLogs, getCallStats, getCallDetail } from './calls.service';

export async function listCalls(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10)));
    const data = await getCallLogs(page, limit);
    const response: ApiResponse = { success: true, data };
    res.json(response);
  } catch (err) {
    next(err);
  }
}

export async function callStats(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await getCallStats();
    const response: ApiResponse = { success: true, data };
    res.json(response);
  } catch (err) {
    next(err);
  }
}

export async function getCall(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await getCallDetail(String(req.params.id));
    if (!data) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Call not found' } });
      return;
    }
    const response: ApiResponse = { success: true, data };
    res.json(response);
  } catch (err) {
    next(err);
  }
}
