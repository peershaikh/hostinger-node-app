"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const whatsappWebhookController_1 = require("../controllers/whatsappWebhookController");
/**
 * STEP 5.9C — WhatsApp Webhook Router Foundation
 *
 * Exposes:
 * - GET  /webhook — Meta challenge verification
 * - POST /webhook — Meta webhook event ingestion (HMAC-SHA256 verified)
 */
const router = (0, express_1.Router)();
router.get('/webhook', whatsappWebhookController_1.whatsappWebhookController.verifyWebhook);
router.post('/webhook', whatsappWebhookController_1.whatsappWebhookController.handleWebhook);
exports.default = router;
