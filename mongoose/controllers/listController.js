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
  if (denyGuard(config, 'l')) continue;

  const functionName = `list${capitalize(modelName)}`;
  listController[functionName] = async (req, res, next) => {
    const sortField = config.sortField || 'createdAt';
    const sortOrder = config.sortOrder ?? -1;

    const searchQuery = req.query.search || '';
    const limit = parseInt(req.query.limit) || 100;
    const page = parseInt(req.query.page) || 1;
    const skip = (page - 1) * limit;

    let query = {};

    try {
      // Search filtering
      if (searchQuery && typeof searchQuery === 'string') {
        const regex = new RegExp(searchQuery, 'i');

        let searchFields = [];
        if (Array.isArray(config.search) && config.search.length > 0) {
          searchFields = config.search;
        } else if (Array.isArray(config.fieldOrder) && config.fieldOrder.length > 0) {
          searchFields = config.fieldOrder;
        } else {
          searchFields = [config.linkField, config.sortField].filter(Boolean);
        }

        query = {
          $or: searchFields
            .map(field => {
              const path = schemaPaths[field];
              if (!path) return null;

              const type = path.instance;

              if (type === 'String') {
                return { [field]: { $regex: regex } };
              } else if (type === 'Number' && !isNaN(searchQuery)) {
                return { [field]: Number(searchQuery) };
              } else {
                return null; // Skip unsupported types
              }
            })
            .filter(Boolean)
        };
      }

      const totalCount = await model.countDocuments(query);
      const totalPages = Math.ceil(totalCount / limit);
      const items = await model.find(query)
        .sort({ [sortField]: sortOrder })
        .skip(skip)
        .limit(limit)
        .lean();

      const headers = items.length ? generateHeaders(items[0], config) : [];

      return res.render(path.join('tailwindcss', 'partials', 'listTable'), {
        title: config.title || capitalize(modelName) + 's',
        headers,
        rows: items,
        basePath: modelName,
        linkField: config.linkField || 'title',
        actions: config.actions || [],
        hasActions: !!(config.actions?.length),
        model,
        query: searchQuery,
        limit,
        page,
        totalPages
      });
    } catch (err) {
      logger.error(`Error listing ${modelName}:`, err);
      next(err);
    }
  };
}

module.exports = listController;
