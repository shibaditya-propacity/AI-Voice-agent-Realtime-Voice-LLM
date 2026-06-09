import https from 'https';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../../../lib/prisma';
import { Env } from '../../../config/env';

interface CallJobRow {
  id: string; contactId: string; campaignId: string | null; callSid: string | null;
  status: string; provider: string; error: string | null;
  startedAt: Date | null; endedAt: Date | null; createdAt: Date; updatedAt: Date;
  contactName?: string; contactPhone?: string;
}

// ─── Call Triggering ──────────────────────────────────────────────────────────

export async function triggerSingleCall(contactId: string, campaignId?: string) {
  const contacts = await prisma.$queryRaw<Array<{ id: string; phone: string; name: string }>>`
    SELECT "id", "phone", "name" FROM "Contact" WHERE "id" = ${contactId}
  `;
  const contact = contacts[0];
  if (!contact) throw new Error('Contact not found');

  const jobId = uuidv4();
  const now = new Date();
  await prisma.$executeRaw`
    INSERT INTO "CallJob" ("id", "contactId", "campaignId", "status", "provider", "createdAt", "updatedAt")
    VALUES (${jobId}, ${contactId}, ${campaignId ?? null}, 'QUEUED', 'voice_server', ${now}, ${now})
  `;

  try {
    const callSid = await postOutboundCall(contact.phone, jobId);
    const dialingAt = new Date();
    await prisma.$executeRaw`
      UPDATE "CallJob"
      SET "callSid" = ${callSid}, "status" = 'DIALING', "startedAt" = ${dialingAt}, "updatedAt" = ${dialingAt}
      WHERE "id" = ${jobId}
    `;
    // Create an early CallLog entry so the call appears in the Calls page immediately
    const logId = uuidv4();
    await prisma.$executeRaw`
      INSERT INTO "CallLog" ("id", "callSid", "from", "direction", "status", "duration", "language", "createdAt")
      VALUES (${logId}, ${callSid}, ${contact.phone}, 'outbound', 'DIALING', 0, 'en', ${dialingAt})
      ON CONFLICT ("callSid") DO NOTHING
    `;
    const rows = await prisma.$queryRaw<CallJobRow[]>`
      SELECT cj.*, ct."name" AS "contactName", ct."phone" AS "contactPhone"
      FROM "CallJob" cj JOIN "Contact" ct ON ct."id" = cj."contactId"
      WHERE cj."id" = ${jobId}
    `;
    return rows[0];
  } catch (err) {
    const msg = (err as Error).message;
    await prisma.$executeRaw`
      UPDATE "CallJob"
      SET "status" = 'FAILED', "error" = ${msg}, "endedAt" = ${new Date()}, "updatedAt" = ${new Date()}
      WHERE "id" = ${jobId}
    `;
    if (campaignId) {
      await prisma.$executeRaw`
        UPDATE "Campaign"
        SET "failedCount" = "failedCount" + 1, "dialedCount" = "dialedCount" + 1, "updatedAt" = ${new Date()}
        WHERE "id" = ${campaignId}
      `;
      await prisma.$executeRaw`
        UPDATE "CampaignContact" SET "status" = 'FAILED'
        WHERE "campaignId" = ${campaignId} AND "contactId" = ${contactId}
      `;
    }
    throw err;
  }
}

function toE164(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.startsWith('+') ? phone : `+${digits}`;
}

