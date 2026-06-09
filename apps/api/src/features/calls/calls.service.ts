import https from 'https';
import http from 'http';
import { prisma } from '../../lib/prisma';
import { Env } from '../../config/env';

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
  const [rows, conversations, jobRows] = await Promise.all([
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
    // Fetch linked CallJob + Campaign for the call's callSid
    prisma.$queryRaw<Array<{
      jobId: string; jobStatus: string; startedAt: Date | null; endedAt: Date | null;
      campaignId: string | null; campaignName: string | null;
      contactId: string | null; contactName: string | null; contactPhone: string | null;
    }>>`
      SELECT cj.id AS "jobId", cj.status AS "jobStatus",
             cj."startedAt", cj."endedAt",
             cj."campaignId", camp.name AS "campaignName",
             cj."contactId", ct.name AS "contactName", ct.phone AS "contactPhone"
      FROM "CallLog" cl
      LEFT JOIN "CallJob" cj ON cj."callSid" = cl."callSid"
      LEFT JOIN "Campaign" camp ON camp.id = cj."campaignId"
      LEFT JOIN "Contact" ct ON ct.id = cj."contactId"
      WHERE cl.id = ${id}
      LIMIT 1
    `,
  ]);

  if (!rows[0]) return null;

  const job = jobRows[0] ?? null;
  const shaped = shapeLog(rows[0]);

  return {
    ...shaped,
    callSid: rows[0].callSid,
    startedAt: job?.startedAt ? (job.startedAt instanceof Date ? job.startedAt.toISOString() : String(job.startedAt)) : shaped.createdAt,
    endedAt: job?.endedAt ? (job.endedAt instanceof Date ? job.endedAt.toISOString() : String(job.endedAt)) : null,
    campaign: job?.campaignId ? { id: job.campaignId, name: job.campaignName } : null,
    contact: job?.contactId ? { id: job.contactId, name: job.contactName, phone: job.contactPhone } : null,
    Conversation: conversations,
  };
}

export async function getCallEvents(callSid: string): Promise<unknown[]> {
  const url = new URL(`/calls/${encodeURIComponent(callSid)}/events`, Env.voiceServer.url);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  return new Promise((resolve) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'GET',
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as { events?: unknown[] };
            resolve(parsed.events ?? []);
          } catch {
            resolve([]);
          }
        });
      },
    );
    req.on('error', () => resolve([]));
    req.end();
  });
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
