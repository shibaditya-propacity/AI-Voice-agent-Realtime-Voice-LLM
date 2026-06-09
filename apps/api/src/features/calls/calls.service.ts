import { prisma } from '../../lib/prisma';

export async function getCallDetail(id: string) {
  const [log, conversations] = await Promise.all([
    prisma.callLog.findUnique({
      where: { id },
      include: { Lead: { select: { id: true, name: true, phone: true } } },
    }),
    prisma.$queryRaw<
      Array<{ id: string; role: string; content: string; language: string; createdAt: Date }>
    >`
      SELECT id, role::text, content, language, "createdAt"
      FROM "Conversation"
      WHERE "callLogId" = ${id}
      ORDER BY "createdAt" ASC
    `,
  ]);

  if (!log) return null;
  return { ...log, Conversation: conversations };
}

export async function getCallLogs(page = 1, limit = 20) {
  const skip = (page - 1) * limit;
  const [logs, total] = await Promise.all([
    prisma.callLog.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { Lead: { select: { id: true, name: true, phone: true } } },
    }),
    prisma.callLog.count(),
  ]);

  return {
    logs,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
  };
}

export async function getCallStats() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const [total, totalToday, durationAgg, missed] = await Promise.all([
    prisma.callLog.count(),
    prisma.callLog.count({ where: { createdAt: { gte: today, lt: tomorrow } } }),
    prisma.callLog.aggregate({ _avg: { duration: true } }),
    prisma.callLog.count({ where: { duration: 0 } }),
  ]);

  const avgSecs = Math.round(durationAgg._avg.duration ?? 0);
  const m = Math.floor(avgSecs / 60);
  const s = avgSecs % 60;

  return {
    total,
    totalToday,
    avgDuration: avgSecs > 0 ? (m > 0 ? `${m}m ${s}s` : `${s}s`) : '—',
    missed,
  };
}
