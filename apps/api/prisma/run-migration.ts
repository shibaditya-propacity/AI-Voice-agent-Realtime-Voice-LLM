import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter } as Parameters<typeof PrismaClient>[0]);

  const sql = fs.readFileSync(path.join(__dirname, 'migrations/add_call_center.sql'), 'utf8');

  // Split on statement boundaries and run each
  const statements = sql
    .replace(/--[^\n]*/g, '')        // strip line comments
    .split(/;\s*(?:\n|$)/)           // split on semicolons
    .map((s) => s.trim())
    .filter(Boolean);

  for (const stmt of statements) {
    console.log('Running:', stmt.slice(0, 60).replace(/\s+/g, ' '), '…');
    await prisma.$executeRawUnsafe(stmt);
  }

  console.log('\nMigration complete.');
  await prisma.$disconnect();
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
