const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/loggerController');

router.get('/logs', authService.ensureRole(), ctrl.getLogs);
router.get('/logs/api', authService.ensureRole(), ctrl.getLogsApi);
router.get('/logs/download', authService.ensureRole(), ctrl.downloadLogs);
router.delete('/logs/clear', authService.ensureRole(), ctrl.clearLogs);

module.exports = router;
