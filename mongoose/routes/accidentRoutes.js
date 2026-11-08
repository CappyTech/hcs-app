import express from 'express';
const router = express.Router();
import ctrl from '../controllers/accidentController.js';

// Accident book (Health & Safety, phase 5d). Reporting is open to anyone on
// site; the book itself to admins and Health & Safety at approve or above.
// /accident-report is outside /accidents so the approve-only routeAccess
// prefix for /accidents doesn't catch it.
router.get('/accident-report', ctrl.ensureReporter, ctrl.getReport);
router.post('/accident-report', ctrl.ensureReporter, ctrl.postReport);
router.get('/accident-report/mine', ctrl.ensureReporter, ctrl.getMine);

router.get('/accidents', ctrl.ensureBookReader, ctrl.getBook);
router.get('/accidents/:uuid', ctrl.ensureBookReader, ctrl.getEntry);
router.post('/accidents/:uuid', ctrl.ensureBookReader, ctrl.postEntry);

export default router;
