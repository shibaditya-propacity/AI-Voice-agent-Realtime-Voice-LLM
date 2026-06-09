import { apiRequest } from '@/lib/api';
import type { AuthSession } from '@saas/types';
import type { LoginInput, RegisterInput } from '@saas/shared';
import { API_ROUTES } from '@saas/config';

export const authApi = {
  login: (data: LoginInput) =>
    apiRequest<AuthSession>('post', API_ROUTES.AUTH.LOGIN, data),

  register: (data: RegisterInput) =>
    apiRequest<AuthSession>('post', API_ROUTES.AUTH.REGISTER, data),

  logout: () =>
    apiRequest<void>('post', API_ROUTES.AUTH.LOGOUT),

  getMe: () =>
    apiRequest<{ user: AuthSession['user'] }>('get', API_ROUTES.AUTH.ME),
};
