import { apiRequest } from '@/lib/api';
import { API_ROUTES } from '@saas/config';

export interface AnalyticsOverview {
  totalCalls: number;
  qualifiedLeads: number;
  totalLeads: number;
  avgHandleTime: string;
  visitsCompleted: number;
  conversionRate: string;
  callsThisWeek: number;
  leadsThisWeek: number;
}

export const analyticsApi = {
  getOverview: () =>
    apiRequest<AnalyticsOverview>('get', API_ROUTES.ANALYTICS.OVERVIEW),
};
