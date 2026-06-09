import { Response, NextFunction } from 'express';
import { loginSchema, registerSchema } from '@saas/shared';
import { loginUser, registerUser, getUserById } from './auth.service';
import type { AuthRequest } from '../../middleware/auth.middleware';
import type { ApiResponse, AuthSession } from '@saas/types';

export async function register(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = registerSchema.parse(req.body);
    const { user, tokens } = await registerUser(input);
    const response: ApiResponse<AuthSession> = { success: true, data: { user, tokens } };
    res.status(201).json(response);
  } catch (err) {
    next(err);
  }
}

export async function login(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = loginSchema.parse(req.body);
    const { user, tokens } = await loginUser(input);
    const response: ApiResponse<AuthSession> = { success: true, data: { user, tokens } };
    res.json(response);
  } catch (err) {
    next(err);
  }
}

export async function getMe(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await getUserById(req.user!.id);
    if (!user) {
      res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
      return;
    }
    const response: ApiResponse = { success: true, data: { user } };
    res.json(response);
  } catch (err) {
    next(err);
  }
}

export function logout(_req: AuthRequest, res: Response): void {
  const response: ApiResponse = { success: true, data: { message: 'Logged out successfully' } };
  res.json(response);
}
