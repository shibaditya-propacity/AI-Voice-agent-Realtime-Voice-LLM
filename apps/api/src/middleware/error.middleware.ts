import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import type { ApiResponse } from '@saas/types';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorMiddleware(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    const details: Record<string, string[]> = {};
    for (const issue of err.issues) {
      const key = issue.path.join('.');
      details[key] = [...(details[key] ?? []), issue.message];
    }
    const response: ApiResponse = {
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details },
    };
    res.status(422).json(response);
    return;
  }

  if (err instanceof AppError) {
    const response: ApiResponse = {
      success: false,
      error: { code: err.code, message: err.message },
    };
    res.status(err.statusCode).json(response);
    return;
  }

  console.error('Unhandled error:', err);
  const response: ApiResponse = {
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
  };
  res.status(500).json(response);
}
