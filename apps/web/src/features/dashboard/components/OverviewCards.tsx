'use client';

import { TrendingUp, TrendingDown } from 'lucide-react';
import { useDashboardOverview } from '../hooks/useDashboard';

const colorMap: Record<string, string> = {
  indigo: 'bg-indigo-50 text-indigo-600',
  emerald: 'bg-emerald-50 text-emerald-600',
  amber: 'bg-amber-50 text-amber-600',
  violet: 'bg-violet-50 text-violet-600',
};

const iconMap: Record<string, string> = {
  indigo: '📞',
  emerald: '🏠',
  amber: '⏱',
  violet: '👥',
};

function SkeletonCard() {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 animate-pulse">
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <div className="h-3 w-28 bg-gray-200 rounded" />
          <div className="h-8 w-16 bg-gray-200 rounded" />
        </div>
        <div className="h-10 w-10 rounded-lg bg-gray-200" />
      </div>
      <div className="mt-4 h-3 w-32 bg-gray-100 rounded" />
    </div>
  );
}

export function OverviewCards() {
  const { data, isLoading, isError } = useDashboardOverview();

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600">
        Failed to load overview. Check that the API is running.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      {data.cards.map((card) => (
        <div
          key={card.id}
          className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 hover:shadow-md transition-shadow"
        >
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-gray-500">{card.label}</p>
              <p className="mt-2 text-3xl font-semibold text-gray-900 tracking-tight">
                {card.value}
              </p>
            </div>
            <div
              className={[
                'h-10 w-10 rounded-lg flex items-center justify-center text-lg',
                colorMap[card.color] ?? 'bg-gray-50 text-gray-500',
              ].join(' ')}
            >
              {iconMap[card.color] ?? '📊'}
            </div>
          </div>
          <div className="mt-4 flex items-center gap-1.5">
            {card.delta !== '—' ? (
              card.deltaPositive ? (
                <TrendingUp className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />
              ) : (
                <TrendingDown className="h-3.5 w-3.5 text-red-400 flex-shrink-0" />
              )
            ) : null}
            <span
              className={[
                'text-xs font-medium',
                card.delta === '—'
                  ? 'text-gray-400'
                  : card.deltaPositive
                    ? 'text-emerald-600'
                    : 'text-red-500',
              ].join(' ')}
            >
              {card.delta}
            </span>
            <span className="text-xs text-gray-400">{card.description}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
