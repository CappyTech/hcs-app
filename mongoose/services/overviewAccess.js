import rbac from '../config/rolePermissionsConfig.js';
import registry from '../config/overviews/index.js';
import modules from '../../services/moduleService.js';
import staffologyMode from '../../services/staffologyModeService.js';

/**
 * May this person open an overview page? One rule for every page: a
 * controlled route (rolePermissionsConfig.routeAccess) when there is one;
 * otherwise, for an area or overview added from the database, the roles
 * stored with it. Anything else stays closed.
 *
 * Takes the user rather than the request so the navigation (built before
 * any page runs) asks the same question the page will.
 */
export function canUserOpenPath(user, path) {
  if (!user || !path) return false;
  // Pages of a module the company has switched off stay closed to everyone.
  if (!modules.isPathEnabled(path)) return false;
  // Payroll in Staffology hides the in-house engine's pages (and vice versa).
  if (staffologyMode.hidesPath(path)) return false;
  const role = rbac.rolesOf(user);
  const custom = user.customPermissions || {};
  if (rbac.getAllowedRolesForRoute(path) || role.includes('admin')) return rbac.canAccessRoute(role, path, custom);
  const def = registry.getAreaByPath(path) || registry.getNodeByOverviewPath(path);
  if (def && !def._default && Array.isArray(def.roles)) return role.some((r) => def.roles.includes(r)) || !!custom?.routes?.includes(path);
  return false;
}

export default { canUserOpenPath };
