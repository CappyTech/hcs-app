const express = require('express');
const listController = require('../controllers/listController');
const authService = require('../../services/authService');

const router = express.Router();

// Get all exported functions from listController
for (const [functionName, handler] of Object.entries(listController)) {
  const match = functionName.match(/^list([A-Z][a-zA-Z]*)$/);
  if (!match) continue;

  const modelName = match[1];
  const pluralPath = `${modelName.charAt(0).toLowerCase()}${modelName.slice(1)}s`;

  // Register route: e.g. GET /contracts
  router.get(`/${pluralPath}`, authService.ensureRole(), authService.ensureAuthenticated, handler);
}

module.exports = router;
