const path = require("path");
const mdb = require("../services/mongooseDatabaseService");
const logger = require("../../services/loggerService");
const listControllerConfig = require("../config/listControllerConfig");
const { scopeQuery } = require("../../services/dataScopingService");

const denyGuard = (config, op) =>
  Array.isArray(config.deny) && config.deny.includes(op);
const listController = {};

const capitalize = (str) => str.charAt(0).toUpperCase() + str.slice(1);

// Resolve configuration with case-insensitive + singular fallbacks
const resolveConfig = (modelName) => {
  if (listControllerConfig[modelName]) return listControllerConfig[modelName];
  const lower = modelName.toLowerCase();
  if (listControllerConfig[lower]) return listControllerConfig[lower];
  const singular = lower.endsWith("s") ? lower.slice(0, -1) : null;
  if (singular && listControllerConfig[singular])
    return listControllerConfig[singular];
  return {};
};

const generateHeaders = (firstDoc, config = {}) => {
  const defaultHidden = ["_id", "__v"];
  const hidden = new Set([...(config.hideFields || []), ...defaultHidden]);
  const autoHideUnderscore = config.autoHideUnderscore !== false; // default true
  let keys = Object.keys(firstDoc).filter((k) => {
    if (hidden.has(k)) return false;
    if (autoHideUnderscore && k.startsWith("_")) return false;
    return true;
  });

  // Reorder keys based on fieldOrder if provided
  if (Array.isArray(config.fieldOrder)) {
    const ordered = config.fieldOrder.filter((k) => keys.includes(k));
    const extras = keys.filter((k) => !ordered.includes(k));
    keys = config.strictOrder ? ordered : [...ordered, ...extras];
  }

  return keys.map((key) => ({
    key,
    label:
      config.labelOverrides?.[key] ||
      key
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase()),
  }));
};

