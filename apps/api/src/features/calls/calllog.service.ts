import { prisma } from '../../lib/prisma';
import { v4 as uuidv4 } from 'uuid';
import { updateJobByCallSid } from '../call-center/call-jobs/call-jobs.service';

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
      status: 'COMPLETED',
    },
    update: {
      leadId: leadId ?? undefined,
      duration: input.duration ?? undefined,
      summary: input.summary ?? undefined,
      recordingUrl: input.recordingUrl ?? undefined,
      status: 'COMPLETED',
    },
  }) as { id: string; callSid: string; [key: string]: unknown };

  // Save transcript turns — always, regardless of whether a Lead matched
  if (input.transcript && input.transcript.length > 0) {
    await prisma.$executeRaw`DELETE FROM "Conversation" WHERE "callLogId" = ${log.id}`;

    for (const turn of input.transcript) {
      if (turn.role === 'SYSTEM') continue;
      const turnId = uuidv4();
      const lang = turn.language ?? input.language ?? 'en';
      const ts = turn.createdAt ? new Date(turn.createdAt) : new Date();
      // leadId is nullable — insert NULL when no matching Lead
      await prisma.$executeRaw`
        INSERT INTO "Conversation" (id, "leadId", "callLogId", role, content, language, "createdAt")
        VALUES (${turnId}, ${leadId}, ${log.id}, ${turn.role}::"ConversationRole", ${turn.content}, ${lang}, ${ts})
      `;
    }
  }

  // Update any matching CallJob (outbound call center calls)
  await updateJobByCallSid(input.callSid, {
    status: 'COMPLETED',
    endedAt: new Date(),
  }).catch(() => { /* job may not exist for inbound calls */ });

  return log;
}
