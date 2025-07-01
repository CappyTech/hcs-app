const express = require('express');
const fs = require('fs');
const path = require('path');
const logger = require('../../services/loggerService');
const router = express.Router();

function loadRoutes(dir) {
  fs.readdirSync(dir).forEach((file) => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      loadRoutes(fullPath);
    } else if (file !== 'index.js' && path.extname(fullPath) === '.js') {
      const r = require(fullPath);
      if (typeof r === 'function' || (typeof r === 'object' && r.stack && r.handle)) {
        router.use('/', r);
        logger.debug(`Mounted routes from ${file} at /`);
      } else {
        logger.warn(`Skipping ${file}: does not export an Express router`);
      }
    }
  });
}

loadRoutes(__dirname);

module.exports = router;
