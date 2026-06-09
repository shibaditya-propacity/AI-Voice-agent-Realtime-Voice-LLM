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
  const accessToken = jwt.sign({ user }, Env.jwt.secret, {
    expiresIn: Env.jwt.expiresIn as string,
  });
  const refreshToken = jwt.sign({ userId: user.id }, Env.jwt.secret, {
    expiresIn: Env.jwt.refreshExpiresIn as string,
  });
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
