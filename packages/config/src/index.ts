export const APP_NAME = 'Propacity';
export const APP_DESCRIPTION = 'Enterprise Voice AI Platform';

export const ROUTES = {
  HOME: '/',
  LOGIN: '/login',
  REGISTER: '/register',
  FORGOT_PASSWORD: '/forgot-password',
  DASHBOARD: '/dashboard',
  CALLS: '/calls',
  ANALYTICS: '/analytics',
  SETTINGS: '/settings',
} as const;

export const API_ROUTES = {
  AUTH: {
    LOGIN: '/auth/login',
    REGISTER: '/auth/register',
    LOGOUT: '/auth/logout',
    REFRESH: '/auth/refresh',
    ME: '/auth/me',
  },
  DASHBOARD: {
    OVERVIEW: '/dashboard/overview',
    ACTIVITY: '/dashboard/activity',
  },
  CALLS: {
    LIST: '/calls',
    STATS: '/calls/stats',
    DETAIL: (id: string) => `/calls/${id}`,
  },
  ANALYTICS: {
    OVERVIEW: '/analytics/overview',
  },
  TEAM: {
    LIST: '/team',
  },
} as const;

export const TOKEN_KEYS = {
  ACCESS: 'access_token',
  REFRESH: 'refresh_token',
} as const;

export const QUERY_KEYS = {
  AUTH: {
    ME: ['auth', 'me'],
  },
  DASHBOARD: {
    OVERVIEW: ['dashboard', 'overview'],
    ACTIVITY: ['dashboard', 'activity'],
  },
  CALLS: {
    LIST: ['calls', 'list'],
    STATS: ['calls', 'stats'],
    DETAIL: (id: string) => ['calls', 'detail', id],
  },
  ANALYTICS: {
    OVERVIEW: ['analytics', 'overview'],
  },
  TEAM: {
    LIST: ['team', 'list'],
  },
} as const;
