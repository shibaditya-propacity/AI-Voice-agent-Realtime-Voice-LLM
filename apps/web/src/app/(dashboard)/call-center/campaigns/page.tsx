'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  Plus, Megaphone, ChevronRight, Play, Trash2,
  CheckCircle, Clock, AlertCircle, Loader2, Users, Mic2, FileText,
} from 'lucide-react';
import { ROUTES } from '@saas/config';
import {
  useCampaigns, useCreateCampaign, useDeleteCampaign, useStartCampaign,
} from '@/features/call-center/hooks/useCallCenter';
import type { Campaign } from '@/features/call-center/api/callCenterApi';

const INTENTION_TYPES = [
  'Real Estate Sales',
  'Lead Qualification',
  'Follow-up Call',
  'Appointment Booking',
  'Survey',
  'Customer Support',
  'Other',
] as const;

const STATUS_CONFIG: Record<Campaign['status'], { label: string; color: string; icon: React.ElementType }> = {
  DRAFT: { label: 'Draft', color: 'bg-gray-100 text-gray-600', icon: Clock },
  RUNNING: { label: 'Running', color: 'bg-blue-100 text-blue-700', icon: Loader2 },
  PAUSED: { label: 'Paused', color: 'bg-yellow-100 text-yellow-700', icon: AlertCircle },
  COMPLETED: { label: 'Completed', color: 'bg-green-100 text-green-700', icon: CheckCircle },
  CANCELLED: { label: 'Cancelled', color: 'bg-red-100 text-red-600', icon: AlertCircle },
};

function StatusBadge({ status }: { status: Campaign['status'] }) {
  const { label, color, icon: Icon } = STATUS_CONFIG[status] ?? STATUS_CONFIG.DRAFT;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>
      <Icon className={`h-3 w-3 ${status === 'RUNNING' ? 'animate-spin' : ''}`} />
      {label}
    </span>
  );
}

function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full bg-indigo-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-500 w-8 text-right">{pct}%</span>
    </div>
  );
}

function FieldLabel({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block text-xs font-semibold text-gray-700 mb-1">
      {children}{required && <span className="text-red-500 ml-0.5">*</span>}
    </label>
  );
}

