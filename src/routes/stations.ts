import { Router } from 'express';
import { stationController } from '../controllers/stationController';
import { stationSearchLimiter } from '../middleware/rateLimiter';

const router = Router();

router.get('/search', stationSearchLimiter, (req, res) => stationController.searchStations(req, res));
router.get('/nearby', stationSearchLimiter, (req, res) => stationController.getNearbyStations(req, res));

export default router;
