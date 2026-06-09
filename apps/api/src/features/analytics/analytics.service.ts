import { prisma } from '../../lib/prisma';

export async function getAnalyticsOverview() {
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);

  const [
    totalCalls,
    qualifiedLeads,
    totalLeads,
    durationAgg,
    visitsCompleted,
    callsThisWeek,
    leadsThisWeek,
  ] = await Promise.all([
    prisma.callLog.count(),
    prisma.lead.count({ where: { leadScore: { gte: 50 } } }),
    prisma.lead.count(),
    prisma.callLog.aggregate({ _avg: { duration: true } }),
    prisma.siteVisit.count({ where: { status: 'COMPLETED' } }),
    prisma.callLog.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.lead.count({ where: { createdAt: { gte: weekAgo } } }),
  ]);

  const avgSecs = Math.round(durationAgg._avg.duration ?? 0);
  const m = Math.floor(avgSecs / 60);
  const s = avgSecs % 60;
  const avgHandleTime = avgSecs > 0 ? (m > 0 ? `${m}m ${s}s` : `${s}s`) : '—';

  const conversionRate =
    totalCalls > 0 ? `${((visitsCompleted / totalCalls) * 100).toFixed(1)}%` : '—';

  return {
    totalCalls,
    qualifiedLeads,
    totalLeads,
    avgHandleTime,
    visitsCompleted,
    conversionRate,
    callsThisWeek,
    leadsThisWeek,
  };
}
