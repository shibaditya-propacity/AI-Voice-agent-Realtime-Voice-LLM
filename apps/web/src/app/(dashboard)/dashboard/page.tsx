import { OverviewCards } from '@/features/dashboard/components/OverviewCards';
import { RecentActivity } from '@/features/dashboard/components/RecentActivity';

export default function DashboardPage() {
  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Dashboard</h1>
        <p className="mt-1 text-sm text-gray-500">
          Welcome back. Here&apos;s what&apos;s happening with your calls today.
        </p>
      </div>
      <OverviewCards />
      <RecentActivity />
    </div>
  );
}
