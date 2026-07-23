import express from 'express';
const router = express.Router();
import setup from '../controllers/setupController.js';

// The wizard runs before the main app stack (which normally supplies the
// body parsers), so it must parse its own request bodies.
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

// CSRF is not yet mounted when these routes are active, so they use their own
// lightweight origin check instead of the app-wide CSRF middleware.
function sameOriginOnly(req, res, next) {
  // Allow GET and the POST routes from the same host only
  if (req.method !== 'POST') return next();
  const origin = req.get('origin') || '';
  const host = req.get('host') || '';
  if (origin && !origin.includes(host)) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  next();
}

router.use(sameOriginOnly);

router.get('/',              setup.getStep1);
router.post('/step1',        setup.postStep1);
router.post('/test-db',      setup.postTestDb);
router.get('/step2',         setup.getStep2);
router.post('/step2',        setup.postStep2);
router.get('/step3',         setup.getStep3);
router.post('/complete',     setup.postComplete);
router.post('/clear-draft',  setup.postClearDraft);

export default router;
