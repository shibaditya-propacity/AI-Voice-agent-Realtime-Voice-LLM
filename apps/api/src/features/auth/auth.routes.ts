import { Router } from 'express';
import { register, login, getMe, logout, refresh } from './auth.controller';
import { requireAuth } from '../../middleware/auth.middleware';

const router = Router();

router.post('/register', register);
router.post('/login', login);
router.post('/logout', requireAuth, logout);
router.post('/refresh', refresh);
router.get('/me', requireAuth, getMe);

export { router as authRouter };
