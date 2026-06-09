'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { QUERY_KEYS } from '@saas/config';
import {
  contactsApi, campaignsApi, callJobsApi, callCenterDashboardApi,
} from '../api/callCenterApi';

// ─── Dashboard ────────────────────────────────────────────────────────────────

export function useCallCenterStats() {
  return useQuery({
    queryKey: QUERY_KEYS.CALL_CENTER_DASHBOARD.STATS,
    queryFn: () => callCenterDashboardApi.stats(),
  });
}

// ─── Contacts ─────────────────────────────────────────────────────────────────

export function useContacts(page = 1, search?: string) {
  return useQuery({
    queryKey: [...QUERY_KEYS.CONTACTS.LIST, page, search],
    queryFn: () => contactsApi.list(page, search),
  });
}

export function useCreateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: contactsApi.create,
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.CONTACTS.LIST }),
  });
}

export function useImportContacts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: contactsApi.import,
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.CONTACTS.LIST }),
  });
}

export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: contactsApi.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.CONTACTS.LIST }),
  });
}

// ─── Campaigns ────────────────────────────────────────────────────────────────

export function useCampaigns(page = 1) {
  return useQuery({
    queryKey: [...QUERY_KEYS.CAMPAIGNS.LIST, page],
    queryFn: () => campaignsApi.list(page),
  });
}

export function useCampaignDetail(id: string | null) {
  return useQuery({
    queryKey: id ? QUERY_KEYS.CAMPAIGNS.DETAIL(id) : ['campaigns', 'detail', null],
    queryFn: () => campaignsApi.detail(id!),
    enabled: !!id,
  });
}

export function useCreateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: campaignsApi.create,
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.CAMPAIGNS.LIST }),
  });
}

export function useUpdateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: { name?: string; description?: string; status?: string } }) =>
      campaignsApi.update(id, data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.CAMPAIGNS.LIST });
      qc.invalidateQueries({ queryKey: QUERY_KEYS.CAMPAIGNS.DETAIL(vars.id) });
    },
  });
}

export function useDeleteCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: campaignsApi.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.CAMPAIGNS.LIST }),
  });
}

export function useAddContactsToCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ campaignId, contactIds }: { campaignId: string; contactIds: string[] }) =>
      campaignsApi.addContacts(campaignId, contactIds),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.CAMPAIGNS.DETAIL(vars.campaignId) });
    },
  });
}

export function useRemoveCampaignContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ campaignId, contactId }: { campaignId: string; contactId: string }) =>
      campaignsApi.removeContact(campaignId, contactId),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.CAMPAIGNS.DETAIL(vars.campaignId) });
    },
  });
}

// ─── Call Jobs ────────────────────────────────────────────────────────────────

export function useCallJobs(page = 1, campaignId?: string) {
  return useQuery({
    queryKey: [...QUERY_KEYS.CALL_JOBS.LIST, page, campaignId],
    queryFn: () => callJobsApi.list(page, campaignId),
  });
}

export function useCallJobStats(campaignId?: string) {
  return useQuery({
    queryKey: campaignId
      ? QUERY_KEYS.CALL_JOBS.CAMPAIGN_STATS(campaignId)
      : QUERY_KEYS.CALL_JOBS.STATS,
    queryFn: () => callJobsApi.stats(campaignId),
  });
}

export function useTriggerCall() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ contactId, campaignId }: { contactId: string; campaignId?: string }) =>
      callJobsApi.trigger(contactId, campaignId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.CALL_JOBS.LIST });
      qc.invalidateQueries({ queryKey: QUERY_KEYS.CALL_CENTER_DASHBOARD.STATS });
    },
  });
}

export function useStartCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: callJobsApi.startCampaign,
    onSuccess: (_d, campaignId) => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.CAMPAIGNS.LIST });
      qc.invalidateQueries({ queryKey: QUERY_KEYS.CAMPAIGNS.DETAIL(campaignId) });
      qc.invalidateQueries({ queryKey: QUERY_KEYS.CALL_CENTER_DASHBOARD.STATS });
    },
  });
}
