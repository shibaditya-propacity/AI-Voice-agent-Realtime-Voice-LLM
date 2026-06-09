import { Response, NextFunction } from 'express';
import type { AuthRequest } from '../../middleware/auth.middleware';
import type { ApiResponse } from '@saas/types';
import { getDashboardOverview, getRecentActivity } from './dashboard.service';

export async function overview(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await getDashboardOverview();
    const response: ApiResponse = { success: true, data };
    res.json(response);
  } catch (err) {
    next(err);
  }
}

export async function activity(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await getRecentActivity();
    const response: ApiResponse = { success: true, data };
    res.json(response);
  } catch (err) {
    next(err);
  }
}
