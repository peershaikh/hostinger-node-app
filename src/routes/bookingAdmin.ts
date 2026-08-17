import { Router } from 'express';
import { bookingAdminController } from '../controllers/bookingAdminController';
import { requireAuth } from '../middleware/authMiddleware';
import { requireAdmin } from '../middleware/adminAuth';

const router = Router();

// Apply requireAdmin to all booking admin routes
router.use(requireAdmin);

router.get('/providers', bookingAdminController.getBookingProviders);
router.post('/providers/update', bookingAdminController.updateBookingProviders);
router.post('/providers/test', bookingAdminController.testBookingProvider);
router.get('/history', bookingAdminController.getBookingAuditHistory);
router.post('/rollback', bookingAdminController.rollbackBooking);

export default router;
