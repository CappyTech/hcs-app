const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/paperlessController');

router.get('/paperless/ocr', authService.ensureAuthenticated, authService.ensureRole(), ctrl.listOcr);
router.get('/paperless/ocr/:paperlessId', authService.ensureAuthenticated, authService.ensureRole(), ctrl.readOcr);
router.get('/paperless/ingest', authService.ensureAuthenticated, authService.ensureRole(), ctrl.listIngest);
router.post('/paperless/ingest/trigger', authService.ensureAuthenticated, authService.ensureRole(), ctrl.triggerGrab);

module.exports = router;