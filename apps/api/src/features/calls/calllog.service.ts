import { prisma } from '../../lib/prisma';
import { v4 as uuidv4 } from 'uuid';

export interface TranscriptTurn {
  role: 'USER' | 'ASSISTANT' | 'SYSTEM';
  content: string;
  language?: string;
  createdAt?: string; // ISO timestamp
}

export interface SaveCallLogInput {
  callSid: string;
  from?: string;
  to?: string;
  direction?: string;
  duration?: number;
  language?: string;
  summary?: string;
  recordingUrl?: string;
  transcript?: TranscriptTurn[];
}

/**
 * Called by the voice server after each call ends.
 * Upserts the CallLog and links it to a Lead if the caller phone matches.
 */
export async function saveCallLog(input: SaveCallLogInput) {
  const phone = input.from?.trim();

  // Try to find a matching lead by caller phone number
  let leadId: string | null = null;
  if (phone) {
    const lead = await prisma.lead.findFirst({
      where: {
        phone: {
          // Normalize: strip spaces/dashes, match suffix to handle +91 vs 91 vs 0 prefixes
          endsWith: phone.replace(/[\s\-\(\)]/g, '').slice(-10),
        },
      },
      select: { id: true },
    });
    leadId = lead?.id ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = await (prisma.callLog.upsert as any)({
    where: { callSid: input.callSid },
    create: {
      id: uuidv4(),
      callSid: input.callSid,
      leadId,
      from: input.from ?? null,
      to: input.to ?? null,
      direction: input.direction ?? 'inbound',
      duration: input.duration ?? 0,
      language: input.language ?? 'en',
      summary: input.summary ?? null,
      recordingUrl: input.recordingUrl ?? null,
    },
    update: {
      leadId: leadId ?? undefined,
      duration: input.duration ?? undefined,
      summary: input.summary ?? undefined,
      recordingUrl: input.recordingUrl ?? undefined,
    },
  }) as { id: string; callSid: string; [key: string]: unknown };

  // Save transcript turns linked to this specific call log (raw SQL — callLogId not in
  // generated client until prisma generate runs on Node 20+)
  if (input.transcript && input.transcript.length > 0 && leadId) {
    await prisma.$executeRaw`DELETE FROM "Conversation" WHERE "callLogId" = ${log.id}`;

    for (const turn of input.transcript) {
      const turnId = uuidv4();
      const lang = turn.language ?? input.language ?? 'en';
      const ts = turn.createdAt ? new Date(turn.createdAt) : new Date();
      await prisma.$executeRaw`
        INSERT INTO "Conversation" (id, "leadId", "callLogId", role, content, language, "createdAt")
        VALUES (${turnId}, ${leadId}, ${log.id}, ${turn.role}::"ConversationRole", ${turn.content}, ${lang}, ${ts})
      `;
    }
  }

  return log;
}
