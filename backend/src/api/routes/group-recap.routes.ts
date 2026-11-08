import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { groupRecapController } from '../controllers/group-recap.controller.js';

const router = Router();

router.use(authMiddleware);

router.get('/', groupRecapController.get);
router.put('/', groupRecapController.update);
router.get('/groups', groupRecapController.groups);
router.post('/preview', groupRecapController.preview);
router.post('/send-now', groupRecapController.sendNow);

export default router;
