'use client';

import { useRouter } from 'next/navigation';
import { useAuthStore } from '../store/authStore';
import { authApi } from '../api/authApi';
import { ROUTES } from '@saas/config';
import type { LoginInput, RegisterInput } from '@saas/shared';

export function useAuth() {
  const router = useRouter();
  const { user, isAuthenticated, setSession, clearSession } = useAuthStore();

  async function login(data: LoginInput) {
    const session = await authApi.login(data);
    setSession(session.user, session.tokens);
    router.push(ROUTES.DASHBOARD);
  }

  async function register(data: RegisterInput) {
    const session = await authApi.register(data);
    setSession(session.user, session.tokens);
    router.push(ROUTES.DASHBOARD);
  }

  async function logout() {
    try {
      await authApi.logout();
    } catch {
      // Swallow — always clear local session
    } finally {
      clearSession();
      router.push(ROUTES.LOGIN);
    }
  }

  return { user, isAuthenticated, login, register, logout };
}
