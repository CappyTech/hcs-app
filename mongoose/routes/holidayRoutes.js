const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/holidayController');

router.post('/holiday/dismiss', authService.ensureAuthenticated, async (req, res, next) => {
  try {
    await ctrl.dismissHoliday(req, res, next);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
