'use strict';

/**
 * configValidatorService — boot-time sanity check for the metadata-driven
 * list/CRUD config.
 *
 * The list & CRUD engines read config as plain objects, so a mistyped option
 * key or a stale model entry fails SILENTLY (undefined, no error). This turns
 * that silent rot into a startup warning:
 *
 *   1. Unknown option keys — a key not in the engine's known vocabulary
 *      (typo, or an option that was removed). Guards against `hideFileds`.
 *   2. Stale model entries — a config key that doesn't resolve to any
 *      registered Mongoose model (accounting for aliases + singular/plural).
 *
 * Curated allowlists are the single source of truth for valid option keys:
 * when you add a new option to a config engine, add it here too. Deliberately
 * NOT auto-derived from current usage (that would bless an existing typo).
 *
 * Non-fatal by design: it logs warnings and returns them; it never blocks boot.
 */

const logger = require('../../services/loggerService');

// Options honoured by listController (+ CRUDController's merged reads).
const KNOWN_LIST_KEYS = new Set([
  'title', 'description', 'layout', 'linkField',
  'hideFields', 'fieldOrder', 'strictOrder', 'labelOverrides',
  'sortField', 'sortOrder', 'deny', 'department',
  'filters', 'fieldTransforms', 'referenceFilters',
  'tabsby', 'tabsValues', 'tabsDynamic',
  'headerActions', 'baseFilter', 'aliasOf',
  'readView', 'readLocals', 'searchFields', 'handlesDocuments',
  'pathOverride', 'basePath',
]);

// Options honoured by CRUDController.
const KNOWN_CRUD_KEYS = new Set([
  'title', 'description',
  'middleware', 'readOnly', 'validators', 'ownershipFields',
  'referenceFilters', 'referenceLabelFormat', 'xorGroups',
  'labelOverrides', 'hideFields', 'fieldOrder', 'strictOrder', 'fieldTransforms',
  'beforeCreate', 'afterCreate', 'afterUpdate', 'useSave',
  'readView', 'readLocals', 'updateView', 'updateLocals',
]);

// Config keys that are intentionally NOT model names (special/fallback blocks).
// They are still option-key validated, just exempt from the model-existence check.
const RESERVED_KEYS = new Set(['default']);

/** Normalise a name for comparison: lowercase, strip a trailing plural 's'. */
function norm(name) {
  return String(name || '').toLowerCase();
}
function variants(name) {
  const l = norm(name);
  const set = new Set([l]);
  if (l.endsWith('s')) set.add(l.slice(0, -1)); // plural → singular
  else set.add(l + 's');                        // singular → plural
  return set;
}

/** Does `key` resolve to a registered model name (case/plural-insensitive)? */
function resolvesToModel(key, registeredLower) {
  for (const v of variants(key)) if (registeredLower.has(v)) return true;
  return false;
}

/**
 * @param {object} opts
 * @param {object} opts.listConfig  listControllerConfig
 * @param {object} opts.crudConfig  CRUDControllerConfig
 * @param {string[]} opts.modelNames  every registered model name (all namespaces)
 * @returns {string[]} warnings
 */
function validate({ listConfig = {}, crudConfig = {}, modelNames = [] }) {
  const warnings = [];
  const registeredLower = new Set(modelNames.map(norm));

  const checkEntry = (source, name, entry, knownKeys) => {
    if (!entry || typeof entry !== 'object') return;
    for (const key of Object.keys(entry)) {
      if (!knownKeys.has(key)) {
        warnings.push(`${source}."${name}": unknown option "${key}" (typo or removed option?)`);
      }
    }
  };

  const checkModel = (source, name, entry) => {
    if (RESERVED_KEYS.has(name)) return; // special block, not a model
    // Aliases point at another model via aliasOf; validate the target instead.
    const target = (entry && entry.aliasOf) || name;
    if (!resolvesToModel(target, registeredLower)) {
      const via = entry && entry.aliasOf ? ` (aliasOf "${entry.aliasOf}")` : '';
      warnings.push(`${source}: "${name}"${via} does not match any registered model`);
    }
  };

  for (const [name, entry] of Object.entries(listConfig)) {
    checkEntry('listControllerConfig', name, entry, KNOWN_LIST_KEYS);
    checkModel('listControllerConfig', name, entry);
  }
  for (const [name, entry] of Object.entries(crudConfig)) {
    checkEntry('CRUDControllerConfig', name, entry, KNOWN_CRUD_KEYS);
    checkModel('CRUDControllerConfig', name, entry);
  }

  return warnings;
}

/**
 * Validate the real configs against the registered models and log any warnings.
 * Call once at startup after models load. Never throws.
 */
function validateAtStartup(mdb) {
  try {
    const listConfig = require('../config/listControllerConfig');
    const crudConfig = require('../config/CRUDControllerConfig');
    const modelNames = ['INTERNAL', 'REST', 'PAPERLESS']
      .flatMap((ns) => Object.keys((mdb && mdb[ns]) || {}));
    const warnings = validate({ listConfig, crudConfig, modelNames });
    if (warnings.length) {
      logger.warn(`[configValidator] ${warnings.length} config issue(s):\n  - ${warnings.join('\n  - ')}`);
    } else {
      logger.info('[configValidator] list/CRUD config OK');
    }
    return warnings;
  } catch (err) {
    logger.warn(`[configValidator] validation skipped: ${err.message}`);
    return [];
  }
}

module.exports = { validate, validateAtStartup, KNOWN_LIST_KEYS, KNOWN_CRUD_KEYS };
