import { useQuery } from '@tanstack/react-query';
import { QUERY_KEYS } from '@saas/config';
import { analyticsApi } from '../api/analyticsApi';

export function useAnalyticsOverview() {
  return useQuery({
    queryKey: QUERY_KEYS.ANALYTICS.OVERVIEW,
    queryFn: () => analyticsApi.getOverview(),
  });
}
