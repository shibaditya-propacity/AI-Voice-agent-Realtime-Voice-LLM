import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { listTeam } from './team.controller';

export const teamRouter = Router();

teamRouter.get('/', requireAuth, listTeam);
