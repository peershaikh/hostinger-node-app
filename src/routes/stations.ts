import { Router } from 'express';
import { stationController } from '../controllers/stationController';

const router = Router();

router.get('/search', (req, res) => stationController.searchStations(req, res));

export default router;
