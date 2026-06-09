'use client';

import { useState, useRef, useEffect } from 'react';
import { ChevronDown, LogOut, User, CreditCard } from 'lucide-react';
import { useAuth } from '@/features/auth/hooks/useAuth';

export function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const initials = user?.name
    ? user.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()
    : 'U';

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-gray-100 transition-colors"
      >
        <div className="h-7 w-7 rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 flex items-center justify-center text-white text-xs font-semibold">
          {initials}
        </div>
        <div className="hidden sm:block text-left">
          <div className="text-sm font-medium text-gray-900 leading-none">{user?.name ?? 'User'}</div>
          <div className="text-xs text-gray-500 mt-0.5">{user?.email ?? ''}</div>
        </div>
        <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
      </button>

      {open && (
        <div className="absolute right-0 mt-1.5 w-56 rounded-xl bg-white border border-gray-200 shadow-lg py-1 z-50 animate-fade-in">
          <div className="px-4 py-2.5 border-b border-gray-100">
            <div className="text-sm font-medium text-gray-900">{user?.name}</div>
            <div className="text-xs text-gray-500">{user?.email}</div>
          </div>
          <div className="py-1">
            {[
              { icon: User, label: 'Profile' },
              { icon: CreditCard, label: 'Billing' },
            ].map(({ icon: Icon, label }) => (
              <button
                key={label}
                className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
              >
                <Icon className="h-4 w-4 text-gray-400" />
                {label}
              </button>
            ))}
          </div>
          <div className="border-t border-gray-100 py-1">
            <button
              onClick={logout}
              className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
