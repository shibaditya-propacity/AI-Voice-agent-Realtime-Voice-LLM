import { prisma } from '../../lib/prisma';

interface CallLogRow {
  id: string;
  callSid: string;
  leadId: string | null;
  from: string | null;
  to: string | null;
  direction: string;
  duration: number;
  language: string;
  summary: string | null;
  recordingUrl: string | null;
  status: string;
  createdAt: Date;
  leadName: string | null;
  leadPhone: string | null;
}

function shapeLog(row: CallLogRow) {
  return {
    id: row.id,
    callSid: row.callSid,
    from: row.from,
    to: row.to,
    direction: row.direction,
    duration: Number(row.duration),
    language: row.language,
    summary: row.summary,
    recordingUrl: row.recordingUrl,
    status: row.status,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    Lead: row.leadId ? { id: row.leadId, name: row.leadName, phone: row.leadPhone } : null,
  };
}

export async function getCallDetail(id: string) {
  const [rows, conversations] = await Promise.all([
    prisma.$queryRaw<CallLogRow[]>`
      SELECT cl.id, cl."callSid", cl."leadId", cl."from", cl."to", cl.direction,
             cl.duration, cl.language, cl.summary, cl."recordingUrl",
             COALESCE(cl.status, 'COMPLETED') AS status, cl."createdAt",
             l.name AS "leadName", l.phone AS "leadPhone"
      FROM "CallLog" cl
      LEFT JOIN "Lead" l ON l.id = cl."leadId"
      WHERE cl.id = ${id}
    `,
    prisma.$queryRaw<
      Array<{ id: string; role: string; content: string; language: string; createdAt: Date }>
    >`
      SELECT id, role::text, content, language, "createdAt"
      FROM "Conversation"
      WHERE "callLogId" = ${id}
      ORDER BY "createdAt" ASC
    `,
  ]);

  if (!rows[0]) return null;
  return { ...shapeLog(rows[0]), Conversation: conversations };
}

export async function getCallLogs(page = 1, limit = 20) {
  const offset = (page - 1) * limit;
  const [rows, countRows] = await Promise.all([
    prisma.$queryRaw<CallLogRow[]>`
      SELECT cl.id, cl."callSid", cl."leadId", cl."from", cl."to", cl.direction,
             cl.duration, cl.language, cl.summary, cl."recordingUrl",
             COALESCE(cl.status, 'COMPLETED') AS status, cl."createdAt",
             l.name AS "leadName", l.phone AS "leadPhone"
      FROM "CallLog" cl
      LEFT JOIN "Lead" l ON l.id = cl."leadId"
      ORDER BY cl."createdAt" DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
    prisma.$queryRaw<[{ count: bigint }]>`SELECT COUNT(*)::bigint AS count FROM "CallLog"`,
  ]);

  const total = Number(countRows[0]?.count ?? 0);
  return {
    logs: rows.map(shapeLog),
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
