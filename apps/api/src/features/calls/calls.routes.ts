import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { listCalls, callStats, getCall, getCallEventsHandler } from './calls.controller';
import { internalSaveCallLog } from './calllog.controller';

export const callsRouter = Router();

// Internal — called by voice server (no JWT, uses shared secret header)
callsRouter.post('/internal', internalSaveCallLog);

// Dashboard — protected
callsRouter.get('/', requireAuth, listCalls);
callsRouter.get('/stats', requireAuth, callStats);
callsRouter.get('/:id', requireAuth, getCall);
callsRouter.get('/:id/events', requireAuth, getCallEventsHandler);
