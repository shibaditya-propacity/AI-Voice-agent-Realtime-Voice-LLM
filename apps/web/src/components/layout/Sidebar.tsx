'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Phone,
  BarChart3,
  Settings,
  Users,
  Brain,
  X,
} from 'lucide-react';
import { ROUTES } from '@saas/config';

const navItems = [
  { label: 'Dashboard', href: ROUTES.DASHBOARD, icon: LayoutDashboard },
  { label: 'Calls', href: ROUTES.CALLS, icon: Phone },
  { label: 'Analytics', href: ROUTES.ANALYTICS, icon: BarChart3 },
  { label: 'Team', href: '/team', icon: Users },
  { label: 'AI Agents', href: '/agents', icon: Brain },
];

const bottomItems = [
  { label: 'Settings', href: ROUTES.SETTINGS, icon: Settings },
];

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

export function Sidebar({ open, onClose }: SidebarProps) {
  const pathname = usePathname();

  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar */}
      <aside
        className={[
          'fixed inset-y-0 left-0 z-50 w-64 bg-white border-r border-gray-200 flex flex-col',
          'transform transition-transform duration-200 ease-in-out',
          'lg:static lg:translate-x-0 lg:z-auto',
          open ? 'translate-x-0' : '-translate-x-full',
        ].join(' ')}
      >
        {/* Header */}
        <div className="flex items-center justify-between h-16 px-5 border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="h-7 w-7 rounded-lg bg-indigo-600 flex items-center justify-center">
              <span className="text-white font-bold text-xs">P</span>
            </div>
            <span className="font-semibold text-gray-900 text-sm">Propacity</span>
          </div>
          <button
            onClick={onClose}
            className="lg:hidden p-1 rounded-md text-gray-400 hover:text-gray-500 hover:bg-gray-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href || pathname.startsWith(item.href + '/');
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                className={[
                  'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  active
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
                ].join(' ')}
              >
                <Icon className={['h-4 w-4', active ? 'text-indigo-600' : 'text-gray-400'].join(' ')} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Bottom nav */}
        <div className="border-t border-gray-200 px-3 py-3 space-y-0.5 flex-shrink-0">
          {bottomItems.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                className={[
                  'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  active
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
                ].join(' ')}
              >
                <Icon className={['h-4 w-4', active ? 'text-indigo-600' : 'text-gray-400'].join(' ')} />
                {item.label}
              </Link>
            );
          })}
        </div>
      </aside>
    </>
  );
}
