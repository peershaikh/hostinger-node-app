"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const stationController_1 = require("../controllers/stationController");
const router = (0, express_1.Router)();
router.get('/search', (req, res) => stationController_1.stationController.searchStations(req, res));
exports.default = router;
