// TODO: Load placeholder routes for mongoose; remove when real implementations are added.
/*
 * Recursively load all placeholder mongoose routes.
 * Each route file exports an Express router.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

function loadRoutes(dir) {
  fs.readdirSync(dir).forEach((file) => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      loadRoutes(fullPath);
    } else if (file !== 'index.js' && path.extname(fullPath) === '.js') {
      const r = require(fullPath);
      router.use('/', r);
    }
  });
}

loadRoutes(__dirname);

module.exports = router;
