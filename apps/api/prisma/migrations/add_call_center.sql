-- Call Center: Contact, Campaign, CampaignContact, CallJob tables

DO $$ BEGIN
  CREATE TYPE "ContactSource" AS ENUM ('MANUAL', 'CSV_IMPORT', 'EXCEL_IMPORT');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "CampaignContactStatus" AS ENUM ('PENDING', 'DIALING', 'ANSWERED', 'NO_ANSWER', 'FAILED', 'SKIPPED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "CallJobStatus" AS ENUM ('QUEUED', 'DIALING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "Contact" (
  "id"        TEXT        NOT NULL,
  "name"      TEXT        NOT NULL,
  "phone"     TEXT        NOT NULL,
  "email"     TEXT,
  "project"   TEXT,
  "notes"     TEXT,
  "source"    "ContactSource" NOT NULL DEFAULT 'MANUAL',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "Contact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Contact_phone_key" UNIQUE ("phone")
);

CREATE TABLE IF NOT EXISTS "Campaign" (
  "id"             TEXT            NOT NULL,
  "name"           TEXT            NOT NULL,
  "description"    TEXT,
  "status"         "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "totalContacts"  INTEGER         NOT NULL DEFAULT 0,
  "dialedCount"    INTEGER         NOT NULL DEFAULT 0,
  "answeredCount"  INTEGER         NOT NULL DEFAULT 0,
  "failedCount"    INTEGER         NOT NULL DEFAULT 0,
  "scheduledAt"    TIMESTAMPTZ,
  "completedAt"    TIMESTAMPTZ,
  "createdAt"      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  "updatedAt"      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  "createdById"    TEXT            NOT NULL,
  CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Campaign_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "CampaignContact" (
  "id"         TEXT                    NOT NULL,
  "campaignId" TEXT                    NOT NULL,
  "contactId"  TEXT                    NOT NULL,
  "position"   INTEGER                 NOT NULL DEFAULT 0,
  "status"     "CampaignContactStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt"  TIMESTAMPTZ             NOT NULL DEFAULT NOW(),
  CONSTRAINT "CampaignContact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CampaignContact_campaignId_contactId_key" UNIQUE ("campaignId", "contactId"),
  CONSTRAINT "CampaignContact_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CampaignContact_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "CampaignContact_campaignId_status_idx"
  ON "CampaignContact"("campaignId", "status");

CREATE TABLE IF NOT EXISTS "CallJob" (
  "id"         TEXT           NOT NULL,
  "contactId"  TEXT           NOT NULL,
  "campaignId" TEXT,
  "callSid"    TEXT,
  "status"     "CallJobStatus" NOT NULL DEFAULT 'QUEUED',
  "provider"   TEXT           NOT NULL DEFAULT 'voice_server',
  "error"      TEXT,
  "startedAt"  TIMESTAMPTZ,
  "endedAt"    TIMESTAMPTZ,
  "createdAt"  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  "updatedAt"  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  CONSTRAINT "CallJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CallJob_callSid_key" UNIQUE ("callSid"),
  CONSTRAINT "CallJob_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CallJob_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "CallJob_campaignId_status_idx" ON "CallJob"("campaignId", "status");
CREATE INDEX IF NOT EXISTS "CallJob_status_createdAt_idx" ON "CallJob"("status", "createdAt");
