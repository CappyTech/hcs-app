import express from 'express';
import crudController from '../controllers/CRUDController.js';
import crudConfig from '../config/CRUDControllerConfig.js';
import authService from '../../services/authService.js';
import __listControllerConfig from '../config/listControllerConfig.js';

const router = express.Router();

const uuidv4Regex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

router.param("uuid", (req, res, next, uuid) => {
  if (!uuidv4Regex.test(uuid)) {
    // Not a valid UUID — skip this CRUD route and let Express try the next
    // matching route. Sending a 404 here instead would *shadow* specific
    // routes that share the `/:model/<segment>` shape — e.g. POST /user/2fa
    // was being captured by the generated POST /user/:uuid (update) route and
    // 404'd before twoFARoutes could handle it.
    return next("route");
  }
  next();
});

// Resolve a string like 'ensureRole:admin' or 'ensureRoles:admin,accountant' into actual middleware.
// `grant` ({ model, operation }) lets a job role in whose permission groups
// grant that operation on that model; the listed primary roles are unchanged.
const resolveMiddleware = (entry = "", grant = null) => {
  if (!entry.includes(":")) return authService[entry];
  const [fn, ...rest] = entry.split(":");
  const arg = rest.join(":"); // rejoin in case of colons in args
  if (fn === "ensureRoles") {
    // Support comma-separated roles: 'ensureRoles:admin,accountant'
    const roles = arg.split(",").map((r) => r.trim());
    return authService.ensureRolesOrGrant(roles, grant);
  }
  if (fn === "ensureRole" && arg && arg !== "public") {
    return authService.ensureRolesOrGrant([arg], grant);
  }
  return authService[fn]?.(arg);
};

const ACTION_OPS = { create: "c", read: "r", update: "u", delete: "d" };

// Guard for an action whose config lists no middleware: allow only what the
// RBAC model matrix grants (admin always). The generic create/update/delete
// handlers can't enforce record ownership, so an own-only grant is refused
// for those; the read handler checks ownership itself.
export const defaultModelGuard = (model, operation) => {
  const matrix = authService.ensureModelAccess(model, operation);
  return (req, res, next) =>
    matrix(req, res, (err) => {
      if (err) return next(err);
      if (operation !== "r" && req.rbac?.ownOnly) {
        return next({
          statusCode: 403,
          name: "ForbiddenError",
          message: "You do not have permission to access this page.",
        });
      }
      next();
    });
};

for (const [key, handler] of Object.entries(crudController)) {
  const match = key.match(/^(create|read|update|delete)([A-Z][a-zA-Z]*)$/);
  if (!match) continue;

  const [_, action, modelName] = match;
  const originalModel = modelName.charAt(0).toLowerCase() + modelName.slice(1);
  const config = crudConfig[originalModel] || {};
  const listConfig =
    __listControllerConfig[originalModel] || {};
  const mergedConfig = { ...listConfig, ...config };

  const routeModel = (mergedConfig.modelRename || originalModel).toLowerCase();
  const routePath = `/${routeModel}`;
  const uuidPath = `${routePath}/:uuid`;

  const middlewares = mergedConfig.middleware?.[action] || [];

  const grant = { model: originalModel, operation: ACTION_OPS[action] };
  let resolvedMiddleware = middlewares.map((m) => resolveMiddleware(m, grant)).filter(Boolean);
  // Deny by default: a model or action with no guard in its config used to be
  // open to every signed-in user (e.g. POST /appconfig, /payrollrun/read/:uuid).
  // Fall back to the RBAC model matrix instead.
  if (resolvedMiddleware.length === 0) {
    resolvedMiddleware = [defaultModelGuard(originalModel, ACTION_OPS[action])];
  }

  switch (action) {
    case "create":
      router.get(`${routePath}/create`, ...resolvedMiddleware, handler); // e.g. /employee/create
      router.post(`${routePath}`, ...resolvedMiddleware, handler); // e.g. /employee
      break;

    case "read":
      router.get(`${routePath}/read/:uuid`, ...resolvedMiddleware, handler); // ✅ e.g. /employee/read/:uuid
      break;

    case "update":
      router.get(`${routePath}/update/:uuid`, ...resolvedMiddleware, handler); // ✅ e.g. /employee/update/:uuid
      router.post(`${uuidPath}`, ...resolvedMiddleware, handler); // e.g. /employee/:uuid
      break;

    case "delete":
      router.get(`${routePath}/delete/:uuid`, ...resolvedMiddleware, handler); // ✅ e.g. /employee/delete/:uuid
      router.post(`${uuidPath}/delete`, ...resolvedMiddleware, handler); // e.g. /employee/:uuid/delete
      break;
  }
}

export default router;
