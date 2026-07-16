import { Router } from 'express';
import {
  createAlarm,
  getAlarms,
  updateAlarm,
  deleteAlarm
} from '../controllers/alarmController';
import { alarmLimiter } from '../middleware/rateLimiter';

const router = Router();

// Apply rate limiting to creation and modification to prevent abuse
router.post('/', alarmLimiter, createAlarm);
router.get('/', getAlarms);
router.patch('/:id', alarmLimiter, updateAlarm);
router.delete('/:id', alarmLimiter, deleteAlarm);

export default router;
