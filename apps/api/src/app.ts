import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { Env } from './config/env';
import { authRouter } from './features/auth/auth.routes';
import { dashboardRouter } from './features/dashboard/dashboard.routes';
import { callsRouter } from './features/calls/calls.routes';
import { analyticsRouter } from './features/analytics/analytics.routes';
import { teamRouter } from './features/team/team.routes';
import { contactsRouter } from './features/call-center/contacts/contacts.routes';
import { campaignsRouter } from './features/call-center/campaigns/campaigns.routes';
import { callJobsRouter, callCenterDashboardRouter } from './features/call-center/call-jobs/call-jobs.routes';
import { errorMiddleware } from './middleware/error.middleware';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: Env.cors.origin, credentials: true }));
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

  app.use('/auth', authRouter);
  app.use('/dashboard', dashboardRouter);
  app.use('/calls', callsRouter);
  app.use('/analytics', analyticsRouter);
  app.use('/team', teamRouter);
  app.use('/call-center/contacts', contactsRouter);
  app.use('/call-center/campaigns', campaignsRouter);
  app.use('/call-center/jobs', callJobsRouter);
  app.use('/call-center/stats', callCenterDashboardRouter);

  app.use(errorMiddleware);

  return app;
}
