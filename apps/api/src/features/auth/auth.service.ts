import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { Env } from '../../config/env';
import { AppError } from '../../middleware/error.middleware';
import { prisma } from '../../lib/prisma';
import type { User, AuthTokens } from '@saas/types';
import type { LoginInput, RegisterInput } from '@saas/shared';

/** Map DB Role enum → API UserRole string */
function mapRole(role: string): User['role'] {
  if (role === 'ADMIN') return 'admin';
  return 'member';
}

function dbUserToApiUser(u: {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: Date;
  updatedAt: Date;
}): User {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: mapRole(u.role),
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
}

function generateTokens(user: User): AuthTokens {
  // Cast required: @types/jsonwebtoken ≥9.0.7 uses branded StringValue but our
  // env values ("15m", "7d") are valid ms strings at runtime.
  const signOpts = (exp: string): jwt.SignOptions => ({ expiresIn: exp as unknown as jwt.SignOptions['expiresIn'] });
  const accessToken = jwt.sign({ user }, Env.jwt.secret, signOpts(Env.jwt.expiresIn));
  const refreshToken = jwt.sign({ userId: user.id }, Env.jwt.secret, signOpts(Env.jwt.refreshExpiresIn));
  return { accessToken, refreshToken };
}

export async function registerUser(
  input: RegisterInput,
): Promise<{ user: User; tokens: AuthTokens }> {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw new AppError(409, 'EMAIL_EXISTS', 'An account with this email already exists');
  }

  const passwordHash = await bcrypt.hash(input.password, 12);
  const now = new Date();

  const dbUser = await prisma.user.create({
    data: {
      id: uuidv4(),
      name: input.name,
      email: input.email,
      password: passwordHash,
      role: 'MANAGER',
      createdAt: now,
      updatedAt: now,
    },
  });

  const user = dbUserToApiUser(dbUser);
  const tokens = generateTokens(user);
  return { user, tokens };
}

export async function loginUser(
  input: LoginInput,
): Promise<{ user: User; tokens: AuthTokens }> {
  const dbUser = await prisma.user.findUnique({ where: { email: input.email } });
  if (!dbUser) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  const valid = await bcrypt.compare(input.password, dbUser.password);
  if (!valid) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  const user = dbUserToApiUser(dbUser);
  const tokens = generateTokens(user);
  return { user, tokens };
}

export async function getUserById(id: string): Promise<User | null> {
  const dbUser = await prisma.user.findUnique({ where: { id } });
  if (!dbUser) return null;
  return dbUserToApiUser(dbUser);
}

export async function refreshTokens(refreshToken: string): Promise<AuthTokens> {
  let payload: { userId: string };
  try {
    payload = jwt.verify(refreshToken, Env.jwt.secret) as { userId: string };
  } catch {
    throw new AppError(401, 'INVALID_TOKEN', 'Invalid or expired refresh token');
  }

  const dbUser = await prisma.user.findUnique({ where: { id: payload.userId } });
  if (!dbUser) throw new AppError(401, 'INVALID_TOKEN', 'User not found');

  return generateTokens(dbUserToApiUser(dbUser));
}