function CreateCampaignModal({ onClose }: { onClose: () => void }) {
  const { mutateAsync, isPending } = useCreateCampaign();

  const [name, setName]                   = useState('');
  const [description, setDescription]     = useState('');
  const [intentionType, setIntentionType] = useState('');
  const [systemPrompt, setSystemPrompt]   = useState('');
  const [prospectLabel, setProspectLabel] = useState('Prospects');
  const [error, setError]                 = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!name.trim()) { setError('Campaign name is required'); return; }
    try {
      await mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        intentionType: intentionType || undefined,
        systemPrompt: systemPrompt.trim() || undefined,
        prospectLabel: prospectLabel.trim() || 'Prospects',
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl my-auto">

        {/* Header */}
        <div className="px-6 py-5 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900">New Campaign</h2>
          <p className="text-sm text-gray-500 mt-0.5">Configure the campaign details and AI voice behaviour.</p>
        </div>

        <form onSubmit={submit}>
          <div className="px-6 py-5 space-y-5">

            {/* Row 1: Name + Prospect label */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <FieldLabel required>Campaign Name</FieldLabel>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. June Real Estate Push"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-400"
                />
              </div>
              <div>
                <FieldLabel required>
                  <span className="flex items-center gap-1"><Users className="h-3 w-3" /> Prospects Called</span>
                </FieldLabel>
                <input
                  value={prospectLabel}
                  onChange={(e) => setProspectLabel(e.target.value)}
                  placeholder="e.g. Prospects, Leads, Buyers, Clients"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-400"
                />
                <p className="text-[10px] text-gray-400 mt-1">What to call the people in this campaign.</p>
              </div>
            </div>

            {/* Row 2: Intention type */}
            <div>
              <FieldLabel>
                <span className="flex items-center gap-1"><Mic2 className="h-3 w-3" /> Call Intention Type</span>
              </FieldLabel>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {INTENTION_TYPES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setIntentionType(intentionType === t ? '' : t)}
                    className={`px-3 py-2 rounded-lg border text-xs font-medium text-left transition-colors ${
                      intentionType === t
                        ? 'bg-indigo-600 border-indigo-600 text-white'
                        : 'border-gray-200 text-gray-600 hover:border-indigo-300 hover:bg-indigo-50'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            {/* Row 3: Description */}
            <div>
              <FieldLabel>Description</FieldLabel>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="Optional — brief notes about this campaign's goal."
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-400 resize-none"
              />
            </div>

            {/* Row 4: System prompt */}
            <div>
              <FieldLabel>
                <span className="flex items-center gap-1"><FileText className="h-3 w-3" /> AI System Prompt</span>
              </FieldLabel>
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={6}
                placeholder="You are Arjun — a calm, confident real estate sales caller for Akshay Vista. Your goal is to book a site visit…"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-400 resize-y"
              />
              <p className="text-[10px] text-gray-400 mt-1">
                Define the AI agent's role, tone, and goals for this campaign. Leave blank to use the global agent prompt.
              </p>
            </div>

          </div>

          {error && (
            <div className="mx-6 mb-4 px-3 py-2 bg-red-50 border border-red-100 rounded-lg text-sm text-red-600">{error}</div>
          )}

          <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors">
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="px-5 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {isPending ? 'Creating…' : 'Create Campaign'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CampaignCard({ campaign }: { campaign: Campaign }) {
  const { mutate: deleteCampaign } = useDeleteCampaign();
  const { mutate: startCampaign, isPending: starting } = useStartCampaign();
  const canStart = campaign.status === 'DRAFT' || campaign.status === 'PAUSED';

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-sm transition-shadow">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-gray-900 truncate">{campaign.name}</h3>
            <StatusBadge status={campaign.status} />
          </div>
          {campaign.description && (
            <p className="text-xs text-gray-500 mt-1 line-clamp-2">{campaign.description}</p>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {canStart && (
            <button
              onClick={() => startCampaign(campaign.id)}
              disabled={starting}
              title="Start campaign"
              className="p-1.5 rounded-lg text-green-600 hover:bg-green-50 disabled:opacity-40 transition-colors"
            >
              {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            </button>
          )}
          <button
            onClick={() => { if (confirm('Delete this campaign and all its data?')) deleteCampaign(campaign.id); }}
            title="Delete"
            className="p-1.5 rounded-lg text-red-400 hover:bg-red-50 transition-colors"
          >
            <Trash2 className="h-4 w-4" />
          </button>
          <Link
            href={`${ROUTES.CALL_CENTER_CAMPAIGNS}/${campaign.id}`}
            className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 transition-colors"
            title="Open campaign"
          >
            <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
      </div>

      {/* Meta chips */}
      <div className="flex flex-wrap gap-1.5 mt-3">
        {campaign.intentionType && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-100 text-[10px] font-medium">
            <Mic2 className="h-2.5 w-2.5" />{campaign.intentionType}
          </span>
        )}
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-50 text-gray-500 border border-gray-100 text-[10px] font-medium">
          <Users className="h-2.5 w-2.5" />{campaign.prospectLabel}
        </span>
        {campaign.systemPrompt && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-600 border border-amber-100 text-[10px] font-medium">
            <FileText className="h-2.5 w-2.5" />Custom prompt
          </span>
        )}
      </div>

      {/* Progress */}
      <div className="mt-3">
        <div className="flex items-center justify-between text-xs text-gray-500 mb-1.5">
          <span>{campaign.dialedCount} / {campaign.totalContacts} dialed</span>
          <span>{campaign.answeredCount} answered · {campaign.failedCount} failed</span>
        </div>
        <ProgressBar value={campaign.dialedCount} max={campaign.totalContacts} />
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-gray-400">
        <span>{campaign._count?.CampaignContacts ?? campaign.totalContacts} contacts</span>
        <span>{new Date(campaign.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
      </div>
    </div>
  );
}

export default function CampaignsPage() {
  const [page] = useState(1);
  const [showCreate, setShowCreate] = useState(false);
  const { data, isLoading } = useCampaigns(page);

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Campaigns</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {data ? `${data.total} campaign${data.total !== 1 ? 's' : ''}` : 'Loading…'}
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-3 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
        >
          <Plus className="h-4 w-4" />
          New Campaign
        </button>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-sm text-gray-400">Loading campaigns…</div>
      ) : data?.campaigns.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
          <Megaphone className="h-10 w-10 text-gray-200 mx-auto mb-3" />
          <p className="text-sm font-medium text-gray-600">No campaigns yet</p>
          <p className="text-xs text-gray-400 mt-1 mb-4">Create a campaign to start bulk calling your contacts</p>
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
          >
            Create First Campaign
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {data?.campaigns.map((c) => <CampaignCard key={c.id} campaign={c} />)}
        </div>
      )}

      {showCreate && <CreateCampaignModal onClose={() => setShowCreate(false)} />}
    </div>
  );
}