// Iterate over REST, INTERNAL and PAPERLESS namespaces to expose list routes for their models.
["REST", "INTERNAL", "PAPERLESS"].forEach((ns) => {
  const namespace = mdb[ns];
  if (!namespace) return;
  for (const modelName of Object.keys(namespace)) {
    if (modelName === "connection") continue; // skip connection handle
    const model = namespace[modelName];
    if (typeof model?.find !== "function") continue; // not a mongoose model

    const config = resolveConfig(modelName);
    if (!config || Object.keys(config).length === 0) {
      logger.debug &&
        logger.debug(
          `[listController] No config found for model '${modelName}', using defaults.`,
        );
    }
    if (denyGuard(config, "l")) continue; // skip if list denied in config

    const functionName = `list${capitalize(modelName)}`;
    if (listController[functionName]) continue; // avoid duplicates if name exists in both namespaces

    listController[functionName] = async (req, res, next) => {
      const rawSort = req.query.sort;
      const sortField = (rawSort && /^[a-zA-Z0-9_.]+$/.test(rawSort)) ? rawSort : (config.sortField || "createdAt");
      const sortOrder = req.query.order === 'asc' ? 1 : req.query.order === 'desc' ? -1 : (config.sortOrder ?? -1);
      // Pagination & search
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 500);
      const page = Math.max(parseInt(req.query.page) || 1, 1);
      const rawSearch = (req.query.search || "").trim();
      const query = rawSearch;

      // Tabs (categorisation) support
      const tabsBy = config.tabsby || null; // field name to filter by
      let tabsValues = Array.isArray(config.tabsValues)
        ? config.tabsValues
        : [];
      const tabsDynamic = !!config.tabsDynamic;
      const requestedTab = req.query.tab || null;
      // For dynamic tabs, defer activeTab validation until after distinct query
      let activeTab = null;
      if (requestedTab) {
        if (String(requestedTab).toLowerCase() === "all") {
          activeTab = requestedTab;
        } else if (tabsDynamic) {
          // Accept any non-empty tab value; will be validated after distinct query
          activeTab = requestedTab;
        } else if (tabsValues.some((tv) => String(tv.value) === String(requestedTab))) {
          activeTab = requestedTab;
        }
      }

      let mongoFilter = {};
      if (query) {
        const searchFields =
          Array.isArray(config.searchFields) && config.searchFields.length
            ? config.searchFields
            : [config.linkField || "title"];
        const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(escaped, "i");
        const orConds = [];
        for (const f of searchFields) {
          // Type-aware search: use numeric equality for number fields, regex for strings
          const pathInfo = model?.schema?.path?.(f) || null;
          const instance = pathInfo ? pathInfo.instance : null; // 'Number', 'String', etc.
          if (instance === "Number") {
            const n = Number(query);
            if (!Number.isNaN(n)) {
              orConds.push({ [f]: n });
            }
            // Skip non-numeric queries for numeric fields to avoid cast errors
          } else if (
            instance === "String" ||
            instance === "Mixed" ||
            !instance
          ) {
            // Default to regex for strings or unknown types
            orConds.push({ [f]: regex });
          }
        }
        if (orConds.length) mongoFilter.$or = orConds;
      }

      if (tabsBy && activeTab) {
        // Special case: a tab value of 'all' should clear the filter but remain selectable
        if (String(activeTab).toLowerCase() === "all") {
          // Do not modify mongoFilter
        } else {
          const orConds = [];
          const tabsPath = model?.schema?.path?.(tabsBy) || null;
          const tabsType = tabsPath ? tabsPath.instance : null; // 'Number', 'String', etc.
          const nameField = `${tabsBy}Name`;
          const hasNameField = !!model?.schema?.path?.(nameField);

          const numVal = Number(activeTab);
          if (tabsType === "Number" && !Number.isNaN(numVal)) {
            orConds.push({ [tabsBy]: numVal });
          }
          if (tabsType === "String") {
            orConds.push({ [tabsBy]: activeTab });
          }
          if (hasNameField) {
            orConds.push({ [nameField]: activeTab });
          }
          // Fallback for Mixed types or dot-notation paths (e.g. Category.Name)
          if (!orConds.length) {
            orConds.push({ [tabsBy]: activeTab });
          }

          if (orConds.length) {
            const tabsFilter =
              orConds.length === 1 ? orConds[0] : { $or: orConds };
            if (Object.keys(mongoFilter).length > 0) {
              mongoFilter = { $and: [mongoFilter, tabsFilter] };
            } else {
              mongoFilter = tabsFilter;
            }
          }
        }
      }

      const layout = req.query.layout || config.layout || 'table';

      try {
        // ── Data scoping: restrict results based on user role + linked entity ──
        if (req.user) {
          const ownerFilter = await scopeQuery(req, modelName, "l");
          if (ownerFilter === null) {
            return res.status(403).render(path.join("mongoose", "error"));
          }
          if (Object.keys(ownerFilter).length > 0) {
            if (Object.keys(mongoFilter).length > 0) {
              mongoFilter = { $and: [mongoFilter, ownerFilter] };
            } else {
              mongoFilter = { ...mongoFilter, ...ownerFilter };
            }
          }
        }

        const totalCount = await model.countDocuments(mongoFilter);
        // Build tab metadata
        let tabs = [];
        if (tabsDynamic && tabsBy && !tabsValues.length) {
          // Fetch distinct values from the database for dynamic tabs
          const distinctVals = await model.distinct(tabsBy);
          const sorted = distinctVals
            .filter((v) => v != null && String(v).trim() !== "")
            .map(String)
            .sort((a, b) => a.localeCompare(b));
          tabsValues = [
            { value: "all", label: "All" },
            ...sorted.map((v) => ({ value: v, label: v })),
          ];
          // Re-validate activeTab against the actual values
          if (
            activeTab &&
            String(activeTab).toLowerCase() !== "all" &&
            !sorted.includes(activeTab)
          ) {
            activeTab = null;
          }
        }
        if (tabsValues.length) {
          tabs = tabsValues.map((tv) => ({
            value: tv.value,
            label: tv.label || String(tv.value),
            isActive: String(tv.value) === String(activeTab),
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

        // Flatten nested data objects (e.g., when hcs-sync stores { number, data: {...}, syncedAt })
        if (config.flattenField) {
          const ff = config.flattenField;
          items = items.map((item) => {
            const nested = item[ff];
            if (
              nested &&
              typeof nested === "object" &&
              !Array.isArray(nested)
            ) {
              const { [ff]: _, ...rest } = item;
              return { ...rest, ...nested };
            }
            return item;
          });
        }

        if (!items.length) {
          return res.render(path.join("tailwindcss", "partials", "listTable"), {
            title: config.title || capitalize(modelName) + "s",
            headers: [],
            rows: [],
            basePath: modelName,
            modelName: modelName, // for template usage
            linkField: config.linkField || "title",
            limit,
            page,
            totalPages,
            query,
            reqQuery: req.query,
            actions: config.actions || [],
            headerActions: config.headerActions || [],
            fieldLinks: config.fieldLinks || null,
            activeTab,
            tabsValues,
            tabsBy,
            tabs,
            layout,
          });
        }

        const headers = generateHeaders(items[0], config);

        // Hidden management
        const defaultHidden = ["_id", "__v"];
        const autoHideUnderscore = config.autoHideUnderscore !== false;
        const hidden = new Set([
          ...(config.hideFields || []),
          ...defaultHidden,
        ]);
        if (config.linkField) hidden.delete(config.linkField);
        const allowedKeys = new Set(headers.map((h) => h.key)); // already filtered

        // Optional field transforms (resolve references, map arrays, etc.)
        const transforms = config.fieldTransforms || {};

        // First pass: build cleaned rows and collect values to resolve for transforms
        const pendingLookups = {}; // field -> { keys:Set<string>, originals: Map<string, any> }
        items = items.map((row) => {
          const cleaned = {};
          for (const key of allowedKeys) cleaned[key] = row[key];
          if (autoHideUnderscore) {
            for (const k in cleaned) {
              if (k.startsWith("_") && !allowedKeys.has(k)) delete cleaned[k];
            }
          }
          if (row.uuid) cleaned.uuid = row.uuid;

          for (const [field, tConf] of Object.entries(transforms)) {
            if (!allowedKeys.has(field)) continue;
            const v = row[field];
            const ensureBucket = () => {
              if (!pendingLookups[field])
                pendingLookups[field] = {
                  keys: new Set(),
                  originals: new Map(),
                };
              return pendingLookups[field];
            };
            const addVal = (val) => {
              if (val === null || val === undefined) return;
              const key = String(val && val._id ? val._id : val);
              const bucket = ensureBucket();
              bucket.keys.add(key);
              if (!bucket.originals.has(key)) bucket.originals.set(key, val);
            };
            if (Array.isArray(v)) v.forEach(addVal);
            else addVal(v);
          }
          return cleaned;
        });

        // Resolve lookups per transform (one query per field)
        const resolvedMaps = {}; // field -> Map<string, matchedDoc>
        for (const [field, tConf] of Object.entries(transforms)) {
          try {
            const bucket = pendingLookups[field];
            if (!bucket || bucket.keys.size === 0) continue;
            const { keys, originals } = bucket;
            const fromModelName = tConf.fromModel;
            const matchFields = Array.isArray(tConf.matchField)
              ? tConf.matchField
              : [tConf.matchField || "_id"];
            const returnField = tConf.returnField || "name";
            const fromModel =
              (mdb.INTERNAL && mdb.INTERNAL[fromModelName]) ||
              (mdb.REST && mdb.REST[fromModelName]);
            if (!fromModel || typeof fromModel.find !== "function") continue;
            // Prepare values array with proper types (use originals to preserve ObjectId type when needed)
            const values = Array.from(keys).map((k) => originals.get(k));
            const or = matchFields.map((f) => ({ [f]: { $in: values } }));
            const filter = or.length === 1 ? or[0] : { $or: or };
            const docs = await fromModel.find(filter).lean();
            const index = new Map();
            docs.forEach((d) => {
              matchFields.forEach((f) => {
                if (typeof d[f] !== "undefined" && d[f] !== null) {
                  const k = String(d[f]);
                  if (!index.has(k)) index.set(k, d);
                }
              });
            });
            resolvedMaps[field] = {
              index,
              returnField,
              linkTo: tConf.linkTo,
              matchFields,
            };
          } catch (e) {
            logger.warn &&
              logger.warn(
                `[listController] transform lookup failed for field '${field}': ${e.message}`,
              );
          }
        }

        // Second pass: apply resolved display values and dynamic links per row
        items = items.map((row) => {
          if (!row) return row;
          const links = {};
          for (const [field, resolved] of Object.entries(resolvedMaps)) {
            if (!(field in row)) continue;
            const value = row[field];
            const { index, returnField, linkTo } = resolved;
            const resolveOne = (val) => {
              const key = String(val && val._id ? val._id : val);
              const matched = index.get(key);
              return matched
                ? matched[returnField]
                : typeof val === "string"
                  ? val
                  : "—";
            };
            if (Array.isArray(value)) {
              // Join display names; skip linking for arrays to avoid ambiguity
              row[field] = value.map(resolveOne).filter(Boolean).join(", ");
            } else {
              const key = String(value && value._id ? value._id : value);
              const matched = index.get(key);
              row[field] = resolveOne(value);
              if (matched && typeof linkTo === "function") {
                try {
                  links[field] = linkTo(matched);
                } catch (_) {}
              } else if (matched && typeof linkTo === "string") {
                links[field] = linkTo;
              }
            }
          }
          if (Object.keys(links).length) row.__links = links;
          return row;
        });

        // Combine static fieldLinks from config with dynamic links from transforms
        const dynamicFieldLinks = (row) => {
          const fromConfig =
            typeof config.fieldLinks === "function"
              ? config.fieldLinks(row)
              : config.fieldLinks;
          const dynamic = row && row.__links ? row.__links : null;
          return { ...(fromConfig || {}), ...(dynamic || {}) };
        };

        res.render(path.join("tailwindcss", "partials", "listTable"), {
          title: config.title || capitalize(modelName) + "s",
          headers,
          rows: items,
          basePath: modelName,
          modelName: modelName,
          linkField: config.linkField || "title",
          limit,
          page,
          totalPages,
          query,
          reqQuery: req.query,
          model: modelName,
          actions: config.actions || [],
          headerActions: config.headerActions || [],
          fieldLinks: dynamicFieldLinks,
          activeTab,
          tabsValues,
          tabsBy,
          tabs,
          layout,
        });
      } catch (err) {
        logger.error(`Error listing ${modelName}:`, err);
        next(err);
      }
    };
  }
});

// Support alias configs: entries with `aliasOf` point to an existing model but apply a baseFilter.
for (const [aliasName, aliasConfig] of Object.entries(listControllerConfig)) {
  if (!aliasConfig.aliasOf) continue;
  const functionName = `list${capitalize(aliasName)}`;
  if (listController[functionName]) continue; // already registered

  const targetModelName = aliasConfig.aliasOf;
  const model =
    (mdb.REST && mdb.REST[targetModelName]) ||
    (mdb.INTERNAL && mdb.INTERNAL[targetModelName]) ||
    (mdb.PAPERLESS && mdb.PAPERLESS[targetModelName]);
  if (!model || typeof model.find !== "function") {
    logger.warn &&
      logger.warn(
        `[listController] aliasOf target '${targetModelName}' not found for alias '${aliasName}'`,
      );
    continue;
  }

  const config = aliasConfig;
  if (denyGuard(config, "l")) continue;

  listController[functionName] = async (req, res, next) => {
    const rawSort = req.query.sort;
    const sortField = (rawSort && /^[a-zA-Z0-9_.]+$/.test(rawSort)) ? rawSort : (config.sortField || "createdAt");
    const sortOrder = req.query.order === 'asc' ? 1 : req.query.order === 'desc' ? -1 : (config.sortOrder ?? -1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 500);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const rawSearch = (req.query.search || "").trim();
    const query = rawSearch;

    const tabsBy = config.tabsby || null;
    const tabsValues = Array.isArray(config.tabsValues)
      ? config.tabsValues
      : [];
    const requestedTab = req.query.tab || null;
    const activeTab =
      requestedTab &&
      (String(requestedTab).toLowerCase() === "all" ||
        tabsValues.some((tv) => String(tv.value) === String(requestedTab)))
        ? requestedTab
        : null;

    // Start with the baseFilter so only matching docs are shown
    let mongoFilter = config.baseFilter ? { ...config.baseFilter } : {};

    if (query) {
      const searchFields =
        Array.isArray(config.searchFields) && config.searchFields.length
          ? config.searchFields
          : [config.linkField || "title"];
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, "i");
      const orConds = [];
      for (const f of searchFields) {
        const pathInfo = model?.schema?.path?.(f) || null;
        const instance = pathInfo ? pathInfo.instance : null;
        if (instance === "Number") {
          const n = Number(query);
          if (!Number.isNaN(n)) orConds.push({ [f]: n });
        } else if (instance === "String" || instance === "Mixed" || !instance) {
          orConds.push({ [f]: regex });
        }
      }
      if (orConds.length) {
        if (Object.keys(mongoFilter).length > 0) {
          mongoFilter = { $and: [mongoFilter, { $or: orConds }] };
        } else {
          mongoFilter.$or = orConds;
        }
      }
    }

    if (tabsBy && activeTab) {
      if (String(activeTab).toLowerCase() !== "all") {
        const orConds = [];
        const tabsPath = model?.schema?.path?.(tabsBy) || null;
        const tabsType = tabsPath ? tabsPath.instance : null;
        const nameField = `${tabsBy}Name`;
        const hasNameField = !!model?.schema?.path?.(nameField);
        const numVal = Number(activeTab);
        if (tabsType === "Number" && !Number.isNaN(numVal))
          orConds.push({ [tabsBy]: numVal });
        if (tabsType === "String") orConds.push({ [tabsBy]: activeTab });
        if (hasNameField) orConds.push({ [nameField]: activeTab });
        if (orConds.length) {
          const tabsFilter =
            orConds.length === 1 ? orConds[0] : { $or: orConds };
          if (Object.keys(mongoFilter).length > 0) {
            mongoFilter = { $and: [mongoFilter, tabsFilter] };
          } else {
            mongoFilter = tabsFilter;
          }
        }
      }
    }

    const layout = req.query.layout || config.layout || 'table';

    try {
      const totalCount = await model.countDocuments(mongoFilter);
      let tabs = [];
      if (tabsValues.length) {
        tabs = tabsValues.map((tv) => ({
          value: tv.value,
          label: tv.label || String(tv.value),
          isActive: String(tv.value) === String(activeTab),
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

      // Flatten nested data objects (e.g., when hcs-sync stores { number, data: {...}, syncedAt })
      if (config.flattenField) {
        const ff = config.flattenField;
        items = items.map((item) => {
          const nested = item[ff];
          if (nested && typeof nested === "object" && !Array.isArray(nested)) {
            const { [ff]: _, ...rest } = item;
            return { ...rest, ...nested };
          }
          return item;
        });
      }

      if (!items.length) {
        return res.render(path.join("tailwindcss", "partials", "listTable"), {
          title: config.title || capitalize(aliasName) + "s",
          headers: [],
          rows: [],
          basePath: config.basePath || aliasName,
          modelName: aliasName,
          linkField: config.linkField || "title",
          limit,
          page,
          totalPages,
          query,
          reqQuery: req.query,
          model: aliasName,
          actions: config.actions || [],
          headerActions: config.headerActions || [],
          fieldLinks: config.fieldLinks || null,
          activeTab,
          tabsValues,
          tabsBy,
          tabs,
          layout,
        });
      }

      const headers = generateHeaders(items[0], config);
      const defaultHidden = ["_id", "__v"];
      const autoHideUnderscore = config.autoHideUnderscore !== false;
      const hidden = new Set([...(config.hideFields || []), ...defaultHidden]);
      if (config.linkField) hidden.delete(config.linkField);
      const allowedKeys = new Set(headers.map((h) => h.key));
      const transforms = config.fieldTransforms || {};
      const pendingLookups = {};

      items = items.map((row) => {
        const cleaned = {};
        for (const key of allowedKeys) cleaned[key] = row[key];
        if (autoHideUnderscore) {
          for (const k in cleaned) {
            if (k.startsWith("_") && !allowedKeys.has(k)) delete cleaned[k];
          }
        }
        if (row.uuid) cleaned.uuid = row.uuid;
        for (const [field, tConf] of Object.entries(transforms)) {
          if (!allowedKeys.has(field)) continue;
          const v = row[field];
          const ensureBucket = () => {
            if (!pendingLookups[field])
              pendingLookups[field] = { keys: new Set(), originals: new Map() };
            return pendingLookups[field];
          };
          const addVal = (val) => {
            if (val === null || val === undefined) return;
            const key = String(val && val._id ? val._id : val);
            const bucket = ensureBucket();
            bucket.keys.add(key);
            if (!bucket.originals.has(key)) bucket.originals.set(key, val);
          };
          if (Array.isArray(v)) v.forEach(addVal);
          else addVal(v);
        }
        return cleaned;
      });

      const resolvedMaps = {};
      for (const [field, tConf] of Object.entries(transforms)) {
        try {
          const bucket = pendingLookups[field];
          if (!bucket || bucket.keys.size === 0) continue;
          const { keys, originals } = bucket;
          const fromModelName = tConf.fromModel;
          const matchFields = Array.isArray(tConf.matchField)
            ? tConf.matchField
            : [tConf.matchField || "_id"];
          const returnField = tConf.returnField || "name";
          const fromModel =
            (mdb.INTERNAL && mdb.INTERNAL[fromModelName]) ||
            (mdb.REST && mdb.REST[fromModelName]);
          if (!fromModel || typeof fromModel.find !== "function") continue;
          const values = Array.from(keys).map((k) => originals.get(k));
          const or = matchFields.map((f) => ({ [f]: { $in: values } }));
          const filter = or.length === 1 ? or[0] : { $or: or };
          const docs = await fromModel.find(filter).lean();
          const index = new Map();
          docs.forEach((d) => {
            matchFields.forEach((f) => {
              if (typeof d[f] !== "undefined" && d[f] !== null) {
                const k = String(d[f]);
                if (!index.has(k)) index.set(k, d);
              }
            });
          });
          resolvedMaps[field] = {
            index,
            returnField,
            linkTo: tConf.linkTo,
            matchFields,
          };
        } catch (e) {
          logger.warn &&
            logger.warn(
              `[listController] transform lookup failed for field '${field}': ${e.message}`,
            );
        }
      }

      items = items.map((row) => {
        if (!row) return row;
        const links = {};
        for (const [field, resolved] of Object.entries(resolvedMaps)) {
          if (!(field in row)) continue;
          const value = row[field];
          const { index, returnField, linkTo } = resolved;
          const resolveOne = (val) => {
            const key = String(val && val._id ? val._id : val);
            const matched = index.get(key);
            return matched
              ? matched[returnField]
              : typeof val === "string"
                ? val
                : "—";
          };
          if (Array.isArray(value)) {
            row[field] = value.map(resolveOne).filter(Boolean).join(", ");
          } else {
            const key = String(value && value._id ? value._id : value);
            const matched = index.get(key);
            row[field] = resolveOne(value);
            if (matched && typeof linkTo === "function") {
              try {
                links[field] = linkTo(matched);
              } catch (_) {}
            } else if (matched && typeof linkTo === "string") {
              links[field] = linkTo;
            }
          }
        }
        if (Object.keys(links).length) row.__links = links;
        return row;
      });

      const dynamicFieldLinks = (row) => {
        const fromConfig =
          typeof config.fieldLinks === "function"
            ? config.fieldLinks(row)
            : config.fieldLinks;
        const dynamic = row && row.__links ? row.__links : null;
        return { ...(fromConfig || {}), ...(dynamic || {}) };
      };

      res.render(path.join("tailwindcss", "partials", "listTable"), {
        title: config.title || capitalize(aliasName) + "s",
        headers,
        rows: items,
        basePath: config.basePath || aliasName,
        modelName: aliasName,
        linkField: config.linkField || "title",
        limit,
        page,
        totalPages,
        query,
        reqQuery: req.query,
        model: aliasName,
        actions: config.actions || [],
        headerActions: config.headerActions || [],
        fieldLinks: dynamicFieldLinks,
        activeTab,
        tabsValues,
        tabsBy,
        tabs,
        layout,
      });
    } catch (err) {
      logger.error(`Error listing ${aliasName}:`, err);
      next(err);
    }
  };
}

module.exports = listController;
