const express = require('express');
const listController = require('../controllers/listController');
const authService = require('../../services/authService');

const router = express.Router();

// Get all exported functions from listController
for (const [functionName, handler] of Object.entries(listController)) {
  const match = functionName.match(/^list([A-Z][a-zA-Z]*)$/);
  if (!match) continue;

  const modelName = match[1];
  const originalModel = modelName.charAt(0).toLowerCase() + modelName.slice(1);
  const listConfig = require('../config/listControllerConfig')[originalModel] || {};
  const routeModel = (listConfig.modelRename || originalModel).toLowerCase();
  let routePath;
  if (listConfig.pathOverride) {
    routePath = listConfig.pathOverride.startsWith('/') ? listConfig.pathOverride : `/${listConfig.pathOverride}`;
  } else {
    // Support nested paths in modelRename, e.g., 'paperless/ocrdocument' -> '/paperless/ocrdocuments'
    const parts = routeModel.split('/').filter(Boolean);
    const last = parts.pop();
    const pluralLast = `${last}s`;
    routePath = `/${[...parts, pluralLast].join('/')}`;
  }

  // Register route: e.g. GET /contracts
  router.get(routePath, authService.ensureRole(), authService.ensureAuthenticated, handler);
}

module.exports = router;
