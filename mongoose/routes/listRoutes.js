import express from 'express';
import listController from '../controllers/listController.js';
import authService from '../../services/authService.js';
import rbac from '../config/rolePermissionsConfig.js';
import __listControllerConfig from '../config/listControllerConfig.js';
import __CRUDControllerConfig from '../config/CRUDControllerConfig.js';

const router = express.Router();

// Get all exported functions from listController
for (const [functionName, handler] of Object.entries(listController)) {
  const match = functionName.match(/^list([A-Z][a-zA-Z]*)$/);
  if (!match) continue;

  const modelName = match[1];
  const originalModel = modelName.charAt(0).toLowerCase() + modelName.slice(1);
  const listConfig =
    __listControllerConfig[originalModel] || {};
  const routeModel = (listConfig.modelRename || originalModel).toLowerCase();
  let routePath;
  if (listConfig.pathOverride) {
    routePath = listConfig.pathOverride.startsWith("/")
      ? listConfig.pathOverride
      : `/${listConfig.pathOverride}`;
  } else {
    // Support nested paths in modelRename, e.g., 'paperless/ocrdocument' -> '/paperless/ocrdocuments'
    const parts = routeModel.split("/").filter(Boolean);
    const last = parts.pop();
    const pluralLast = `${last}s`;
    routePath = `/${[...parts, pluralLast].join("/")}`;
  }

  // Build role list. Admin always has access.
  // Check which other roles can list this model via RBAC config.
  const crudConfig =
    __CRUDControllerConfig[originalModel] || {};
  const middlewares = crudConfig.middleware?.read ||
    __CRUDControllerConfig.default?.middleware?.read || [
      "ensureRole:admin",
    ];

  // Use the same middleware resolution as CRUDRoutes
  const resolveMiddleware = (entry = "") => {
    if (!entry.includes(":")) return authService[entry];
    const [fn, ...rest] = entry.split(":");
    const arg = rest.join(":");
    if (fn === "ensureRoles") {
      const roles = arg.split(",").map((r) => r.trim());
      return authService.ensureRoles(...roles);
    }
    return authService[fn]?.(arg);
  };

  const resolved = middlewares.map(resolveMiddleware).filter(Boolean);

  router.get(routePath, ...resolved, handler);
}

export default router;
