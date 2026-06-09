export type ContactSource = 'MANUAL' | 'CSV_IMPORT' | 'EXCEL_IMPORT';
export type CampaignStatus = 'DRAFT' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
export type CampaignContactStatus = 'PENDING' | 'DIALING' | 'ANSWERED' | 'FAILED' | 'SKIPPED';
export type CallJobStatus = 'QUEUED' | 'DIALING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface Contact {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  project: string | null;
  notes: string | null;
  source: ContactSource;
  createdAt: string;
  updatedAt: string;
}

export interface Campaign {
  id: string;
  name: string;
  description: string | null;
  status: CampaignStatus;
  totalContacts: number;
  dialedCount: number;
  answeredCount: number;
  failedCount: number;
  scheduledAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdById: string;
}

export interface CampaignContact {
  id: string;
  campaignId: string;
  contactId: string;
  position: number;
  status: CampaignContactStatus;
  createdAt: string;
  Contact: Contact;
}

export interface CallJob {
  id: string;
  contactId: string;
  campaignId: string | null;
  callSid: string | null;
  status: CallJobStatus;
  provider: string;
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  Contact: Pick<Contact, 'id' | 'name' | 'phone'>;
}

export interface ContactsListResponse {
  contacts: Contact[];
  total: number;
  page: number;
  pages: number;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  duplicates: number;
  errors: Array<{ row: number; phone: string; reason: string }>;
}

export interface CampaignWithStats extends Campaign {
  CampaignContacts?: CampaignContact[];
}

export interface CampaignsListResponse {
  campaigns: CampaignWithStats[];
  total: number;
  page: number;
  pages: number;
}

export interface CallJobsListResponse {
  jobs: CallJob[];
  total: number;
  page: number;
  pages: number;
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

export interface CreateContactInput {
  name: string;
  phone: string;
  email?: string;
  project?: string;
  notes?: string;
}

export interface ImportContactRow {
  name: string;
  phone: string;
  email?: string;
  project?: string;
  notes?: string;
}

export interface CreateCampaignInput {
  name: string;
  description?: string;
}

export interface TriggerCallInput {
  contactId: string;
  campaignId?: string;
}
