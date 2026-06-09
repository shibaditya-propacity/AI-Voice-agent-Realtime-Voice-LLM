import { Response, NextFunction } from 'express';
import type { AuthRequest } from '../../../middleware/auth.middleware';
import type { ApiResponse } from '@saas/types';
import {
  listCampaigns, getCampaign, createCampaign, updateCampaign,
  addContactsToCampaign, removeCampaignContact, deleteCampaign,
} from './campaigns.service';

export async function handleListCampaigns(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
    const data = await listCampaigns(page);
    res.json({ success: true, data } as ApiResponse);
  } catch (err) { next(err); }
}

export async function handleGetCampaign(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await getCampaign(String(req.params.id));
    if (!data) { res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Campaign not found' } }); return; }
    res.json({ success: true, data } as ApiResponse);
  } catch (err) { next(err); }
}

export async function handleCreateCampaign(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { name, description } = req.body as { name?: string; description?: string };
    if (!name) { res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'name is required' } }); return; }
    const data = await createCampaign({ name, description }, req.user!.id);
    res.status(201).json({ success: true, data } as ApiResponse);
  } catch (err) { next(err); }
}

export async function handleUpdateCampaign(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await updateCampaign(String(req.params.id), req.body);
    res.json({ success: true, data } as ApiResponse);
  } catch (err) { next(err); }
}

export async function handleAddContacts(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { contactIds } = req.body as { contactIds?: string[] };
    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'contactIds array is required' } });
      return;
    }
    const data = await addContactsToCampaign(String(req.params.id), contactIds);
    res.json({ success: true, data } as ApiResponse);
  } catch (err) { next(err); }
}

export async function handleRemoveCampaignContact(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    await removeCampaignContact(String(req.params.id), String(req.params.contactId));
    res.status(204).send();
  } catch (err) { next(err); }
}

export async function handleDeleteCampaign(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    await deleteCampaign(String(req.params.id));
    res.status(204).send();
  } catch (err) { next(err); }
}
