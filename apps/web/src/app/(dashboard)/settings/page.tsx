'use client';

import { useAuthStore } from '@/features/auth/store/authStore';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { User, Lock, Bell, Globe, Trash2, LogOut } from 'lucide-react';

const settingSections = [
  {
    id: 'notifications',
    icon: Bell,
    title: 'Notifications',
    description: 'Email and in-app notification preferences',
    color: 'bg-amber-50 text-amber-600',
  },
  {
    id: 'language',
    icon: Globe,
    title: 'Language & Region',
    description: 'Display language and timezone settings',
    color: 'bg-emerald-50 text-emerald-600',
  },
];

export default function SettingsPage() {
  const { user } = useAuthStore();
  const { logout } = useAuth();

  const initials = user?.name
    ? user.name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : '?';

  return (
    <div className="space-y-8 max-w-2xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Settings</h1>
        <p className="mt-1 text-sm text-gray-500">Manage your account and preferences.</p>
      </div>

      {/* Profile card */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-5">
        <div className="flex items-center gap-2">
          <User className="h-4 w-4 text-gray-400" />
          <h2 className="text-sm font-semibold text-gray-900">Profile</h2>
        </div>

        <div className="flex items-center gap-4">
          <div className="h-14 w-14 rounded-full bg-indigo-600 flex items-center justify-center flex-shrink-0">
            <span className="text-white font-semibold text-lg">{initials}</span>
          </div>
          <div>
            <p className="text-base font-semibold text-gray-900">{user?.name ?? '—'}</p>
            <p className="text-sm text-gray-500">{user?.email ?? '—'}</p>
            <span
              className={[
                'mt-1 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium',
                user?.role === 'admin'
                  ? 'bg-indigo-50 text-indigo-700'
                  : 'bg-gray-100 text-gray-600',
              ].join(' ')}
            >
              {user?.role === 'admin' ? 'Admin' : 'Manager'}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Full name</label>
            <input
              type="text"
              defaultValue={user?.name ?? ''}
              disabled
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-gray-50 text-gray-500 cursor-not-allowed"
              placeholder="—"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Email address</label>
            <input
              type="email"
              defaultValue={user?.email ?? ''}
              disabled
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-gray-50 text-gray-500 cursor-not-allowed"
              placeholder="—"
            />
          </div>
        </div>

        <div className="pt-1 flex items-center gap-2">
          <button
            disabled
            className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg opacity-50 cursor-not-allowed"
          >
            Save changes
          </button>
          <span className="text-xs text-gray-400">Profile editing coming soon</span>
        </div>
      </div>

      {/* Password */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-gray-400" />
            <h2 className="text-sm font-semibold text-gray-900">Password</h2>
          </div>
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
            Coming Soon
          </span>
        </div>
        <p className="text-sm text-gray-500">
          Password change and two-factor authentication will be available soon.
        </p>
      </div>

      {/* Other settings — Coming Soon */}
      <div className="space-y-3">
        {settingSections.map((section) => {
          const Icon = section.icon;
          return (
            <div
              key={section.id}
              className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-center justify-between"
            >
              <div className="flex items-center gap-4">
                <div
                  className={[
                    'h-9 w-9 rounded-lg flex items-center justify-center flex-shrink-0',
                    section.color,
                  ].join(' ')}
                >
                  <Icon className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-900">{section.title}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{section.description}</p>
                </div>
              </div>
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
                Coming Soon
              </span>
            </div>
          );
        })}
      </div>

      {/* Danger zone */}
      <div className="bg-white rounded-xl border border-red-100 shadow-sm p-6 space-y-4">
        <h2 className="text-sm font-semibold text-red-600">Danger Zone</h2>
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-gray-900">Sign out</p>
            <p className="text-xs text-gray-500 mt-0.5">Sign out of your account on this device.</p>
          </div>
          <button
            onClick={logout}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors flex-shrink-0"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
        <div className="border-t border-gray-100 pt-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-gray-900">Delete account</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Permanently delete your account and all associated data.
            </p>
          </div>
          <button
            disabled
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-red-600 bg-white border border-red-200 rounded-lg opacity-50 cursor-not-allowed flex-shrink-0"
          >
            <Trash2 className="h-4 w-4" />
            Delete account
          </button>
        </div>
      </div>
    </div>
  );
}
