"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const trainController_1 = require("../controllers/trainController");
const rateLimiter_1 = require("../middleware/rateLimiter");
const usageMiddleware_1 = require("../middleware/usageMiddleware");
const router = (0, express_1.Router)();
// @route   GET/POST /api/trains/search
// @desc    Search for direct trains using the database
router.get('/search', rateLimiter_1.searchLimiter, (0, usageMiddleware_1.usageMiddleware)('search'), trainController_1.trainController.search);
router.post('/search', rateLimiter_1.searchLimiter, (0, usageMiddleware_1.usageMiddleware)('search'), trainController_1.trainController.search);
// @route   GET/POST /api/trains/searchAdvanced or /api/trains/search-advanced
// @desc    Advanced search for direct and split journeys using Supabase
router.get('/searchAdvanced', rateLimiter_1.advancedSearchLimiter, (0, usageMiddleware_1.usageMiddleware)('search'), trainController_1.trainController.searchAdvanced);
router.post('/searchAdvanced', rateLimiter_1.advancedSearchLimiter, (0, usageMiddleware_1.usageMiddleware)('search'), trainController_1.trainController.searchAdvanced);
router.get('/search-advanced', rateLimiter_1.advancedSearchLimiter, (0, usageMiddleware_1.usageMiddleware)('search'), trainController_1.trainController.searchAdvanced);
router.post('/search-advanced', rateLimiter_1.advancedSearchLimiter, (0, usageMiddleware_1.usageMiddleware)('search'), trainController_1.trainController.searchAdvanced);
// @route   GET /api/trains/live/:trainNo
// @desc    Get live status for a train using RapidAPI
router.get('/live/:trainNo', rateLimiter_1.liveLimiter, (0, usageMiddleware_1.usageMiddleware)('live'), trainController_1.trainController.getLiveStatus);
// @route   POST /api/complaints/add
router.post('/complaints/add', rateLimiter_1.complaintLimiter, trainController_1.trainController.addComplaint);
// @route   GET /api/complaints/train/:trainNo
router.get('/complaints/train/:trainNo', trainController_1.trainController.getComplaints);
// @route   GET /api/trains/availability
router.get('/availability', rateLimiter_1.availabilityLimiter, trainController_1.trainController.getAvailability);
// @route   POST /api/trains/same-train-rescue
// @desc    User-triggered Same Train Rescue — find hidden seats on the same train via segment splits
router.post('/same-train-rescue', rateLimiter_1.sameTrainRescueLimiter, trainController_1.trainController.sameTrainRescue);
// @route   GET /api/trains/rescue-book
// @desc    Redirect to IRCTC with click telemetry logging
router.get('/rescue-book', trainController_1.trainController.rescueBookRedirect);
// @route   GET /api/trains/metadata/:trainNo
// @desc    Return train name, days of operation, type, distance — enriches mobile results UI
router.get('/metadata/:trainNo', trainController_1.trainController.getTrainMetadata);
// @route   GET /api/trains/coaches/:trainNo
// @desc    Return coach composition for a train number
router.get('/coaches/:trainNo', trainController_1.trainController.getTrainCoaches);
// @route   GET /api/trains/delay-history/:trainNo
// @desc    Return historical delay patterns for a train number
router.get('/delay-history/:trainNo', trainController_1.trainController.getTrainDelayHistory);
exports.default = router;
