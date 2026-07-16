import { Router } from 'express';
import { inviteController } from '../controllers/inviteController';

const router = Router();

// Stats & Codes
router.get('/stats/:sessionId', inviteController.getStats.bind(inviteController));

// Claiming
router.post('/claim', inviteController.claim.bind(inviteController));

export default router;
