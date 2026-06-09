import { useQuery } from '@tanstack/react-query';
import { QUERY_KEYS } from '@saas/config';
import { callsApi } from '../api/callsApi';

export function useCallsList(page = 1) {
  return useQuery({
    queryKey: [...QUERY_KEYS.CALLS.LIST, page],
    queryFn: () => callsApi.list(page),
    refetchInterval: 5000, // poll every 5s so in-progress calls appear live
  });
}

export function useCallStats() {
  return useQuery({
    queryKey: QUERY_KEYS.CALLS.STATS,
    queryFn: () => callsApi.stats(),
    refetchInterval: 10000,
  });
}

export function useCallDetail(id: string | null) {
  return useQuery({
    queryKey: QUERY_KEYS.CALLS.DETAIL(id ?? ''),
    queryFn: () => callsApi.detail(id!),
    enabled: !!id,
    refetchInterval: 5000, // refresh open transcript panels too
  });
}
