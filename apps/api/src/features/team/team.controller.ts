import { Response, NextFunction } from 'express';
import type { AuthRequest } from '../../middleware/auth.middleware';
import type { ApiResponse } from '@saas/types';
import { getTeamMembers, getTeamStats } from './team.service';

export async function listTeam(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const [members, stats] = await Promise.all([getTeamMembers(), getTeamStats()]);
    const response: ApiResponse = { success: true, data: { members, stats } };
    res.json(response);
  } catch (err) {
    next(err);
  }
}
