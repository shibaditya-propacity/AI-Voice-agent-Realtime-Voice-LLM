import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { analyticsOverview } from './analytics.controller';

export const analyticsRouter = Router();

analyticsRouter.get('/overview', requireAuth, analyticsOverview);
