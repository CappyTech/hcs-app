const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/fleetController');

router.get('/fleet', authService.ensureRole(), ctrl.getFleetOverview);

module.exports = router;
