const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/attendanceController');

router.post('/holiday/dismiss', authService.ensureAuthenticated, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  ctrl.dismissHoliday(req, res);
});

module.exports = router;
