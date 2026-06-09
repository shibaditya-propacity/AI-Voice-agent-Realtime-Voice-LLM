import { useQuery } from '@tanstack/react-query';
import { QUERY_KEYS } from '@saas/config';
import { callsApi } from '../api/callsApi';

export function useCallsList(page = 1) {
  return useQuery({
    queryKey: [...QUERY_KEYS.CALLS.LIST, page],
    queryFn: () => callsApi.list(page),
  });
}

export function useCallStats() {
  return useQuery({
    queryKey: QUERY_KEYS.CALLS.STATS,
    queryFn: () => callsApi.stats(),
  });
}

export function useCallDetail(id: string | null) {
  return useQuery({
    queryKey: QUERY_KEYS.CALLS.DETAIL(id ?? ''),
    queryFn: () => callsApi.detail(id!),
    enabled: !!id,
  });
}
