import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.middleware';
import {
  handleTriggerCall, handleStartCampaign, handleListCallJobs,
  handleCallJobStats, handleDashboardStats,
} from './call-jobs.controller';

export const callJobsRouter = Router();

callJobsRouter.get('/', requireAuth, handleListCallJobs);
callJobsRouter.post('/', requireAuth, handleTriggerCall);
callJobsRouter.get('/stats', requireAuth, handleCallJobStats);
callJobsRouter.post('/campaign/:campaignId/start', requireAuth, handleStartCampaign);

export const callCenterDashboardRouter = Router();
callCenterDashboardRouter.get('/', requireAuth, handleDashboardStats);
