import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../../../lib/prisma';

export interface ContactRow {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  project: string | null;
  notes: string | null;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

export async function listContacts(page = 1, limit = 20, search?: string) {
  const skip = (page - 1) * limit;

  let contacts: ContactRow[];
  let countResult: Array<{ count: bigint }>;

  if (search) {
    const pattern = `%${search.replace(/%/g, '\\%')}%`;
    contacts = await prisma.$queryRawUnsafe<ContactRow[]>(
      `SELECT * FROM "Contact"
       WHERE "name" ILIKE $1 OR "phone" LIKE $2 OR "email" ILIKE $3
       ORDER BY "createdAt" DESC LIMIT $4 OFFSET $5`,
      pattern, pattern, pattern, limit, skip,
    );
    countResult = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM "Contact"
       WHERE "name" ILIKE $1 OR "phone" LIKE $2 OR "email" ILIKE $3`,
      pattern, pattern, pattern,
    );
  } else {
    contacts = await prisma.$queryRawUnsafe<ContactRow[]>(
      `SELECT * FROM "Contact" ORDER BY "createdAt" DESC LIMIT $1 OFFSET $2`,
      limit, skip,
    );
    countResult = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM "Contact"`,
    );
  }

  const total = Number(countResult[0]?.count ?? 0);
  return { contacts, total, page, pages: Math.ceil(total / limit) };
}

export async function getContact(id: string) {
  const rows = await prisma.$queryRaw<ContactRow[]>`
    SELECT * FROM "Contact" WHERE "id" = ${id}
  `;
  return rows[0] ?? null;
}

export async function createContact(input: {
  name: string;
  phone: string;
  email?: string;
  project?: string;
  notes?: string;
}) {
  const id = uuidv4();
  const phone = normalizePhone(input.phone);
  const now = new Date();
  await prisma.$executeRaw`
    INSERT INTO "Contact" ("id", "name", "phone", "email", "project", "notes", "source", "createdAt", "updatedAt")
    VALUES (
      ${id}, ${input.name.trim()}, ${phone},
      ${input.email?.trim() || null}, ${input.project?.trim() || null},
      ${input.notes?.trim() || null}, 'MANUAL', ${now}, ${now}
    )
  `;
  const rows = await prisma.$queryRaw<ContactRow[]>`SELECT * FROM "Contact" WHERE "id" = ${id}`;
  return rows[0];
}

export async function importContacts(
  rows: Array<{ name?: string; phone?: string; email?: string; project?: string; notes?: string }>,
) {
  let imported = 0;
  const errors: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const phone = normalizePhone(row.phone ?? '');

    if (!phone || phone.length < 7) {
      errors.push(`Row ${i + 1}: invalid phone "${row.phone ?? ''}"`);
      continue;
    }
    if (!row.name?.trim()) {
      errors.push(`Row ${i + 1}: name is required`);
      continue;
    }

    try {
      const id = uuidv4();
      const now = new Date();
      await prisma.$executeRaw`
        INSERT INTO "Contact" ("id", "name", "phone", "email", "project", "notes", "source", "createdAt", "updatedAt")
        VALUES (
          ${id}, ${row.name.trim()}, ${phone},
          ${row.email?.trim() || null}, ${row.project?.trim() || null},
          ${null}, 'CSV_IMPORT', ${now}, ${now}
        )
        ON CONFLICT ("phone") DO NOTHING
      `;
      imported++;
    } catch (err) {
      errors.push(`Row ${i + 1}: ${(err as Error).message}`);
    }
  }

  return { imported, errors };
}

export async function deleteContact(id: string) {
  await prisma.$executeRaw`DELETE FROM "Contact" WHERE "id" = ${id}`;
}

function normalizePhone(raw: string): string {
  return raw.replace(/[\s\-\(\)\+]/g, '');
}
