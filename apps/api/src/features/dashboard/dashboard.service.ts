import { prisma } from '../../lib/prisma';

function startOf(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function deltaPercent(current: number, previous: number): { delta: string; positive: boolean } {
  if (previous === 0 && current === 0) return { delta: '—', positive: true };
  if (previous === 0) return { delta: `+${current} new`, positive: true };
  const pct = Math.round(((current - previous) / previous) * 100);
  return { delta: `${pct >= 0 ? '+' : ''}${pct}%`, positive: pct >= 0 };
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function relativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} minute${mins > 1 ? 's' : ''} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days > 1 ? 's' : ''} ago`;
}

export async function getDashboardOverview() {
  const today = startOf(new Date());
  const tomorrow = addDays(today, 1);
  const yesterday = addDays(today, -1);
  const weekAgo = addDays(today, -7);
  const twoWeeksAgo = addDays(today, -14);

  const [
    callsToday,
    callsYesterday,
    visitsThisWeek,
    visitsLastWeek,
    durationAgg,
    totalLeads,
    newLeadsThisWeek,
    newLeadsLastWeek,
  ] = await Promise.all([
    prisma.callLog.count({ where: { createdAt: { gte: today, lt: tomorrow } } }),
    prisma.callLog.count({ where: { createdAt: { gte: yesterday, lt: today } } }),
    prisma.siteVisit.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.siteVisit.count({ where: { createdAt: { gte: twoWeeksAgo, lt: weekAgo } } }),
    prisma.callLog.aggregate({ _avg: { duration: true } }),
    prisma.lead.count(),
    prisma.lead.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.lead.count({ where: { createdAt: { gte: twoWeeksAgo, lt: weekAgo } } }),
  ]);

  const callsDelta = deltaPercent(callsToday, callsYesterday);
  const visitsDelta = deltaPercent(visitsThisWeek, visitsLastWeek);
  const leadsDelta = deltaPercent(newLeadsThisWeek, newLeadsLastWeek);
  const avgSecs = Math.round(durationAgg._avg.duration ?? 0);

  return {
    cards: [
      {
        id: 'total-calls',
        label: 'Total Calls Today',
        value: String(callsToday),
        delta: callsDelta.delta,
        deltaPositive: callsDelta.positive,
        description: 'vs. yesterday',
        color: 'indigo',
      },
      {
        id: 'site-visits',
        label: 'Site Visits Booked',
        value: String(visitsThisWeek),
        delta: visitsDelta.delta,
        deltaPositive: visitsDelta.positive,
        description: 'vs. last week',
        color: 'emerald',
      },
      {
        id: 'avg-duration',
        label: 'Avg Call Duration',
        value: formatDuration(avgSecs),
        delta: '—',
        deltaPositive: true,
        description: 'all-time average',
        color: 'amber',
      },
      {
        id: 'active-leads',
        label: 'Active Leads',
        value: String(totalLeads),
        delta: leadsDelta.delta,
        deltaPositive: leadsDelta.positive,
        description: 'new this week',
        color: 'violet',
      },
    ],
  };
}

export async function getRecentActivity() {
  const [callLogs, siteVisits] = await Promise.all([
    prisma.callLog.findMany({
      take: 15,
      orderBy: { createdAt: 'desc' },
      include: { Lead: { select: { name: true, phone: true } } },
    }),
    prisma.siteVisit.findMany({
      take: 15,
      orderBy: { createdAt: 'desc' },
      include: {
        Lead: { select: { name: true, phone: true } },
        Property: { select: { name: true } },
      },
    }),
  ]);

  type Item = {
    id: string;
    type: string;
    title: string;
    description: string;
    time: string;
    status: 'success' | 'warning' | 'neutral';
    _ts: number;
  };

  const activities: Item[] = [];

  for (const log of callLogs) {
    const caller = log.Lead?.name ?? log.from ?? 'Unknown caller';
    activities.push({
      id: `call-${log.id}`,
      type: 'call_completed',
      title: 'Call completed',
      description: `${caller} — ${log.summary ?? 'No summary available'}`,
      time: relativeTime(log.createdAt),
      status: log.summary ? 'success' : 'neutral',
      _ts: log.createdAt.getTime(),
    });
  }

  for (const visit of siteVisits) {
    const lead = visit.Lead?.name ?? 'Unknown lead';
    const property = visit.Property?.name ?? 'a property';
    const statusMap: Record<string, 'success' | 'warning' | 'neutral'> = {
      COMPLETED: 'success',
      CANCELLED: 'warning',
      SCHEDULED: 'neutral',
    };
    activities.push({
      id: `visit-${visit.id}`,
      type: 'visit_booked',
      title:
        visit.status === 'COMPLETED'
          ? 'Site visit completed'
          : visit.status === 'CANCELLED'
            ? 'Site visit cancelled'
            : 'Site visit scheduled',
      description: `${lead} — ${property}`,
      time: relativeTime(visit.createdAt),
      status: statusMap[visit.status] ?? 'neutral',
      _ts: visit.createdAt.getTime(),
    });
  }

  return activities
    .sort((a, b) => b._ts - a._ts)
    .slice(0, 10)
    .map(({ _ts: _, ...rest }) => rest);
}
