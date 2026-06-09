'use client';

import { Users, UserPlus, Shield, Crown } from 'lucide-react';
import { useTeam } from '@/features/team/hooks/useTeam';

function roleLabel(role: string) {
  return role === 'admin' ? 'Admin' : 'Manager';
}

function roleBadge(role: string) {
  return role === 'admin'
    ? 'bg-indigo-50 text-indigo-700 border-indigo-200'
    : 'bg-gray-100 text-gray-600 border-gray-200';
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function initials(name: string) {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

export default function TeamPage() {
  const { data, isLoading, isError } = useTeam();

  const admins = data?.stats.admins ?? 0;
  const managers = data?.stats.managers ?? 0;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Team</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage your team members and their access levels.
          </p>
        </div>
        <button className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors opacity-50 cursor-not-allowed" disabled>
          <UserPlus className="h-4 w-4" />
          Invite Member
        </button>
      </div>

      {/* Role stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
          <div className="h-10 w-10 rounded-lg bg-indigo-50 flex items-center justify-center flex-shrink-0">
            <Crown className="h-5 w-5 text-indigo-600" />
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500">Admins</p>
            <p className="text-xl font-semibold text-gray-900 mt-0.5">
              {isLoading ? '…' : admins}
            </p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
          <div className="h-10 w-10 rounded-lg bg-emerald-50 flex items-center justify-center flex-shrink-0">
            <Shield className="h-5 w-5 text-emerald-600" />
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500">Managers</p>
            <p className="text-xl font-semibold text-gray-900 mt-0.5">
              {isLoading ? '…' : managers}
            </p>
          </div>
        </div>
      </div>

      {/* Members table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">
            Members
            {data && (
              <span className="ml-2 text-sm font-normal text-gray-400">
                ({data.stats.total})
              </span>
            )}
          </h2>
        </div>

        {/* Table header */}
        <div className="hidden sm:grid grid-cols-4 gap-4 px-6 py-3 bg-gray-50 border-b border-gray-100 text-xs font-medium text-gray-500 uppercase tracking-wide">
          <span className="col-span-2">Member</span>
          <span>Role</span>
          <span>Joined</span>
        </div>

        {isLoading && (
          <div className="divide-y divide-gray-50">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="grid grid-cols-4 gap-4 px-6 py-4 animate-pulse items-center">
                <div className="col-span-2 flex items-center gap-3">
                  <div className="h-9 w-9 rounded-full bg-gray-200 flex-shrink-0" />
                  <div className="space-y-1.5">
                    <div className="h-3 w-28 bg-gray-200 rounded" />
                    <div className="h-3 w-40 bg-gray-100 rounded" />
                  </div>
                </div>
                <div className="h-5 w-16 bg-gray-100 rounded-full" />
                <div className="h-3 w-20 bg-gray-100 rounded" />
              </div>
            ))}
          </div>
        )}

        {isError && (
          <div className="px-6 py-8 text-center text-sm text-red-500">
            Failed to load team members. Check that the API is running.
          </div>
        )}

        {!isLoading && data && data.members.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center px-6">
            <div className="h-14 w-14 rounded-full bg-indigo-50 flex items-center justify-center mb-4">
              <Users className="h-7 w-7 text-indigo-400" />
            </div>
            <p className="text-sm font-semibold text-gray-900">No team members yet</p>
            <p className="text-sm text-gray-500 mt-1 max-w-xs">
              Invite your team to collaborate and manage the platform together.
            </p>
          </div>
        )}

        {!isLoading && data && data.members.length > 0 && (
          <div className="divide-y divide-gray-50">
            {data.members.map((member) => (
              <div
                key={member.id}
                className="grid grid-cols-4 gap-4 px-6 py-4 hover:bg-gray-50/50 transition-colors items-center"
              >
                <div className="col-span-2 flex items-center gap-3 min-w-0">
                  <div className="h-9 w-9 rounded-full bg-indigo-600 flex items-center justify-center flex-shrink-0">
                    <span className="text-xs font-semibold text-white">{initials(member.name)}</span>
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{member.name}</p>
                    <p className="text-xs text-gray-400 truncate">{member.email}</p>
                  </div>
                </div>
                <span
                  className={[
                    'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border w-fit',
                    roleBadge(member.role),
                  ].join(' ')}
                >
                  {roleLabel(member.role)}
                </span>
                <span className="text-sm text-gray-500">{formatDate(member.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
