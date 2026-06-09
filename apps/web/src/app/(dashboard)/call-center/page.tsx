'use client';

import Link from 'next/link';
import {
  Users, Megaphone, PhoneCall, CheckCircle, XCircle, Activity,
} from 'lucide-react';
import { ROUTES } from '@saas/config';
import { useCallCenterStats } from '@/features/call-center/hooks/useCallCenter';

function StatCard({
  label, value, sub, icon: Icon, color,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ElementType;
  color: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 flex items-start gap-4">
      <div className={`flex-shrink-0 h-10 w-10 rounded-lg flex items-center justify-center ${color}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-sm text-gray-500">{label}</p>
        <p className="text-2xl font-bold text-gray-900 mt-0.5">{value}</p>
        {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

function QuickActionCard({
  title, description, href, icon: Icon, badge,
}: {
  title: string;
  description: string;
  href: string;
  icon: React.ElementType;
  badge?: string;
}) {
  return (
    <Link
      href={href}
      className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md hover:border-indigo-200 transition-all group"
    >
      <div className="flex items-center gap-3 mb-3">
        <div className="h-9 w-9 rounded-lg bg-indigo-50 flex items-center justify-center group-hover:bg-indigo-100 transition-colors">
          <Icon className="h-5 w-5 text-indigo-600" />
        </div>
        {badge && (
          <span className="ml-auto text-xs font-medium px-2 py-0.5 rounded-full bg-green-50 text-green-700">
            {badge}
          </span>
        )}
      </div>
      <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      <p className="text-xs text-gray-500 mt-1">{description}</p>
    </Link>
  );
}

export default function CallCenterPage() {
  const { data: stats, isLoading } = useCallCenterStats();

  const successRate = stats && stats.totalCallJobs > 0
    ? Math.round((stats.completedCalls / stats.totalCallJobs) * 100)
    : 0;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Call Center</h1>
        <p className="text-sm text-gray-500 mt-1">Manage contacts, campaigns, and outbound calls</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatCard
          label="Total Contacts"
          value={isLoading ? '—' : (stats?.totalContacts ?? 0).toLocaleString()}
          icon={Users}
          color="bg-blue-50 text-blue-600"
        />
        <StatCard
          label="Campaigns"
          value={isLoading ? '—' : (stats?.totalCampaigns ?? 0)}
          sub={stats ? `${stats.activeCampaigns} active` : undefined}
          icon={Megaphone}
          color="bg-purple-50 text-purple-600"
        />
        <StatCard
          label="Active Now"
          value={isLoading ? '—' : (stats?.activeCampaigns ?? 0)}
          icon={Activity}
          color="bg-yellow-50 text-yellow-600"
        />
        <StatCard
          label="Total Calls"
          value={isLoading ? '—' : (stats?.totalCallJobs ?? 0).toLocaleString()}
          icon={PhoneCall}
          color="bg-indigo-50 text-indigo-600"
        />
        <StatCard
          label="Completed"
          value={isLoading ? '—' : (stats?.completedCalls ?? 0).toLocaleString()}
          sub={stats ? `${successRate}% success` : undefined}
          icon={CheckCircle}
          color="bg-green-50 text-green-600"
        />
        <StatCard
          label="Failed"
          value={isLoading ? '—' : (stats?.failedCalls ?? 0).toLocaleString()}
          icon={XCircle}
          color="bg-red-50 text-red-600"
        />
      </div>

      {/* Quick actions */}
      <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Quick Actions</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <QuickActionCard
            title="Manage Contacts"
            description="Add contacts manually or import from Excel / CSV"
            href={ROUTES.CALL_CENTER_CONTACTS}
            icon={Users}
          />
          <QuickActionCard
            title="Campaigns"
            description="Create calling campaigns and bulk-dial contacts sequentially"
            href={ROUTES.CALL_CENTER_CAMPAIGNS}
            icon={Megaphone}
            badge="New"
          />
        </div>
      </div>
    </div>
  );
}
