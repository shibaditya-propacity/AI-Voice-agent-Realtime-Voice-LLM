import { useQuery } from '@tanstack/react-query';
import { QUERY_KEYS } from '@saas/config';
import { callsApi } from '../api/callsApi';

export function useCallsList(page = 1) {
  return useQuery({
    queryKey: [...QUERY_KEYS.CALLS.LIST, page],
    queryFn: () => callsApi.list(page),
    refetchInterval: 5000,
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
    refetchInterval: 5000,
  });
}

export function useCallEvents(id: string | null) {
  return useQuery({
    queryKey: [...QUERY_KEYS.CALLS.DETAIL(id ?? ''), 'events'],
    queryFn: () => callsApi.events(id!),
    enabled: !!id,
    staleTime: 30000, // events don't change after call ends — cache for 30s
  });
}
