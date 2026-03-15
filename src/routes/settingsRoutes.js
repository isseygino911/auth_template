import express from 'express';
import {
  getSettings,
  getSetting,
  getTaxRate,
  updateSettings,
} from '../controllers/settingsController.js';
import { authMiddleware, adminMiddleware } from '../middleware/auth.js';

const router = express.Router();

// Public route - get tax rate for checkout (MUST be before /:key)
router.get('/tax-rate', getTaxRate);

// Admin routes
router.get('/', authMiddleware, adminMiddleware, getSettings);
router.put('/', authMiddleware, adminMiddleware, updateSettings);

// This must be LAST to avoid catching other routes
router.get('/:key', authMiddleware, adminMiddleware, getSetting);

export default router;
