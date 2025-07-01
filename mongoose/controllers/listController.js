const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');

const listController = {};

const capitalize = str =>
  str.charAt(0).toUpperCase() + str.slice(1);

const generateHeaders = (firstDoc) => {
  const keys = Object.keys(firstDoc).filter(k => !['_id', '__v'].includes(k));
  return keys.map(key => ({
    key,
    label: key
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
  }));
};

for (const modelName of Object.keys(mdb)) {
  // Skip non-model entries like mdb.connect
  if (typeof mdb[modelName]?.find !== 'function') continue;

  const functionName = `list${capitalize(modelName)}`;
  listController[functionName] = async (req, res, next) => {
    try {
      const items = await mdb[modelName].find().sort({ createdAt: -1 }).lean();

      if (!items.length) {
        return res.render(path.join('mongoose', 'partials', 'listTable'), {
          title: `${capitalize(modelName)}s`,
          headers: [],
          rows: [],
          basePath: modelName
        });
      }

      const headers = generateHeaders(items[0]);

      res.render(path.join('mongoose', 'partials', 'listTable'), {
        title: `${capitalize(modelName)}s`,
        headers,
        rows: items,
        basePath: modelName
      });
    } catch (err) {
      logger.error(`Error listing ${modelName}:`, err);
      next(err);
    }
  };
}

module.exports = listController;
