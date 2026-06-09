import { useQuery } from '@tanstack/react-query';
import { QUERY_KEYS } from '@saas/config';
import { teamApi } from '../api/teamApi';

export function useTeam() {
  return useQuery({
    queryKey: QUERY_KEYS.TEAM.LIST,
    queryFn: () => teamApi.list(),
  });
}
