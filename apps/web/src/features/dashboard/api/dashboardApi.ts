import { apiRequest } from '@/lib/api';
import { API_ROUTES } from '@saas/config';

export interface OverviewCard {
  id: string;
  label: string;
  value: string;
  delta: string;
  deltaPositive: boolean;
  description: string;
  color: string;
}

export interface ActivityItem {
  id: string;
  type: string;
  title: string;
  description: string;
  time: string;
  status: 'success' | 'warning' | 'neutral';
}

export const dashboardApi = {
  getOverview: () =>
    apiRequest<{ cards: OverviewCard[] }>('get', API_ROUTES.DASHBOARD.OVERVIEW),

  getActivity: () =>
    apiRequest<ActivityItem[]>('get', API_ROUTES.DASHBOARD.ACTIVITY),
};
