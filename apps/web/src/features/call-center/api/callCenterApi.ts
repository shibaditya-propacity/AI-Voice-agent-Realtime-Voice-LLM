import { apiRequest } from '@/lib/api';
import { API_ROUTES } from '@saas/config';

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface Contact {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  project: string | null;
  source: 'MANUAL' | 'IMPORT' | 'API';
  tags: string[];
  notes: string | null;
  createdAt: string;
}

export interface Campaign {
  id: string;
  name: string;
  description: string | null;
  status: 'DRAFT' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
  totalContacts: number;
  dialedCount: number;
  answeredCount: number;
  failedCount: number;
  createdAt: string;
  completedAt: string | null;
  CreatedBy: { id: string; name: string | null } | null;
  _count?: { CampaignContacts: number; CallJobs: number };
}

export interface CampaignDetail extends Campaign {
  CampaignContacts: Array<{
    id: string;
    position: number;
    status: 'PENDING' | 'DIALING' | 'ANSWERED' | 'NO_ANSWER' | 'FAILED' | 'SKIPPED';
    Contact: Contact;
  }>;
}

export interface CallJob {
  id: string;
  contactId: string;
  campaignId: string | null;
  status: 'QUEUED' | 'DIALING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  callSid: string | null;
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  Contact: { id: string; name: string; phone: string };
}

export interface CallJobStats {
  total: number;
  queued: number;
  dialing: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface CallCenterDashboardStats {
  totalContacts: number;
  totalCampaigns: number;
  activeCampaigns: number;
  totalCallJobs: number;
  completedCalls: number;
  failedCalls: number;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pages: number;
}

// ─── API client ───────────────────────────────────────────────────────────────

export const contactsApi = {
  list: (page = 1, search?: string) =>
    apiRequest<{ contacts: Contact[]; total: number; page: number; pages: number }>(
      'get',
      `${API_ROUTES.CONTACTS.LIST}?page=${page}${search ? `&search=${encodeURIComponent(search)}` : ''}`,
    ),

  create: (data: { name: string; phone: string; email?: string; project?: string; notes?: string }) =>
    apiRequest<Contact>('post', API_ROUTES.CONTACTS.CREATE, data),

  import: (rows: Array<{ name?: string; phone: string; email?: string; project?: string }>) =>
    apiRequest<{ imported: number; errors: string[] }>('post', API_ROUTES.CONTACTS.IMPORT, { rows }),

  delete: (id: string) => apiRequest<void>('delete', API_ROUTES.CONTACTS.DELETE(id)),
};

export const campaignsApi = {
  list: (page = 1) =>
    apiRequest<{ campaigns: Campaign[]; total: number; page: number; pages: number }>(
      'get',
      `${API_ROUTES.CAMPAIGNS.LIST}?page=${page}`,
    ),

  detail: (id: string) => apiRequest<CampaignDetail>('get', API_ROUTES.CAMPAIGNS.DETAIL(id)),

  create: (data: { name: string; description?: string }) =>
    apiRequest<Campaign>('post', API_ROUTES.CAMPAIGNS.CREATE, data),

  update: (id: string, data: { name?: string; description?: string; status?: string }) =>
    apiRequest<Campaign>('patch', API_ROUTES.CAMPAIGNS.UPDATE(id), data),

  delete: (id: string) => apiRequest<void>('delete', API_ROUTES.CAMPAIGNS.DELETE(id)),

  addContacts: (id: string, contactIds: string[]) =>
    apiRequest<{ added: number }>('post', API_ROUTES.CAMPAIGNS.CONTACTS(id), { contactIds }),

  removeContact: (campaignId: string, contactId: string) =>
    apiRequest<void>('delete', API_ROUTES.CAMPAIGNS.REMOVE_CONTACT(campaignId, contactId)),
};

export const callJobsApi = {
  list: (page = 1, campaignId?: string) =>
    apiRequest<{ jobs: CallJob[]; total: number; page: number; pages: number }>(
      'get',
      `${API_ROUTES.CALL_JOBS.LIST}?page=${page}${campaignId ? `&campaignId=${campaignId}` : ''}`,
    ),

  trigger: (contactId: string, campaignId?: string) =>
    apiRequest<CallJob>('post', API_ROUTES.CALL_JOBS.TRIGGER, { contactId, campaignId }),

  stats: (campaignId?: string) =>
    apiRequest<CallJobStats>(
      'get',
      `${API_ROUTES.CALL_JOBS.STATS}${campaignId ? `?campaignId=${campaignId}` : ''}`,
    ),

  startCampaign: (campaignId: string) =>
    apiRequest<{ started: boolean }>('post', API_ROUTES.CALL_JOBS.START_CAMPAIGN(campaignId)),
};

export const callCenterDashboardApi = {
  stats: () => apiRequest<CallCenterDashboardStats>('get', API_ROUTES.CALL_CENTER_DASHBOARD.STATS),
};
