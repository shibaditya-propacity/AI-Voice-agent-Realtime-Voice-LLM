'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  Plus, Megaphone, ChevronRight, Play, Trash2,
  CheckCircle, Clock, AlertCircle, Loader2,
} from 'lucide-react';
import { ROUTES } from '@saas/config';
import {
  useCampaigns, useCreateCampaign, useDeleteCampaign, useStartCampaign,
} from '@/features/call-center/hooks/useCallCenter';
import type { Campaign } from '@/features/call-center/api/callCenterApi';

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

function CreateCampaignModal({ onClose }: { onClose: () => void }) {
  const { mutateAsync, isPending } = useCreateCampaign();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!name.trim()) { setError('Name is required'); return; }
    try {
      await mutateAsync({ name: name.trim(), description: description.trim() || undefined });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Create Campaign</h2>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Campaign Name *</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Q3 Follow-up"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Optional description…"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 resize-none"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
            >
              {isPending ? 'Creating…' : 'Create'}
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

      {/* Progress */}
      <div className="mt-4">
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
