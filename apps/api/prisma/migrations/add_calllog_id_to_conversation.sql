-- Add callLogId to Conversation and back-relation column on CallLog
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "callLogId" TEXT;

ALTER TABLE "Conversation"
  ADD CONSTRAINT IF NOT EXISTS "Conversation_callLogId_fkey"
  FOREIGN KEY ("callLogId")
  REFERENCES "CallLog"("id")
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "Conversation_callLogId_idx" ON "Conversation"("callLogId");
