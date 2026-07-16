import { Router } from 'express';
import { getProviders, createProvider, updateProvider, deleteProvider } from '../controllers/providerController';

const router = Router();

// Routes for Provider Management
router.get('/', getProviders);
router.post('/', createProvider);
router.put('/:id', updateProvider);
router.delete('/:id', deleteProvider);

export default router;
