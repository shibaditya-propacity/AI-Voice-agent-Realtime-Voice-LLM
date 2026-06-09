import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.middleware';
import {
  handleListCampaigns,
  handleGetCampaign,
  handleCreateCampaign,
  handleUpdateCampaign,
  handleAddContacts,
  handleRemoveCampaignContact,
  handleDeleteCampaign,
} from './campaigns.controller';

export const campaignsRouter = Router();

campaignsRouter.get('/', requireAuth, handleListCampaigns);
campaignsRouter.post('/', requireAuth, handleCreateCampaign);
campaignsRouter.get('/:id', requireAuth, handleGetCampaign);
campaignsRouter.patch('/:id', requireAuth, handleUpdateCampaign);
campaignsRouter.delete('/:id', requireAuth, handleDeleteCampaign);
campaignsRouter.post('/:id/contacts', requireAuth, handleAddContacts);
campaignsRouter.delete('/:id/contacts/:contactId', requireAuth, handleRemoveCampaignContact);
