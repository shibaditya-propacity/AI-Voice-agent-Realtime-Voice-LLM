'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Play, Pause, UserPlus, Trash2, Phone,
  CheckCircle, Clock, AlertCircle, Loader2, Users,
} from 'lucide-react';
import { ROUTES } from '@saas/config';
import {
  useCampaignDetail, useContacts, useAddContactsToCampaign,
  useRemoveCampaignContact, useStartCampaign, useUpdateCampaign,
  useTriggerCall,
} from '@/features/call-center/hooks/useCallCenter';
import type { CampaignDetail } from '@/features/call-center/api/callCenterApi';

const CC_STATUS: Record<string, { label: string; color: string }> = {
  PENDING: { label: 'Pending', color: 'text-gray-500' },
  DIALING: { label: 'Dialing', color: 'text-blue-600' },
  ANSWERED: { label: 'Answered', color: 'text-green-600' },
  NO_ANSWER: { label: 'No Answer', color: 'text-yellow-600' },
  FAILED: { label: 'Failed', color: 'text-red-500' },
  SKIPPED: { label: 'Skipped', color: 'text-gray-400' },
};

function AddContactsDrawer({
  campaignId,
  existingIds,
  onClose,
}: {
  campaignId: string;
  existingIds: Set<string>;
  onClose: () => void;
}) {
  const { data, isLoading } = useContacts(1);
  const { mutateAsync, isPending } = useAddContactsToCampaign();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const available = data?.contacts.filter((c) => !existingIds.has(c.id)) ?? [];

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const addSelected = async () => {
    if (selected.size === 0) return;
    await mutateAsync({ campaignId, contactIds: Array.from(selected) });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg flex flex-col max-h-[80vh]">
        <div className="p-5 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900">Add Contacts to Campaign</h2>
          <p className="text-xs text-gray-500 mt-1">Select contacts to add. Already-added contacts are hidden.</p>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {isLoading ? (
            <p className="text-sm text-gray-400 text-center py-8">Loading contacts…</p>
          ) : available.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-8">No available contacts to add</p>
          ) : (
            <div className="space-y-1">
              {available.map((c) => (
                <label
                  key={c.id}
                  className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={() => toggle(c.id)}
                    className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900">{c.name}</p>
                    <p className="text-xs text-gray-500">{c.phone}</p>
                  </div>
                  {c.project && <span className="text-xs text-gray-400 truncate max-w-24">{c.project}</span>}
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-gray-100 flex items-center justify-between">
          <p className="text-xs text-gray-500">{selected.size} selected</p>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-2 text-sm text-gray-600 hover:text-gray-800">
              Cancel
            </button>
            <button
              onClick={addSelected}
              disabled={isPending || selected.size === 0}
              className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
            >
              {isPending ? 'Adding…' : `Add ${selected.size > 0 ? selected.size : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CampaignHeader({ campaign }: { campaign: CampaignDetail }) {
  const { mutate: start, isPending: starting } = useStartCampaign();
  const { mutate: update, isPending: updating } = useUpdateCampaign();

  const canStart = campaign.status === 'DRAFT' || campaign.status === 'PAUSED';
  const canPause = campaign.status === 'RUNNING';

  return (
    <div className="flex items-start justify-between gap-4 flex-wrap">
      <div>
        <div className="flex items-center gap-2">
          <Link href={ROUTES.CALL_CENTER_CAMPAIGNS} className="text-gray-400 hover:text-gray-600">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <h1 className="text-xl font-bold text-gray-900">{campaign.name}</h1>
          <CampaignStatusBadge status={campaign.status} />
        </div>
        {campaign.description && (
          <p className="text-sm text-gray-500 mt-1 ml-6">{campaign.description}</p>
        )}
      </div>
      <div className="flex items-center gap-2">
        {canStart && (
          <button
            onClick={() => start(campaign.id)}
            disabled={starting || campaign.CampaignContacts.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-40 transition-colors"
          >
            {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {campaign.status === 'PAUSED' ? 'Resume' : 'Start Campaign'}
          </button>
        )}
        {canPause && (
          <button
            onClick={() => update({ id: campaign.id, data: { status: 'PAUSED' } })}
            disabled={updating}
            className="flex items-center gap-1.5 px-3 py-2 text-sm bg-yellow-500 text-white rounded-lg hover:bg-yellow-600 disabled:opacity-40 transition-colors"
          >
            <Pause className="h-4 w-4" />
            Pause
          </button>
        )}
      </div>
    </div>
  );
}

function CampaignStatusBadge({ status }: { status: CampaignDetail['status'] }) {
  const map: Record<CampaignDetail['status'], { label: string; color: string }> = {
    DRAFT: { label: 'Draft', color: 'bg-gray-100 text-gray-600' },
    RUNNING: { label: 'Running', color: 'bg-blue-100 text-blue-700' },
    PAUSED: { label: 'Paused', color: 'bg-yellow-100 text-yellow-700' },
    COMPLETED: { label: 'Completed', color: 'bg-green-100 text-green-700' },
    CANCELLED: { label: 'Cancelled', color: 'bg-red-100 text-red-600' },
  };
  const { label, color } = map[status] ?? map.DRAFT;
  return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>{label}</span>;
}

function StatsRow({ campaign }: { campaign: CampaignDetail }) {
  const total = campaign.totalContacts;
  const pct = total > 0 ? Math.round((campaign.dialedCount / total) * 100) : 0;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {[
        { label: 'Total Contacts', value: total },
        { label: 'Dialed', value: `${campaign.dialedCount} (${pct}%)` },
        { label: 'Answered', value: campaign.answeredCount },
        { label: 'Failed', value: campaign.failedCount },
      ].map(({ label, value }) => (
        <div key={label} className="bg-white rounded-xl border border-gray-200 px-4 py-3 text-center">
          <p className="text-xs text-gray-500">{label}</p>
          <p className="text-xl font-bold text-gray-900 mt-0.5">{value}</p>
        </div>
      ))}
    </div>
  );
}

function ContactsList({
  campaign,
  onAddContacts,
}: {
  campaign: CampaignDetail;
  onAddContacts: () => void;
}) {
  const { mutate: removeContact } = useRemoveCampaignContact();
  const { mutate: triggerCall, isPending: calling } = useTriggerCall();

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-gray-400" />
          <h2 className="text-sm font-semibold text-gray-900">Contacts</h2>
          <span className="text-xs text-gray-400">({campaign.CampaignContacts.length})</span>
        </div>
        <button
          onClick={onAddContacts}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-indigo-50 text-indigo-700 rounded-lg hover:bg-indigo-100 transition-colors"
        >
          <UserPlus className="h-3.5 w-3.5" />
          Add Contacts
        </button>
      </div>

      {campaign.CampaignContacts.length === 0 ? (
        <div className="py-10 text-center">
          <p className="text-sm text-gray-500">No contacts in this campaign</p>
          <p className="text-xs text-gray-400 mt-1">Add contacts to start calling</p>
        </div>
      ) : (
        <div className="divide-y divide-gray-50">
          {campaign.CampaignContacts.map((cc, idx) => {
            const status = CC_STATUS[cc.status] ?? CC_STATUS.PENDING;
            return (
              <div key={cc.id} className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50">
                <span className="text-xs text-gray-300 w-6 text-right flex-shrink-0">{idx + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900">{cc.Contact.name}</p>
                  <p className="text-xs text-gray-500">{cc.Contact.phone}</p>
                </div>
                <span className={`text-xs font-medium ${status.color}`}>{status.label}</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => triggerCall({ contactId: cc.Contact.id, campaignId: campaign.id })}
                    disabled={calling}
                    title="Call now"
                    className="p-1.5 rounded-lg text-indigo-500 hover:bg-indigo-50 disabled:opacity-40 transition-colors"
                  >
                    <Phone className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => removeContact({ campaignId: campaign.id, contactId: cc.Contact.id })}
                    title="Remove"
                    className="p-1.5 rounded-lg text-red-400 hover:bg-red-50 transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: campaign, isLoading } = useCampaignDetail(id);
  const [showAddContacts, setShowAddContacts] = useState(false);

  if (isLoading) {
    return (
      <div className="p-6 text-center text-sm text-gray-400">Loading campaign…</div>
    );
  }

  if (!campaign) {
    return (
      <div className="p-6 text-center">
        <p className="text-sm text-gray-600">Campaign not found</p>
        <Link href={ROUTES.CALL_CENTER_CAMPAIGNS} className="text-sm text-indigo-600 hover:underline mt-2 inline-block">
          Back to campaigns
        </Link>
      </div>
    );
  }

  const existingIds = new Set(campaign.CampaignContacts.map((cc) => cc.Contact.id));

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <CampaignHeader campaign={campaign} />
      <StatsRow campaign={campaign} />
      <ContactsList campaign={campaign} onAddContacts={() => setShowAddContacts(true)} />

      {showAddContacts && (
        <AddContactsDrawer
          campaignId={campaign.id}
          existingIds={existingIds}
          onClose={() => setShowAddContacts(false)}
        />
      )}
    </div>
  );
}
