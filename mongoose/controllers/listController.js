const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');
const listControllerConfig = require('../config/listControllerConfig');

const denyGuard = (config, op) => Array.isArray(config.deny) && config.deny.includes(op);
const listController = {};

const capitalize = str => str.charAt(0).toUpperCase() + str.slice(1);

// Merge config overrides safely
const getMergedConfig = (modelName, overrides = {}) => ({
  ...overrides,
  ...(listControllerConfig?.[modelName] || {})
});

// Generate table headers
const generateHeaders = (firstDoc, config = {}) => {
  let keys = Object.keys(firstDoc).filter(
    k => !((config.hideFields || []).includes(k) || k.startsWith('_'))
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

// Generate list controllers dynamically for each model
for (const [modelName, model] of Object.entries(mdb)) {
  if (typeof modelName !== 'string') continue;
  if (!model?.schema || typeof model.find !== 'function') continue;

  const Model = model;
  let baseName = capitalize(modelName);
  const config = getMergedConfig(modelName, listControllerConfig[modelName] || {});
  if (config.modelRename) {
    baseName = capitalize(config.modelRename);
  }

  if (denyGuard(config, 'l')) continue;

  const functionName = `list${baseName}`;
  listController[functionName] = async (req, res, next) => {
    const sortField = req.query.sort || config.sortField || 'createdAt';
    const sortOrder = req.query.order === 'asc' ? 1 : -1;

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

        const schemaPaths = model.schema.paths;

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
                return null;
              }
            })
            .filter(Boolean)
        };
      }

      let tabs = [];
      let activeTab = null;

      if (config.tabsby) {
        const tabsby = config.tabsby;
        const tabsValues = Array.isArray(config.tabsValues) ? config.tabsValues : [];

        // Only filter by tab if req.query.tab matches one of the tabsValues values
        if (req.query.tab && tabsValues.some(tab => tab.value === req.query.tab)) {
          query[tabsby] = req.query.tab;
          activeTab = req.query.tab;
        }

        // Build tabs from config.tabsValues always (even if no data)
        if (tabsValues.length) {
          tabs = tabsValues.map(tab => ({
            value: tab.value,
            label: tab.label,
            isActive: tab.value === activeTab,
          }));
        } else {
          // fallback: create tabs from distinct values in data if no tabsValues configured
          // We'll handle this after fetching items
        }

        // Always exclude tab field from headers
        config.hideFields = [...(config.hideFields || []), tabsby];
      }

      // Count total documents matching current query (including tab filter)
      const totalCount = await model.countDocuments(query);
      const totalPages = Math.ceil(totalCount / limit);

      let queryExec = model.find(query)
        .sort({ [sortField]: sortOrder })
        .skip(skip)
        .limit(limit);

      // Dynamically populate all ref fields using model's linkField as default select
      const refPaths = Object.entries(model.schema.paths).filter(
        ([, schemaType]) => schemaType.options && schemaType.options.ref
      );

      for (const [pathKey, schemaType] of refPaths) {
        const refModelName = schemaType.options.ref;
        const refModel = mdb[refModelName];

        let selectField = null;

        // Try using linkField from the referenced model
        const refConfig = listControllerConfig?.[refModelName];
        if (refConfig?.linkField) {
          const refFieldExists = refModel?.schema?.paths?.[refConfig.linkField];
          if (refFieldExists) selectField = refConfig.linkField;
        }

        queryExec = queryExec.populate(pathKey, selectField || '');
      }

      const items = await queryExec.lean();

      // If tabsValues is empty, fallback: build tabs from distinct values in the data for the tabsby field
      if (config.tabsby && (!tabs.length || tabs.length === 0)) {
        const distinctMap = {};
        for (const item of items) {
          const rawValue = item[config.tabsby];
          if (rawValue == null) continue;
          const label = typeof rawValue === 'string'
            ? rawValue
            : rawValue?.name || rawValue?.title || rawValue?.label || String(rawValue);
          distinctMap[String(rawValue)] = label;
        }
        tabs = Object.entries(distinctMap).map(([value, label]) => ({
          value,
          label,
          isActive: value === req.query.tab,
        }));
        activeTab = req.query.tab;
      }

      // Apply fieldTransforms from config
      if (config.fieldTransforms) {
        for (const [fieldKey, transform] of Object.entries(config.fieldTransforms)) {
          const { fromModel, matchField, returnField } = transform;
          if (!fromModel || !matchField || !returnField) continue;

          const matchValues = [...new Set(items.map(i => i[fieldKey]).filter(Boolean))];
          const refModel = mdb[fromModel];
          if (!refModel) continue;

          const docs = await refModel.find({ [matchField]: { $in: matchValues } }).lean();
          const map = Object.fromEntries(
            docs.map(d => [d[matchField], { label: d[returnField], uuid: d.uuid }])
          );

          for (const item of items) {
            const matched = map[item[fieldKey]];
            if (matched) {
              item[fieldKey] = matched.label;
              if (!item._fieldLinks) item._fieldLinks = {};
              item._fieldLinks[fieldKey] = `/customer/read/${matched.uuid}`;
            }
          }
        }
      }
      
      const fieldLinks = { ...(config.fieldLinks || {}) };

      if (config.fieldTransforms) {
        for (const [fieldKey, transform] of Object.entries(config.fieldTransforms)) {
          if (typeof transform.linkTo === 'function') {
            fieldLinks[fieldKey] = transform.linkTo;
          }
        }
      }

      const headers = items.length ? generateHeaders(items[0], config) : [];

      // Sanitize rows before sending to EJS
      const rows = items.map(item => {
        if (item.uuid && typeof item.uuid !== 'string') {
          item.uuid = String(item.uuid);
        }
        return item;
      });

      const routeModel = (config.modelRename || modelName).toLowerCase();
      const pluralBasePath = `${routeModel}s`;

      return res.render(path.join('tailwindcss', 'partials', 'listTable'), {
        title: config.title || baseName + 's',
        headers,
        rows,
        basePath: pluralBasePath,
        linkField: config.linkField || 'title',
        actions: config.actions || [],
        hasActions: !!(config.actions?.length),
        modelName: baseName,
        query: searchQuery,
        queryParams: req.query,
        sortField,
        sortOrder,
        limit,
        page,
        totalPages,
        fieldLinks: row => row._fieldLinks || {},
        tabs,
        activeTab,
      });
    } catch (err) {
      logger.error(`Error listing ${modelName}:`, err);
      next(err);
    }
  };
}

module.exports = listController;
