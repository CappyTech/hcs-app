import express from 'express';
import ctrl from '../controllers/firstRunController.js';

// Mounted by firstRunService's gate inside appRouter, so the body parsers,
// session, CSRF and flash middleware have already run.
const router = express.Router();

router.get('/setup', ctrl.getFirstRun);
router.post('/setup', ctrl.postFirstRun);
// The Mongo wizard's paths from a previous life of this URL.
router.get('/setup/*', (_req, res) => res.redirect('/setup'));

export default router;
