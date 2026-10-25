import { Router } from 'express';
import { setupController } from '../controllers/setup.controller.js';
import { setupRateLimiter } from '../middleware/rate-limit.middleware.js';

const router = Router();

router.get('/status', setupController.getStatus.bind(setupController));
router.post('/', setupRateLimiter, setupController.completeSetup.bind(setupController));
router.get('/backup-codes/count', setupController.getBackupCodesCount.bind(setupController));
router.post(
  '/backup-codes/regenerate',
  setupRateLimiter,
  setupController.regenerateBackupCodes.bind(setupController)
);
router.post(
  '/reset-password',
  setupRateLimiter,
  setupController.resetPasswordWithBackupCode.bind(setupController)
);

export default router;
