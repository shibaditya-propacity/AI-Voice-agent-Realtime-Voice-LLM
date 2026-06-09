import { create } from 'zustand';
import type { User, AuthTokens } from '@saas/types';
import { TOKEN_KEYS } from '@saas/config';

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  setSession: (user: User, tokens: AuthTokens) => void;
  clearSession: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  setSession: (user, tokens) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(TOKEN_KEYS.ACCESS, tokens.accessToken);
      localStorage.setItem(TOKEN_KEYS.REFRESH, tokens.refreshToken);
      // Set cookie so Next.js middleware can read auth state server-side
      document.cookie = `${TOKEN_KEYS.ACCESS}=${tokens.accessToken}; path=/; max-age=900; SameSite=Lax`;
    }
    set({ user, isAuthenticated: true });
  },
  clearSession: () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem(TOKEN_KEYS.ACCESS);
      localStorage.removeItem(TOKEN_KEYS.REFRESH);
      // Clear the middleware cookie
      document.cookie = `${TOKEN_KEYS.ACCESS}=; path=/; max-age=0; SameSite=Lax`;
    }
    set({ user: null, isAuthenticated: false });
  },
}));
