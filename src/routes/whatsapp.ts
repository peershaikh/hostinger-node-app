import { Router } from 'express';
import { whatsappWebhookController } from '../controllers/whatsappWebhookController';

/**
 * STEP 5.9C — WhatsApp Webhook Router Foundation
 * 
 * Exposes:
 * - GET  /webhook — Meta challenge verification
 * - POST /webhook — Meta webhook event ingestion (HMAC-SHA256 verified)
 */

const router = Router();

router.get('/webhook', whatsappWebhookController.verifyWebhook);
router.post('/webhook', whatsappWebhookController.handleWebhook);

export default router;
