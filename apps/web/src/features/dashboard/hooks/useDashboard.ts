import { useQuery } from '@tanstack/react-query';
import { QUERY_KEYS } from '@saas/config';
import { dashboardApi } from '../api/dashboardApi';

export function useDashboardOverview() {
  return useQuery({
    queryKey: QUERY_KEYS.DASHBOARD.OVERVIEW,
    queryFn: () => dashboardApi.getOverview(),
  });
}

export function useDashboardActivity() {
  return useQuery({
    queryKey: QUERY_KEYS.DASHBOARD.ACTIVITY,
    queryFn: () => dashboardApi.getActivity(),
  });
}
