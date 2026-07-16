import { Router } from 'express';
import { trainController } from '../controllers/trainController';
import { complaintLimiter, liveLimiter, searchLimiter, advancedSearchLimiter, availabilityLimiter, sameTrainRescueLimiter } from '../middleware/rateLimiter';
import { usageMiddleware } from '../middleware/usageMiddleware';

const router = Router();

// @route   GET/POST /api/trains/search
// @desc    Search for direct trains using the database
router.get('/search', searchLimiter, usageMiddleware('search'), trainController.search);
router.post('/search', searchLimiter, usageMiddleware('search'), trainController.search);

// @route   GET/POST /api/trains/searchAdvanced or /api/trains/search-advanced
// @desc    Advanced search for direct and split journeys using Supabase
router.get('/searchAdvanced', advancedSearchLimiter, usageMiddleware('search'), trainController.searchAdvanced);
router.post('/searchAdvanced', advancedSearchLimiter, usageMiddleware('search'), trainController.searchAdvanced);
router.get('/search-advanced', advancedSearchLimiter, usageMiddleware('search'), trainController.searchAdvanced);
router.post('/search-advanced', advancedSearchLimiter, usageMiddleware('search'), trainController.searchAdvanced);

// @route   GET /api/trains/live/:trainNo
// @desc    Get live status for a train using RapidAPI
router.get('/live/:trainNo', liveLimiter, usageMiddleware('live'), trainController.getLiveStatus);

// @route   POST /api/complaints/add
router.post('/complaints/add', complaintLimiter, trainController.addComplaint);

// @route   GET /api/complaints/train/:trainNo
router.get('/complaints/train/:trainNo', trainController.getComplaints);

// @route   GET /api/trains/availability
router.get('/availability', availabilityLimiter, trainController.getAvailability);

// @route   POST /api/trains/same-train-rescue
// @desc    User-triggered Same Train Rescue — find hidden seats on the same train via segment splits
router.post('/same-train-rescue', sameTrainRescueLimiter, trainController.sameTrainRescue);

// @route   GET /api/trains/rescue-book
// @desc    Redirect to IRCTC with click telemetry logging
router.get('/rescue-book', trainController.rescueBookRedirect);

// @route   GET /api/trains/metadata/:trainNo
// @desc    Return train name, days of operation, type, distance — enriches mobile results UI
router.get('/metadata/:trainNo', trainController.getTrainMetadata);

// @route   GET /api/trains/coaches/:trainNo
// @desc    Return coach composition for a train number
router.get('/coaches/:trainNo', trainController.getTrainCoaches);

// @route   GET /api/trains/delay-history/:trainNo
// @desc    Return historical delay patterns for a train number
router.get('/delay-history/:trainNo', trainController.getTrainDelayHistory);

export default router;

