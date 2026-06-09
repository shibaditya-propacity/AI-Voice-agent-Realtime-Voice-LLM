import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { overview, activity } from './dashboard.controller';

export const dashboardRouter = Router();

dashboardRouter.get('/overview', requireAuth, overview);
dashboardRouter.get('/activity', requireAuth, activity);
