import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Env } from '../config/env';
import { AppError } from './error.middleware';
import type { User } from '@saas/types';

export interface AuthRequest extends Request {
  user?: User;
}

export function requireAuth(req: AuthRequest, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, Env.jwt.secret) as { user: User };
    req.user = payload.user;
    next();
  } catch {
    next(new AppError(401, 'INVALID_TOKEN', 'Invalid or expired token'));
  }
}
