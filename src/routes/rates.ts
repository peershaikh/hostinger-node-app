import { Router } from 'express';
import { rateController } from '../controllers/rateController';

const router = Router();

router.get('/', rateController.listRates.bind(rateController));
router.post('/', rateController.createRateCard.bind(rateController));
router.delete('/:id', rateController.deleteRateCard.bind(rateController));

export default router;
