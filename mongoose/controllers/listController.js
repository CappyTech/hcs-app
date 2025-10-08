const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');
const listControllerConfig = require('../config/listControllerConfig');

const denyGuard = (config, op) => Array.isArray(config.deny) && config.deny.includes(op);
const listController = {};

const capitalize = str => str.charAt(0).toUpperCase() + str.slice(1);

// Resolve configuration with case-insensitive + singular fallbacks
const resolveConfig = (modelName) => {
  if (listControllerConfig[modelName]) return listControllerConfig[modelName];
  const lower = modelName.toLowerCase();
  if (listControllerConfig[lower]) return listControllerConfig[lower];
  const singular = lower.endsWith('s') ? lower.slice(0, -1) : null;
  if (singular && listControllerConfig[singular]) return listControllerConfig[singular];
  return {};
};

const generateHeaders = (firstDoc, config = {}) => {
  const defaultHidden = ['_id', '__v'];
  const hidden = new Set([...(config.hideFields || []), ...defaultHidden]);
  const autoHideUnderscore = config.autoHideUnderscore !== false; // default true
  let keys = Object.keys(firstDoc).filter(k => {
    if (hidden.has(k)) return false;
    if (autoHideUnderscore && k.startsWith('_')) return false;
    return true;
  });

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

// Iterate over both REST and INTERNAL namespaces to expose list routes for their models.
['REST', 'INTERNAL'].forEach(ns => {
  const namespace = mdb[ns];
  if (!namespace) return;
  for (const modelName of Object.keys(namespace)) {
    if (modelName === 'connection') continue; // skip connection handle
    const model = namespace[modelName];
    if (typeof model?.find !== 'function') continue; // not a mongoose model

    const config = resolveConfig(modelName);
    if (!config || Object.keys(config).length === 0) {
      logger.debug && logger.debug(`[listController] No config found for model '${modelName}', using defaults.`);
    }
    if (denyGuard(config, 'l')) continue; // skip if list denied in config

    const functionName = `list${capitalize(modelName)}`;
    if (listController[functionName]) continue; // avoid duplicates if name exists in both namespaces

    listController[functionName] = async (req, res, next) => {
      const sortField = config.sortField || 'createdAt';
      const sortOrder = config.sortOrder ?? -1;
      // Pagination & search
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 500);
      const page = Math.max(parseInt(req.query.page) || 1, 1);
      const rawSearch = (req.query.search || '').trim();
      const query = rawSearch;

      // Tabs (categorisation) support
      const tabsBy = config.tabsby || null; // field name to filter by
      const tabsValues = Array.isArray(config.tabsValues) ? config.tabsValues : [];
      const requestedTab = req.query.tab || null;
      const activeTab = requestedTab && tabsValues.some(tv => String(tv.value) === String(requestedTab))
        ? requestedTab
        : null;

      let mongoFilter = {};
      if (query) {
        const searchFields = Array.isArray(config.searchFields) && config.searchFields.length
          ? config.searchFields
          : [config.linkField || 'title'];
        const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'i');
        mongoFilter.$or = searchFields.map(f => ({ [f]: regex }));
      }

      if (tabsBy && activeTab) {
        mongoFilter[tabsBy] = activeTab;
      }

      try {
        const totalCount = await model.countDocuments(mongoFilter);
        // Build tab metadata (no counts per tab for now unless cheap to derive)
        let tabs = [];
        if (tabsValues.length) {
          // Optionally fetch counts per tab (can be expensive). Keep simple unless needed.
          tabs = tabsValues.map(tv => ({
            value: tv.value,
            label: tv.label || String(tv.value),
            isActive: String(tv.value) === String(activeTab)
          }));
        }
        const totalPages = Math.max(Math.ceil(totalCount / limit), 1);
        const skip = (page - 1) * limit;
        let items = await model
          .find(mongoFilter)
          .sort({ [sortField]: sortOrder })
          .skip(skip)
          .limit(limit)
          .lean();

        if (!items.length) {
          return res.render(path.join('tailwindcss', 'partials', 'listTable'), {
            title: config.title || capitalize(modelName) + 's',
            headers: [],
            rows: [],
            basePath: modelName,
            modelName: modelName, // for template usage
            linkField: config.linkField || 'title',
            limit,
            page,
            totalPages,
            query,
            model: modelName,
            actions: config.actions || [],
            fieldLinks: config.fieldLinks || null,
            activeTab,
            tabsValues,
            tabsBy,
            tabs
          });
        }

  const headers = generateHeaders(items[0], config);

        // Hidden management
  const defaultHidden = ['_id', '__v'];
  const autoHideUnderscore = config.autoHideUnderscore !== false;
  const hidden = new Set([...(config.hideFields || []), ...defaultHidden]);
  if (config.linkField) hidden.delete(config.linkField);
  const allowedKeys = new Set(headers.map(h => h.key)); // already filtered

        // Optional field transforms (resolve references, map arrays, etc.)
        const transforms = config.fieldTransforms || {};

        items = items.map(row => {
          const cleaned = {};
          for (const key of allowedKeys) cleaned[key] = row[key];
          // Defensive: ensure no auto-hidden underscore field sneaks in
          if (autoHideUnderscore) {
            for (const k in cleaned) {
              if (k.startsWith('_') && !allowedKeys.has(k)) delete cleaned[k];
            }
          }
          // Preserve uuid internally for link building even if hidden; not rendered because no header for it
          if (row.uuid) cleaned.uuid = row.uuid;
          // Apply transforms after initial filter so we only work on displayed fields
          // Each transform config: { fromModel, matchField, returnField, linkTo }
          for (const [field, tConf] of Object.entries(transforms)) {
            if (!allowedKeys.has(field)) continue; // only transform if field displayed
            const value = row[field];
            // Defer heavy lookups for now; placeholder for future population caching.
            // If value is an array of ObjectIds or objects, leave as count (already handled in view).
            cleaned[field] = value;
          }
          return cleaned;
        });

        res.render(path.join('tailwindcss', 'partials', 'listTable'), {
          title: config.title || capitalize(modelName) + 's',
          headers,
          rows: items,
          basePath: modelName,
          modelName: modelName,
          linkField: config.linkField || 'title',
          limit,
          page,
          totalPages,
          query,
          model: modelName,
          actions: config.actions || [],
          fieldLinks: config.fieldLinks || null,
          activeTab,
          tabsValues,
          tabsBy,
          tabs
        });
      } catch (err) {
        logger.error(`Error listing ${modelName}:`, err);
        next(err);
      }
    };
  }
});

module.exports = listController;
