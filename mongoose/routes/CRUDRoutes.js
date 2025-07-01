const express = require('express');
const crudController = require('../controllers/CRUDController');
const crudConfig = require('../config/CRUDControllerConfig');
const authService = require('../../services/authService');

const router = express.Router();

// Resolve a string like 'ensureRole:admin' into actual middleware
const resolveMiddleware = (entry = '') => {
  if (!entry.includes(':')) return authService[entry];
  const [fn, arg] = entry.split(':');
  return authService[fn]?.(arg);
};

for (const [key, handler] of Object.entries(crudController)) {
  const match = key.match(/^(create|read|update|delete)([A-Z][a-zA-Z]*)$/);
  if (!match) continue;

  const [_, action, modelName] = match;
  const model = modelName.charAt(0).toLowerCase() + modelName.slice(1);
  const routePath = `/${model}`;
  const uuidPath = `${routePath}/:uuid`;

  const config = crudConfig[model] || {};
  const middlewares = config.middleware?.[action] || [];

  const resolvedMiddleware = middlewares.map(resolveMiddleware).filter(Boolean);

  switch (action) {
    case 'create':
      router.get(`${routePath}/create`, ...resolvedMiddleware, authService.ensureRole(), authService.ensureAuthenticated, handler);     // e.g. /employee/create
      router.post(`${routePath}`, ...resolvedMiddleware, handler);           // e.g. /employee
      break;

    case 'read':
      router.get(`${routePath}/read/:uuid`, ...resolvedMiddleware, handler); // ✅ e.g. /employee/read/:uuid
      break;

    case 'update':
      router.get(`${routePath}/update/:uuid`, ...resolvedMiddleware, handler); // ✅ e.g. /employee/update/:uuid
      router.post(`${uuidPath}`, ...resolvedMiddleware, handler);              // e.g. /employee/:uuid
      break;

    case 'delete':
      router.get(`${routePath}/delete/:uuid`, ...resolvedMiddleware, handler); // ✅ e.g. /employee/delete/:uuid
      router.post(`${uuidPath}/delete`, ...resolvedMiddleware, handler);       // e.g. /employee/:uuid/delete
      break;
  }

}

module.exports = router;
