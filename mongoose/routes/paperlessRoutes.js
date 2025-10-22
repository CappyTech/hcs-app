const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/paperlessController');

router.get('/paperless/ocr', authService.ensureAuthenticated, authService.ensureRole(), ctrl.listOcr);
router.get('/paperless/ocr/:paperlessId', authService.ensureAuthenticated, authService.ensureRole(), ctrl.readOcr);
router.get('/paperless/ocr/:paperlessId/draft', authService.ensureAuthenticated, authService.ensureRole(), ctrl.getPurchaseDraft);
router.post('/paperless/ocr/:paperlessId/send', authService.ensureAuthenticated, authService.ensureRole(), ctrl.sendDraftToKashflow);
router.get('/paperless/suppliers', authService.ensureAuthenticated, authService.ensureRole(), ctrl.searchSuppliers);
router.get('/paperless/ingest', authService.ensureAuthenticated, authService.ensureRole(), ctrl.listIngest);
router.post('/paperless/ingest/trigger', authService.ensureAuthenticated, authService.ensureRole(), ctrl.triggerGrab);

module.exports = router;