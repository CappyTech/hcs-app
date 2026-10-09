import express from 'express';
const router = express.Router();
import authService from '../../services/authService.js';
import ctrl from '../controllers/overviewController.js';
import overviews from '../config/overviews/index.js';
import overviewEngine from '../services/overviewEngine.js';

// Generated overview pages use the same rule the engine uses to decide whether
// to link to them (overviewEngine.canOpenPath).
const routeGuard = (req, res, next) => {
  if (!req.user) return next({ statusCode: 401, name: 'UnauthorizedError', message: 'User not authenticated' });
  if (overviewEngine.canOpenPath(req, req.path)) return next();
  return next({ statusCode: 403, name: 'ForbiddenError', message: 'You do not have permission to access this page.' });
};

router.post('/overview/projects/check',
  authService.ensureRole('admin'),
  ctrl.postProjectsFinancialCheck);

router.post('/overview/projects/:number/complete',
  authService.ensureRole('admin'),
  ctrl.postProjectMarkComplete);

router.get('/overview/documents',
  authService.ensureRole('admin'),
  ctrl.getDocumentsOverview);

// ── Generated overviews (config/overviews + database changes) ──────────
// Looked up per request, so areas and overviews added or hidden from the
// database work without a restart. Hand-built pages above take precedence.
router.get('/overview/:id', async (req, res, next) => {
  const area = overviews.getAreaByPath(req.path);
  const node = area ? null : overviews.getNodeByOverviewPath(req.path);
  if ((area && area.bespoke) || (!area && !node)) return next();
  return routeGuard(req, res, (err) => {
    if (err) return next(err);
    return area ? ctrl.getGeneratedArea(area.id)(req, res, next) : ctrl.getGeneratedNode(node.id)(req, res, next);
  });
});

export default router;
