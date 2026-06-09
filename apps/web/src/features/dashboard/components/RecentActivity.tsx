'use client';

import { CheckCircle, AlertCircle, Circle } from 'lucide-react';
import { useDashboardActivity } from '../hooks/useDashboard';
import Link from 'next/link';
import { ROUTES } from '@saas/config';

const statusConfig = {
  success: { icon: CheckCircle, color: 'text-emerald-500', bg: 'bg-emerald-50' },
  warning: { icon: AlertCircle, color: 'text-amber-500', bg: 'bg-amber-50' },
  neutral: { icon: Circle, color: 'text-gray-400', bg: 'bg-gray-50' },
};

function SkeletonRow() {
  return (
    <div className="flex items-start gap-4 px-6 py-4 animate-pulse">
      <div className="h-8 w-8 rounded-full bg-gray-200 flex-shrink-0 mt-0.5" />
      <div className="flex-1 space-y-1.5">
        <div className="h-3 w-32 bg-gray-200 rounded" />
        <div className="h-3 w-56 bg-gray-100 rounded" />
      </div>
      <div className="h-3 w-16 bg-gray-100 rounded" />
    </div>
  );
}

export function RecentActivity() {
  const { data, isLoading, isError } = useDashboardActivity();

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
        <h2 className="text-base font-semibold text-gray-900">Recent Activity</h2>
        <Link
          href={ROUTES.CALLS}
          className="text-sm text-indigo-600 hover:text-indigo-700 font-medium"
        >
          View all
        </Link>
      </div>

      {isLoading && (
        <div className="divide-y divide-gray-50">
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonRow key={i} />
          ))}
        </div>
      )}

      {isError && (
        <div className="px-6 py-8 text-center text-sm text-red-500">
          Failed to load activity. Check that the API is running.
        </div>
      )}

      {!isLoading && !isError && data && data.length === 0 && (
        <div className="px-6 py-12 text-center text-sm text-gray-400">
          No activity yet. Activity will appear here once calls start coming in.
        </div>
      )}

      {!isLoading && !isError && data && data.length > 0 && (
        <div className="divide-y divide-gray-50">
          {data.map((item) => {
            const { icon: Icon, color, bg } = statusConfig[item.status];
            return (
              <div
                key={item.id}
                className="flex items-start gap-4 px-6 py-4 hover:bg-gray-50/50 transition-colors"
              >
                <div
                  className={[
                    'h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5',
                    bg,
                  ].join(' ')}
                >
                  <Icon className={['h-4 w-4', color].join(' ')} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900">{item.title}</p>
                  <p className="text-sm text-gray-500 mt-0.5 truncate">{item.description}</p>
                </div>
                <span className="text-xs text-gray-400 flex-shrink-0 mt-0.5">{item.time}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
