import express from 'express';
const router = express.Router();
import authService from '../../services/authService.js';
import ctrl from '../controllers/holidayController.js';

// Any authenticated user can dismiss a holiday notification
router.post(
  "/holiday/dismiss",
  authService.ensureAnyRole(),
  async (req, res, next) => {
    try {
      await ctrl.dismissHoliday(req, res, next);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
