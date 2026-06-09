'use client';

import { BarChart3, TrendingUp, Users, Phone, Clock, CheckSquare } from 'lucide-react';
import { useAnalyticsOverview } from '@/features/analytics/hooks/useAnalytics';

function StatCard({
  label,
  value,
  icon: Icon,
  color,
  sub,
}: {
  label: string;
  value: string | number;
  icon: React.ElementType;
  color: string;
  sub?: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-gray-500">{label}</p>
          <p className="mt-2 text-3xl font-semibold text-gray-900 tracking-tight">{value}</p>
        </div>
        <div className={['h-10 w-10 rounded-lg flex items-center justify-center', color].join(' ')}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
      {sub && <p className="mt-3 text-xs text-gray-400">{sub}</p>}
    </div>
  );
}

const chartSections = [
  { title: 'Call Volume Over Time', description: 'Daily call trends for the selected period' },
  { title: 'Lead Qualification Funnel', description: 'Conversion rates across lead stages' },
  { title: 'Call Duration Distribution', description: 'Breakdown of call lengths' },
  { title: 'Language Breakdown', description: 'Calls handled per language' },
];

export default function AnalyticsPage() {
  const { data, isLoading, isError } = useAnalyticsOverview();

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Analytics</h1>
          <p className="mt-1 text-sm text-gray-500">
            Track performance metrics and gain insights into your AI agent.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {['7d', '30d', '90d'].map((range) => (
            <button
              key={range}
              className={[
                'px-3 py-1.5 text-sm font-medium rounded-lg transition-colors',
                range === '7d' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-100',
              ].join(' ')}
            >
              {range}
            </button>
          ))}
        </div>
      </div>

      {isError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600">
          Failed to load analytics. Check that the API is running.
        </div>
      )}

      {/* Metric cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard
          label="Total Calls"
          value={isLoading ? '…' : (data?.totalCalls ?? '—')}
          icon={Phone}
          color="bg-indigo-50 text-indigo-600"
          sub={isLoading ? undefined : `${data?.callsThisWeek ?? 0} this week`}
        />
        <StatCard
          label="Qualified Leads"
          value={isLoading ? '…' : (data?.qualifiedLeads ?? '—')}
          icon={Users}
          color="bg-emerald-50 text-emerald-600"
          sub={isLoading ? undefined : `of ${data?.totalLeads ?? 0} total leads`}
        />
        <StatCard
          label="Avg Handle Time"
          value={isLoading ? '…' : (data?.avgHandleTime ?? '—')}
          icon={Clock}
          color="bg-amber-50 text-amber-600"
          sub="per call"
        />
        <StatCard
          label="Conversion Rate"
          value={isLoading ? '…' : (data?.conversionRate ?? '—')}
          icon={TrendingUp}
          color="bg-violet-50 text-violet-600"
          sub={isLoading ? undefined : `${data?.visitsCompleted ?? 0} site visits completed`}
        />
      </div>

      {/* Charts — Coming Soon */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {chartSections.map((section) => (
          <div
            key={section.title}
            className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden"
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">{section.title}</h3>
                <p className="text-xs text-gray-500 mt-0.5">{section.description}</p>
              </div>
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
                Coming Soon
              </span>
            </div>
            <div className="flex flex-col items-center justify-center h-48 text-center px-6">
              <div className="h-12 w-12 rounded-full bg-gray-50 flex items-center justify-center mb-3">
                <BarChart3 className="h-6 w-6 text-gray-300" />
              </div>
              <p className="text-sm text-gray-400">Chart will render once data is available</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
