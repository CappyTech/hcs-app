import registry from '../config/overviews/index.js';
import listControllerConfig from '../config/listControllerConfig.js';

/**
 * A list page's settings: the older listControllerConfig entry, with the
 * overview node's `list` definition (config/overviews, or Overview settings)
 * on top. The definition may set:
 *   columns  [{ field, label }]                   — read by listController.generateHeaders
 *   sort     { field: 1 | -1 }                    — the default order
 *   tabs     { by, values: [{ value, label }] }   — 'All' is added in front; false = no tabs
 *            (not null: in a stored change, null means "back to the default")
 *   filters  [{ field, label, type, options? }]   — type select | boolean | daterange | numberrange
 * Anything it leaves out still comes from listControllerConfig (links, layout,
 * search fields, header actions, department…).
 */

const ALL_TAB = { value: 'all', label: 'All' };

/** Apply a node's list definition to a listControllerConfig entry. */
function withListControls(config = {}, listName) {
  const list = listName ? registry.getNodeForList(listName)?.list : null;
  if (!list) return config;
  const out = { ...config };
  if (list.sort && typeof list.sort === 'object') {
    const [entry] = Object.entries(list.sort);
    if (entry) { out.sortField = entry[0]; out.sortOrder = entry[1]; }
  }
  if (list.tabs !== undefined && list.tabs !== null) {
    delete out.tabsDynamic;
    if (list.tabs) {
      out.tabsby = list.tabs.by;
      out.tabsValues = [ALL_TAB, ...(list.tabs.values || []).filter((v) => String(v.value).toLowerCase() !== 'all')];
    } else {
      delete out.tabsby;
      delete out.tabsValues;
    }
  }
  if (list.filters !== undefined) out.filters = list.filters || [];
  return out;
}

/** The effective settings for a list by name (model or alias). */
function listConfig(listName) {
  return withListControls(listControllerConfig[listName] || {}, listName);
}

function controlsOf(cfg) {
  const tabs = cfg.tabsby && !cfg.tabsDynamic
    ? { by: cfg.tabsby, values: (cfg.tabsValues || []).filter((v) => String(v.value).toLowerCase() !== 'all').map((v) => ({ value: v.value, label: v.label })) }
    : null;
  return {
    sort: { [cfg.sortField || 'createdAt']: cfg.sortOrder ?? -1 },
    tabs,
    dynamicTabs: !!cfg.tabsDynamic,
    filters: (cfg.filters || []).map((f) => ({ field: f.field, label: f.label, type: f.type, ...(f.options ? { options: f.options.map((o) => ({ value: o.value, label: o.label })) } : {}) })),
  };
}

/** What a list uses now (with any stored change), in definition form, for the editor. */
function currentControls(listName) { return controlsOf(listConfig(listName)); }

/** What a list would use without a definition: the listControllerConfig values. */
function baseControls(listName) { return controlsOf(listControllerConfig[listName] || {}); }

export default { withListControls, listConfig, currentControls, baseControls };
export { withListControls, listConfig, currentControls, baseControls };
