import express from 'express';
const router = express.Router();
import authService from '../../services/authService.js';
import ctrl from '../controllers/overviewController.js';
import rbac from '../config/rolePermissionsConfig.js';
import overviews from '../config/overviews/index.js';

// Generated overview pages use the route rule for their own path, the same
// rule the engine uses to decide whether to link to them.
const routeGuard = (routePath) => (req, res, next) => {
  if (!req.user) return next({ statusCode: 401, name: 'UnauthorizedError', message: 'User not authenticated' });
  if (rbac.canAccessRoute(req.user.role, routePath, req.user.customPermissions || {})) return next();
  return next({ statusCode: 403, name: 'ForbiddenError', message: 'You do not have permission to access this page.' });
};

router.post('/overview/projects/check',
  authService.ensureRole('admin'),
  ctrl.postProjectsFinancialCheck);

router.post('/overview/projects/:number/complete',
  authService.ensureRole('admin'),
  ctrl.postProjectMarkComplete);

router.get('/overview/admin',
  authService.ensureRole('admin'),
  ctrl.getAdminOverview);

router.get('/overview/documents',
  authService.ensureRole('admin'),
  ctrl.getDocumentsOverview);

router.get('/overview/payroll',
  authService.ensureRoles('admin', 'accountant'),
  ctrl.getPayrollOverview);

router.get('/overview/policies',
  authService.ensureRole('admin'),
  ctrl.getPoliciesOverview);

// ── Generated overviews (config/overviews) ──────────────────────────────
for (const area of overviews.listAreas()) {
  if (area.bespoke) continue; // still a hand-built page with its own route above
  router.get(area.path, routeGuard(area.path), ctrl.getGeneratedArea(area.id));
}
for (const node of overviews.listNodes()) {
  if (node.overview && node.overviewPath) {
    router.get(node.overviewPath, routeGuard(node.overviewPath), ctrl.getGeneratedNode(node.id));
  }
}

export default router;
