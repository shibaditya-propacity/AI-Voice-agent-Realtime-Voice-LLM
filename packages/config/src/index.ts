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
  CALL_CENTER: '/call-center',
  CALL_CENTER_CONTACTS: '/call-center/contacts',
  CALL_CENTER_CAMPAIGNS: '/call-center/campaigns',
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
  CONTACTS: {
    LIST: '/call-center/contacts',
    CREATE: '/call-center/contacts',
    IMPORT: '/call-center/contacts/import',
    DETAIL: (id: string) => `/call-center/contacts/${id}`,
    DELETE: (id: string) => `/call-center/contacts/${id}`,
  },
  CAMPAIGNS: {
    LIST: '/call-center/campaigns',
    CREATE: '/call-center/campaigns',
    DETAIL: (id: string) => `/call-center/campaigns/${id}`,
    UPDATE: (id: string) => `/call-center/campaigns/${id}`,
    DELETE: (id: string) => `/call-center/campaigns/${id}`,
    CONTACTS: (id: string) => `/call-center/campaigns/${id}/contacts`,
    REMOVE_CONTACT: (campaignId: string, contactId: string) =>
      `/call-center/campaigns/${campaignId}/contacts/${contactId}`,
  },
  CALL_JOBS: {
    TRIGGER: '/call-center/jobs',
    LIST: '/call-center/jobs',
    STATS: '/call-center/jobs/stats',
    START_CAMPAIGN: (campaignId: string) => `/call-center/jobs/campaign/${campaignId}/start`,
  },
  CALL_CENTER_DASHBOARD: {
    STATS: '/call-center/stats',
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
  CONTACTS: {
    LIST: ['contacts', 'list'],
    DETAIL: (id: string) => ['contacts', 'detail', id],
  },
  CAMPAIGNS: {
    LIST: ['campaigns', 'list'],
    DETAIL: (id: string) => ['campaigns', 'detail', id],
    JOBS: (id: string) => ['campaigns', 'jobs', id],
  },
  CALL_JOBS: {
    LIST: ['call-jobs', 'list'],
    STATS: ['call-jobs', 'stats'],
    CAMPAIGN_STATS: (id: string) => ['call-jobs', 'stats', id],
  },
  CALL_CENTER_DASHBOARD: {
    STATS: ['call-center', 'stats'],
  },
} as const;
