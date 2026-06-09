import { apiRequest } from '@/lib/api';
import { API_ROUTES } from '@saas/config';

export type CallStatus = 'DIALING' | 'COMPLETED' | 'FAILED' | 'NO_ANSWER';

export interface CallLog {
  id: string;
  callSid: string;
  duration: number;
  language: string;
  summary: string | null;
  direction: string;
  status: CallStatus;
  from: string | null;
  to: string | null;
  recordingUrl: string | null;
  createdAt: string;
  Lead: { id: string; name: string | null; phone: string } | null;
}

export interface ConversationTurn {
  id: string;
  role: 'USER' | 'ASSISTANT' | 'SYSTEM';
  content: string;
  language: string;
  createdAt: string;
}

export interface CallDetail extends CallLog {
  Conversation: ConversationTurn[];
}

export interface CallStats {
  total: number;
  totalToday: number;
  avgDuration: string;
  missed: number;
}

export interface CallsListResponse {
  logs: CallLog[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export const callsApi = {
  list: (page = 1, limit = 20) =>
    apiRequest<CallsListResponse>('get', `${API_ROUTES.CALLS.LIST}?page=${page}&limit=${limit}`),

  stats: () => apiRequest<CallStats>('get', API_ROUTES.CALLS.STATS),

  detail: (id: string) => apiRequest<CallDetail>('get', API_ROUTES.CALLS.DETAIL(id)),
};
