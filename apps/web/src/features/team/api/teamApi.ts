import { apiRequest } from '@/lib/api';
import { API_ROUTES } from '@saas/config';

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  createdAt: string;
}

export interface TeamStats {
  total: number;
  admins: number;
  managers: number;
}

export interface TeamResponse {
  members: TeamMember[];
  stats: TeamStats;
}

export const teamApi = {
  list: () => apiRequest<TeamResponse>('get', API_ROUTES.TEAM.LIST),
};
