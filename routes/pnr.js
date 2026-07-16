"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const pnrController_1 = require("../controllers/pnrController");
const authMiddleware_1 = require("../middleware/authMiddleware");
const rateLimiter_1 = require("../middleware/rateLimiter");
const usageMiddleware_1 = require("../middleware/usageMiddleware");
const router = (0, express_1.Router)();
// @route   GET /api/pnr/status/:pnr or /api/pnr/predict/:pnr
// @desc    Get PNR status + AI prediction
router.get('/:pnr', rateLimiter_1.pnrLimiter, (0, usageMiddleware_1.usageMiddleware)('pnr'), pnrController_1.pnrController.getStatus);
router.get('/predict/:pnr', rateLimiter_1.pnrLimiter, (0, usageMiddleware_1.usageMiddleware)('pnr'), pnrController_1.pnrController.getStatus);
router.post('/track', rateLimiter_1.pnrLimiter, pnrController_1.pnrController.track);
router.post('/upgrade/:pnr', authMiddleware_1.requireAuth, pnrController_1.pnrController.upgrade);
router.get('/list/:sessionId', pnrController_1.pnrController.listTracked);
router.delete('/untrack/:pnr/:sessionId', pnrController_1.pnrController.untrack);
exports.default = router;