async function postOutboundCall(phone: string, jobId: string): Promise<string> {
  const body = JSON.stringify({ to: toE164(phone), metadata: { jobId } });
  const url = new URL('/calls/outbound', Env.voiceServer.url);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  return new Promise<string>((resolve, reject) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(Env.voiceServer.internalSecret ? { 'x-internal-secret': Env.voiceServer.internalSecret } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Voice server returned ${res.statusCode}: ${data}`));
            return;
          }
          try {
            const parsed = JSON.parse(data) as { callSid?: string; callId?: string };
            const sid = parsed.callSid ?? parsed.callId;
            if (!sid) reject(new Error('Voice server did not return a callSid'));
            else resolve(sid);
          } catch {
            reject(new Error('Invalid JSON from voice server'));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Campaign Bulk Trigger ────────────────────────────────────────────────────

export async function startCampaign(campaignId: string) {
  const campaigns = await prisma.$queryRaw<Array<{ id: string; status: string }>>`
    SELECT "id", "status" FROM "Campaign" WHERE "id" = ${campaignId}
  `;
  if (!campaigns[0]) throw new Error('Campaign not found');
  if (campaigns[0].status === 'RUNNING') throw new Error('Campaign is already running');

  await prisma.$executeRaw`
    UPDATE "Campaign" SET "status" = 'RUNNING', "updatedAt" = ${new Date()} WHERE "id" = ${campaignId}
  `;
  setImmediate(() => runCampaignDialer(campaignId));
}

async function runCampaignDialer(campaignId: string) {
  for (;;) {
    const next = await prisma.$queryRaw<Array<{
      id: string; contactId: string; contactPhone: string; contactName: string;
    }>>`
      SELECT cc."id", cc."contactId", ct."phone" AS "contactPhone", ct."name" AS "contactName"
      FROM "CampaignContact" cc
      JOIN "Contact" ct ON ct."id" = cc."contactId"
      WHERE cc."campaignId" = ${campaignId} AND cc."status" = 'PENDING'
      ORDER BY cc."position" ASC LIMIT 1
    `;

    if (!next[0]) {
      await prisma.$executeRaw`
        UPDATE "Campaign" SET "status" = 'COMPLETED', "completedAt" = ${new Date()}, "updatedAt" = ${new Date()}
        WHERE "id" = ${campaignId}
      `;
      break;
    }

    const fresh = await prisma.$queryRaw<Array<{ status: string }>>`
      SELECT "status" FROM "Campaign" WHERE "id" = ${campaignId}
    `;
    if (!fresh[0] || fresh[0].status === 'PAUSED' || fresh[0].status === 'CANCELLED') break;

    await prisma.$executeRaw`
      UPDATE "CampaignContact" SET "status" = 'DIALING' WHERE "id" = ${next[0].id}
    `;

    try {
      await triggerSingleCall(next[0].contactId, campaignId);
      await prisma.$executeRaw`
        UPDATE "CampaignContact" SET "status" = 'ANSWERED' WHERE "id" = ${next[0].id}
      `;
      await prisma.$executeRaw`
        UPDATE "Campaign"
        SET "dialedCount" = "dialedCount" + 1, "answeredCount" = "answeredCount" + 1, "updatedAt" = ${new Date()}
        WHERE "id" = ${campaignId}
      `;
    } catch {
      await prisma.$executeRaw`
        UPDATE "CampaignContact" SET "status" = 'FAILED' WHERE "id" = ${next[0].id}
      `;
    }

    await sleep(500);
  }
}

// ─── Status Updates ───────────────────────────────────────────────────────────

export async function updateJobByCallSid(
  callSid: string,
  update: { status: string; endedAt?: Date; error?: string },
) {
  await prisma.$executeRaw`
    UPDATE "CallJob"
    SET "status" = ${update.status}::"CallJobStatus",
        "endedAt" = ${update.endedAt ?? new Date()},
        "error" = ${update.error ?? null},
        "updatedAt" = ${new Date()}
    WHERE "callSid" = ${callSid}
  `;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function listCallJobs(page = 1, limit = 20, campaignId?: string) {
  const skip = (page - 1) * limit;
  let jobs: CallJobRow[];
  let countResult: Array<{ count: bigint }>;

  if (campaignId) {
    jobs = await prisma.$queryRawUnsafe<CallJobRow[]>(
      `SELECT cj.*, ct."name" AS "contactName", ct."phone" AS "contactPhone"
       FROM "CallJob" cj JOIN "Contact" ct ON ct."id" = cj."contactId"
       WHERE cj."campaignId" = $1
       ORDER BY cj."createdAt" DESC LIMIT $2 OFFSET $3`,
      campaignId, limit, skip,
    );
    countResult = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM "CallJob" WHERE "campaignId" = $1`,
      campaignId,
    );
  } else {
    jobs = await prisma.$queryRawUnsafe<CallJobRow[]>(
      `SELECT cj.*, ct."name" AS "contactName", ct."phone" AS "contactPhone"
       FROM "CallJob" cj JOIN "Contact" ct ON ct."id" = cj."contactId"
       ORDER BY cj."createdAt" DESC LIMIT $1 OFFSET $2`,
      limit, skip,
    );
    countResult = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count FROM "CallJob"
    `;
  }

  const total = Number(countResult[0]?.count ?? 0);
  const mapped = jobs.map((j) => ({
    ...j,
    Contact: { id: j.contactId, name: j.contactName ?? '', phone: j.contactPhone ?? '' },
  }));

  return { jobs: mapped, total, page, pages: Math.ceil(total / limit) };
}

export async function getCallJobStats(campaignId?: string) {
  let rows: Array<{ status: string; count: bigint }>;
  if (campaignId) {
    rows = await prisma.$queryRawUnsafe<Array<{ status: string; count: bigint }>>(
      `SELECT "status", COUNT(*)::bigint AS count FROM "CallJob" WHERE "campaignId" = $1 GROUP BY "status"`,
      campaignId,
    );
  } else {
    rows = await prisma.$queryRaw<Array<{ status: string; count: bigint }>>`
      SELECT "status", COUNT(*)::bigint AS count FROM "CallJob" GROUP BY "status"
    `;
  }
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  return {
    total,
    queued: byStatus['QUEUED'] ?? 0,
    dialing: byStatus['DIALING'] ?? 0,
    completed: byStatus['COMPLETED'] ?? 0,
    failed: byStatus['FAILED'] ?? 0,
    cancelled: byStatus['CANCELLED'] ?? 0,
  };
}

export async function getCallCenterDashboardStats() {
  const [contacts, campaigns, jobs] = await Promise.all([
    prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "Contact"`,
    prisma.$queryRaw<Array<{ status: string; count: bigint }>>`SELECT "status", COUNT(*)::bigint AS count FROM "Campaign" GROUP BY "status"`,
    prisma.$queryRaw<Array<{ status: string; count: bigint }>>`SELECT "status", COUNT(*)::bigint AS count FROM "CallJob" GROUP BY "status"`,
  ]);

  const campaignByStatus = Object.fromEntries(campaigns.map((r) => [r.status, Number(r.count)]));
  const jobByStatus = Object.fromEntries(jobs.map((r) => [r.status, Number(r.count)]));
  const totalCampaigns = Object.values(campaignByStatus).reduce((a, b) => a + b, 0);
  const totalCallJobs = Object.values(jobByStatus).reduce((a, b) => a + b, 0);

  return {
    totalContacts: Number(contacts[0]?.count ?? 0),
    totalCampaigns,
    activeCampaigns: campaignByStatus['RUNNING'] ?? 0,
    totalCallJobs,
    completedCalls: jobByStatus['COMPLETED'] ?? 0,
    failedCalls: jobByStatus['FAILED'] ?? 0,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
