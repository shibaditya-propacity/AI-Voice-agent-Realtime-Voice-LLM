import { Response, NextFunction } from 'express';
import type { AuthRequest } from '../../../middleware/auth.middleware';
import type { ApiResponse } from '@saas/types';
import { listContacts, getContact, createContact, importContacts, deleteContact } from './contacts.service';

export async function handleListContacts(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10)));
    const search = req.query.search ? String(req.query.search) : undefined;
    const data = await listContacts(page, limit, search);
    res.json({ success: true, data } as ApiResponse);
  } catch (err) { next(err); }
}

export async function handleGetContact(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await getContact(String(req.params.id));
    if (!data) { res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Contact not found' } }); return; }
    res.json({ success: true, data } as ApiResponse);
  } catch (err) { next(err); }
}

export async function handleCreateContact(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { name, phone, email, project, notes } = req.body as { name?: string; phone?: string; email?: string; project?: string; notes?: string };
    if (!name || !phone) { res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'name and phone are required' } }); return; }
    const data = await createContact({ name, phone, email, project, notes });
    res.status(201).json({ success: true, data } as ApiResponse);
  } catch (err: unknown) {
    if (err instanceof Error && err.message?.includes('Unique constraint')) {
      res.status(409).json({ success: false, error: { code: 'DUPLICATE', message: 'A contact with this phone number already exists' } });
      return;
    }
    next(err);
  }
}

export async function handleImportContacts(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { rows } = req.body as { rows?: unknown[] };
    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'rows array is required' } });
      return;
    }
    const data = await importContacts(rows as Parameters<typeof importContacts>[0]);
    res.json({ success: true, data } as ApiResponse);
  } catch (err) { next(err); }
}

export async function handleDeleteContact(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    await deleteContact(String(req.params.id));
    res.status(204).send();
  } catch (err) { next(err); }
}
