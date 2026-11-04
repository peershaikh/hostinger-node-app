"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const stationController_1 = require("../controllers/stationController");
const rateLimiter_1 = require("../middleware/rateLimiter");
const router = (0, express_1.Router)();
router.get('/search', rateLimiter_1.stationSearchLimiter, (req, res) => stationController_1.stationController.searchStations(req, res));
router.get('/nearby', rateLimiter_1.stationSearchLimiter, (req, res) => stationController_1.stationController.getNearbyStations(req, res));
exports.default = router;
