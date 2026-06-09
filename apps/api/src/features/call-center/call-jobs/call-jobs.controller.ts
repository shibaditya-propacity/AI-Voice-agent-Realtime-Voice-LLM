import { Response, NextFunction } from 'express';
import type { AuthRequest } from '../../../middleware/auth.middleware';
import type { ApiResponse } from '@saas/types';
import {
  triggerSingleCall, startCampaign, listCallJobs, getCallJobStats, getCallCenterDashboardStats,
} from './call-jobs.service';

export async function handleTriggerCall(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { contactId, campaignId } = req.body as { contactId?: string; campaignId?: string };
    if (!contactId) {
      res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'contactId is required' } });
      return;
    }
    try {
      const data = await triggerSingleCall(contactId, campaignId);
      res.status(201).json({ success: true, data } as ApiResponse);
    } catch (dialErr) {
      // Job was saved as FAILED in DB — return 202 with the error so the UI can display it
      res.status(202).json({
        success: false,
        error: { code: 'DIAL_FAILED', message: (dialErr as Error).message },
      });
    }
  } catch (err) { next(err); }
}

export async function handleStartCampaign(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    await startCampaign(String(req.params.campaignId));
    res.json({ success: true, data: { started: true } } as ApiResponse);
  } catch (err) { next(err); }
}

export async function handleListCallJobs(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
    const campaignId = req.query.campaignId ? String(req.query.campaignId) : undefined;
    const data = await listCallJobs(page, 20, campaignId);
    res.json({ success: true, data } as ApiResponse);
  } catch (err) { next(err); }
}

export async function handleCallJobStats(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const campaignId = req.query.campaignId ? String(req.query.campaignId) : undefined;
    const data = await getCallJobStats(campaignId);
    res.json({ success: true, data } as ApiResponse);
  } catch (err) { next(err); }
}

export async function handleDashboardStats(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await getCallCenterDashboardStats();
    res.json({ success: true, data } as ApiResponse);
  } catch (err) { next(err); }
}
