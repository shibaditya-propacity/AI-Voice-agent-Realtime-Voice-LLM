import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../../../lib/prisma';

interface CampaignRow {
  id: string; name: string; description: string | null; status: string;
  totalContacts: number; dialedCount: number; answeredCount: number; failedCount: number;
  scheduledAt: Date | null; completedAt: Date | null; createdAt: Date; updatedAt: Date;
  createdById: string;
  createdByName?: string | null;
  campaignContactCount?: bigint;
  callJobCount?: bigint;
}

interface CampaignContactRow {
  id: string; campaignId: string; contactId: string; position: number; status: string; createdAt: Date;
  contactName: string; contactPhone: string; contactEmail: string | null; contactProject: string | null;
  contactSource: string; contactNotes: string | null; contactCreatedAt: Date;
}

export async function listCampaigns(page = 1, limit = 20) {
  const skip = (page - 1) * limit;
  const rows = await prisma.$queryRawUnsafe<CampaignRow[]>(
    `SELECT c.*,
            u."name" AS "createdByName",
            (SELECT COUNT(*) FROM "CampaignContact" cc WHERE cc."campaignId" = c."id")::int AS "campaignContactCount",
            (SELECT COUNT(*) FROM "CallJob" cj WHERE cj."campaignId" = c."id")::int AS "callJobCount"
     FROM "Campaign" c
     LEFT JOIN "User" u ON u."id" = c."createdById"
     ORDER BY c."createdAt" DESC LIMIT $1 OFFSET $2`,
    limit, skip,
  );
  const countResult = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "Campaign"`;
  const total = Number(countResult[0]?.count ?? 0);

  const campaigns = rows.map((r) => ({
    id: r.id, name: r.name, description: r.description, status: r.status,
    totalContacts: r.totalContacts, dialedCount: r.dialedCount,
    answeredCount: r.answeredCount, failedCount: r.failedCount,
    scheduledAt: r.scheduledAt, completedAt: r.completedAt,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
    CreatedBy: { id: r.createdById, name: r.createdByName ?? null },
    _count: {
      CampaignContacts: Number(r.campaignContactCount ?? 0),
      CallJobs: Number(r.callJobCount ?? 0),
    },
  }));

  return { campaigns, total, page, pages: Math.ceil(total / limit) };
}

export async function getCampaign(id: string) {
  const campaigns = await prisma.$queryRaw<CampaignRow[]>`
    SELECT c.*, u."name" AS "createdByName"
    FROM "Campaign" c
    LEFT JOIN "User" u ON u."id" = c."createdById"
    WHERE c."id" = ${id}
  `;
  if (!campaigns[0]) return null;
  const c = campaigns[0];

  const contacts = await prisma.$queryRaw<CampaignContactRow[]>`
    SELECT cc."id", cc."campaignId", cc."contactId", cc."position", cc."status", cc."createdAt",
           ct."name" AS "contactName", ct."phone" AS "contactPhone", ct."email" AS "contactEmail",
           ct."project" AS "contactProject", ct."source" AS "contactSource",
           ct."notes" AS "contactNotes", ct."createdAt" AS "contactCreatedAt"
    FROM "CampaignContact" cc
    JOIN "Contact" ct ON ct."id" = cc."contactId"
    WHERE cc."campaignId" = ${id}
    ORDER BY cc."position" ASC
  `;

  return {
    id: c.id, name: c.name, description: c.description, status: c.status,
    totalContacts: c.totalContacts, dialedCount: c.dialedCount,
    answeredCount: c.answeredCount, failedCount: c.failedCount,
    scheduledAt: c.scheduledAt, completedAt: c.completedAt,
    createdAt: c.createdAt, updatedAt: c.updatedAt,
    CreatedBy: { id: c.createdById, name: c.createdByName ?? null },
    CampaignContacts: contacts.map((cc) => ({
      id: cc.id, campaignId: cc.campaignId, contactId: cc.contactId,
      position: cc.position, status: cc.status, createdAt: cc.createdAt,
      Contact: {
        id: cc.contactId, name: cc.contactName, phone: cc.contactPhone,
        email: cc.contactEmail, project: cc.contactProject,
        source: cc.contactSource, notes: cc.contactNotes, createdAt: cc.contactCreatedAt,
      },
    })),
  };
}

export async function createCampaign(input: { name: string; description?: string }, userId: string) {
  const id = uuidv4();
  const now = new Date();
  await prisma.$executeRaw`
    INSERT INTO "Campaign" ("id", "name", "description", "createdById", "createdAt", "updatedAt")
    VALUES (${id}, ${input.name.trim()}, ${input.description?.trim() || null}, ${userId}, ${now}, ${now})
  `;
  const rows = await prisma.$queryRaw<CampaignRow[]>`SELECT * FROM "Campaign" WHERE "id" = ${id}`;
  return rows[0];
}

export async function updateCampaign(id: string, input: { name?: string; description?: string; status?: string }) {
  const now = new Date();
  if (input.name !== undefined) {
    await prisma.$executeRawUnsafe(
      `UPDATE "Campaign" SET "name" = $1, "updatedAt" = $2 WHERE "id" = $3`,
      input.name.trim(), now, id,
    );
  }
  if (input.description !== undefined) {
    await prisma.$executeRawUnsafe(
      `UPDATE "Campaign" SET "description" = $1, "updatedAt" = $2 WHERE "id" = $3`,
      input.description?.trim() || null, now, id,
    );
  }
  if (input.status !== undefined) {
    await prisma.$executeRawUnsafe(
      `UPDATE "Campaign" SET "status" = $1::"CampaignStatus", "updatedAt" = $2 WHERE "id" = $3`,
      input.status, now, id,
    );
  }
  const rows = await prisma.$queryRaw<CampaignRow[]>`SELECT * FROM "Campaign" WHERE "id" = ${id}`;
  return rows[0];
}

export async function addContactsToCampaign(campaignId: string, contactIds: string[]) {
  const existing = await prisma.$queryRaw<Array<{ contactId: string; position: number }>>`
    SELECT "contactId", "position" FROM "CampaignContact"
    WHERE "campaignId" = ${campaignId}
    ORDER BY "position" DESC
  `;
  const existingSet = new Set(existing.map((e) => e.contactId));
  const maxPosition = existing[0]?.position ?? 0;
  const newIds = contactIds.filter((id) => !existingSet.has(id));

  if (newIds.length === 0) return { added: 0 };

  const now = new Date();
  for (let i = 0; i < newIds.length; i++) {
    const ccId = uuidv4();
    await prisma.$executeRaw`
      INSERT INTO "CampaignContact" ("id", "campaignId", "contactId", "position", "status", "createdAt")
      VALUES (${ccId}, ${campaignId}, ${newIds[i]}, ${maxPosition + i + 1}, 'PENDING', ${now})
      ON CONFLICT ("campaignId", "contactId") DO NOTHING
    `;
  }
  await prisma.$executeRaw`
    UPDATE "Campaign" SET "totalContacts" = "totalContacts" + ${newIds.length}, "updatedAt" = ${now}
    WHERE "id" = ${campaignId}
  `;
  return { added: newIds.length };
}

export async function removeCampaignContact(campaignId: string, contactId: string) {
  await prisma.$executeRaw`
    DELETE FROM "CampaignContact" WHERE "campaignId" = ${campaignId} AND "contactId" = ${contactId}
  `;
  await prisma.$executeRaw`
    UPDATE "Campaign" SET "totalContacts" = GREATEST(0, "totalContacts" - 1), "updatedAt" = ${new Date()}
    WHERE "id" = ${campaignId}
  `;
}

export async function deleteCampaign(id: string) {
  await prisma.$executeRaw`DELETE FROM "Campaign" WHERE "id" = ${id}`;
}
