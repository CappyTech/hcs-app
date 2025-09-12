const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');
const listControllerConfig = require('../config/listControllerConfig');

const denyGuard = (config, op) => Array.isArray(config.deny) && config.deny.includes(op);
const listController = {};

const capitalize = str => str.charAt(0).toUpperCase() + str.slice(1);

const generateHeaders = (firstDoc, config = {}) => {
  let keys = Object.keys(firstDoc).filter(
    k => !(config.hideFields || []).includes(k)
  );

  // Reorder keys based on fieldOrder if provided
  if (Array.isArray(config.fieldOrder)) {
    const ordered = config.fieldOrder.filter(k => keys.includes(k));
    const extras = keys.filter(k => !ordered.includes(k));
    keys = config.strictOrder ? ordered : [...ordered, ...extras];
  }

  return keys.map(key => ({
    key,
    label: config.labelOverrides?.[key] ||
      key.replace(/([a-z])([A-Z])/g, '$1 $2')
         .replace(/_/g, ' ')
         .replace(/\b\w/g, c => c.toUpperCase())
  }));
};

for (const modelName of Object.keys(mdb)) {
  const model = mdb[modelName];
  if (typeof model?.find !== 'function') continue;

  const config = listControllerConfig[modelName] || {};
  if (denyGuard(config, 'l')) continue; // 👈 skip if list is denied

  const functionName = `list${capitalize(modelName)}`;
  listController[functionName] = async (req, res, next) => {
    const sortField = config.sortField || 'createdAt';
    const sortOrder = config.sortOrder ?? -1;

    try {
      const items = await model.find().sort({ [sortField]: sortOrder }).lean();

      if (!items.length) {
        return res.render(path.join('mongoose', 'partials', 'listTable'), {
          title: config.title || capitalize(modelName) + 's',
          headers: [],
          rows: [],
          basePath: modelName,
          linkField: config.linkField || 'title'
        });
      }

      const headers = generateHeaders(items[0], config);

      res.render(path.join('mongoose', 'partials', 'listTable'), {
        title: config.title || capitalize(modelName) + 's',
        headers,
        rows: items,
        basePath: modelName,
        linkField: config.linkField || 'title'
      });
    } catch (err) {
      logger.error(`Error listing ${modelName}:`, err);
      next(err);
    }
  };
}

module.exports = listController;
