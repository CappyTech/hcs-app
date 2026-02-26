const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/holidayController');

// Any authenticated user can dismiss a holiday notification
router.post('/holiday/dismiss', authService.ensureAnyRole(), async (req, res, next) => {
  try {
    await ctrl.dismissHoliday(req, res, next);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
