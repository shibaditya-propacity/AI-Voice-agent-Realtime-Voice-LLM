import { Response, NextFunction } from 'express';
import type { AuthRequest } from '../../middleware/auth.middleware';
import type { ApiResponse } from '@saas/types';
import { getAnalyticsOverview } from './analytics.service';

export async function analyticsOverview(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await getAnalyticsOverview();
    const response: ApiResponse = { success: true, data };
    res.json(response);
  } catch (err) {
    next(err);
  }
}
