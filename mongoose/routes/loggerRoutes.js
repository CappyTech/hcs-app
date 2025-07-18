const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/loggerController');

router.get('/logs', authService.ensureRole(), ctrl.getLogs);

module.exports = router;
