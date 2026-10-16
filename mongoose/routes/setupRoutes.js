import express from 'express';
import setup from '../controllers/setupController.js';

/**
 * The database wizard's router. Built by app.js with the continuation that
 * mounts the full application once a database is saved.
 *
 * The wizard runs before the main app stack (which normally supplies the body
 * parsers and CSRF), so it parses its own bodies and uses a same-origin check
 * instead of the app-wide CSRF middleware.
 */
export default function createSetupRouter(onConfigured) {
  const router = express.Router();

  router.use(express.json());
  router.use(express.urlencoded({ extended: true }));

  router.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const origin = req.get('origin') || '';
    const host = req.get('host') || '';
    if (origin && !origin.includes(host)) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    next();
  });

  router.get('/', setup.getStep1);
  router.post('/test-db', setup.postTestDb);
  router.post('/complete', setup.makePostComplete(onConfigured));
  // Steps 2 and 3 of the old wizard: company details and the first admin now
  // live on the first-run page once the database is connected.
  router.get('/*', (_req, res) => res.redirect('/setup'));

  return router;
}
