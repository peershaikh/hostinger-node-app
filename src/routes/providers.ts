import { Router } from 'express';
import {
  getProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  removeProviderKey,
  testProvider,
  getProviderHistory,
  rollbackProviderConfig,
  batchUpdateProviders
} from '../controllers/providerController';

const router = Router();

// Routes for Provider Management
router.get('/', getProviders);
router.get('/history', getProviderHistory);
router.post('/test', testProvider);
router.post('/:id/test', testProvider);
router.post('/batch-update', batchUpdateProviders);
router.post('/rollback', rollbackProviderConfig);
router.post('/', createProvider);
router.put('/:id', updateProvider);
router.delete('/:id/key', removeProviderKey);
router.delete('/:id', deleteProvider);

export default router;
