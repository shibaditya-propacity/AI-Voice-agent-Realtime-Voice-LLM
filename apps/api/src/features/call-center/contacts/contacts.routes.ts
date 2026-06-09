import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.middleware';
import {
  handleListContacts,
  handleGetContact,
  handleCreateContact,
  handleImportContacts,
  handleDeleteContact,
} from './contacts.controller';

export const contactsRouter = Router();

contactsRouter.get('/', requireAuth, handleListContacts);
contactsRouter.post('/', requireAuth, handleCreateContact);
contactsRouter.post('/import', requireAuth, handleImportContacts);
contactsRouter.get('/:id', requireAuth, handleGetContact);
contactsRouter.delete('/:id', requireAuth, handleDeleteContact);
