"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const rateController_1 = require("../controllers/rateController");
const router = (0, express_1.Router)();
router.get('/', rateController_1.rateController.listRates.bind(rateController_1.rateController));
router.post('/', rateController_1.rateController.createRateCard.bind(rateController_1.rateController));
router.delete('/:id', rateController_1.rateController.deleteRateCard.bind(rateController_1.rateController));
exports.default = router;
