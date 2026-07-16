"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const providerController_1 = require("../controllers/providerController");
const router = (0, express_1.Router)();
// Routes for Provider Management
router.get('/', providerController_1.getProviders);
router.post('/', providerController_1.createProvider);
router.put('/:id', providerController_1.updateProvider);
router.delete('/:id', providerController_1.deleteProvider);
exports.default = router;
