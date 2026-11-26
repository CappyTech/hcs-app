/**
 * moduleService — which optional modules this company has switched on.
 *
 * The modules and what each one owns are in mongoose/config/modulesConfig.js.
 * This answers the questions the rest of the app asks of it:
 *
 *   isEnabled(id)            is the module on (and everything it needs)?
 *   isPathEnabled(path)      may this URL be served at all?
 *   isModelEnabled(model)    are this model's pages available?
 *   isDepartmentEnabled(slug), isHelpEnabled(id), isJobEnabled(name)
 *
 * Settings are read on every call (configService, so the managed store wins
 * over the environment), so switching a module applies on the next request
 * without a restart. The path and model tables are built once.
 *
 * Imported by rolePermissionsConfig, so it must not import anything that
 * imports that file back (listControllerConfig does): generic list paths are
 * derived with the default rule here, and modulesConfig lists the few
 * overridden ones as paths.
 */

import configService from './configService.js';
import MODULES from '../mongoose/config/modulesConfig.js';

const byId = new Map(MODULES.map((m) => [m.id, m]));

/** MODULE_HEALTH_SAFETY for 'health-safety'. */
export function configKey(id) {
  return `MODULE_${String(id).replace(/[^a-z0-9]+/gi, '_').toUpperCase()}`;
}

const OFF = /^(false|0|off|no)$/i;

/** Switched on in configuration (ignoring what it requires). On unless set off. */
function switchedOn(id) {
  const raw = configService.get(configKey(id), '');
  return !OFF.test(String(raw ?? '').trim());
}

/**
 * Is a module on? Unknown ids are core, so on. A module is off when it is
 * switched off or anything it requires is off.
 */
export function isEnabled(id, seen = new Set()) {
  const mod = byId.get(id);
  if (!mod) return true;
  if (!switchedOn(id)) return false;
  if (seen.has(id)) return true; // a requires-cycle would be a config error; don't loop
  seen.add(id);
  return (mod.requires || []).every((r) => isEnabled(r, seen));
}

/** The modules that are off, as config objects. */
export function disabledModules() {
  return MODULES.filter((m) => !isEnabled(m.id));
}

/** Why a module is off: 'switched-off', or the id of the required module that is off. */
export function offReason(id) {
  if (!switchedOn(id)) return 'switched-off';
  const mod = byId.get(id);
  return (mod?.requires || []).find((r) => !isEnabled(r)) || null;
}

// ── Lookup tables, built once ──────────────────────────────────────────────

let tables = null;
function build() {
  const prefixes = [];
  const models = new Map();
  const departments = new Map();
  const help = new Map();
  const jobs = new Map();
  const add = (map, key, id) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(id);
  };
  for (const m of MODULES) {
    for (const p of m.paths || []) prefixes.push({ prefix: p.toLowerCase(), id: m.id });
    for (const model of m.models || []) {
      const lower = model.toLowerCase();
      add(models, lower, m.id);
      // The generic CRUD page, the generic list (default rule) and its overview.
      prefixes.push({ prefix: `/${lower}`, id: m.id });
      prefixes.push({ prefix: `/${lower}s`, id: m.id });
      prefixes.push({ prefix: `/overview/${lower}`, id: m.id });
    }
    for (const d of m.departments || []) add(departments, d, m.id);
    for (const h of m.help || []) add(help, h, m.id);
    for (const j of m.jobs || []) add(jobs, j, m.id);
  }
  tables = { prefixes, models, departments, help, jobs };
  return tables;
}
const t = () => tables || build();

/** The ids of the modules that own a URL path (usually none: core). */
export function modulesForPath(path) {
  if (!path) return [];
  let p = String(path).split(/[?#]/)[0].toLowerCase();
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  const ids = new Set();
  for (const { prefix, id } of t().prefixes) {
    if (p === prefix || p.startsWith(`${prefix}/`)) ids.add(id);
  }
  return [...ids];
}

const allOn = (ids) => !ids || ids.every((id) => isEnabled(id));

/** May this path be served? False when any module that owns it is off. */
export function isPathEnabled(path) {
  return allOn(modulesForPath(path));
}

export function isModelEnabled(model) {
  return allOn(model ? t().models.get(String(model).toLowerCase()) : null);
}

export function isDepartmentEnabled(slug) {
  return allOn(t().departments.get(slug));
}

export function isHelpEnabled(id) {
  return allOn(t().help.get(id));
}

export function isJobEnabled(name) {
  return allOn(t().jobs.get(name));
}

function offModulesFor(path) {
  return modulesForPath(path).filter((id) => !isEnabled(id));
}

function offMessage(off) {
  const labels = off.map((id) => byId.get(id)?.label || id).join(', ');
  return `${labels} is switched off for this company. An administrator can switch it on under Admin → Configuration → Modules.`;
}

/**
 * Express middleware for machine endpoints (/api/...): a JSON 404 for any
 * that belong to a module that is off. Mounted ahead of authentication, so a
 * webhook or the website's content API stops too.
 */
export function apiGate(req, res, next) {
  if (!String(req.path).toLowerCase().startsWith('/api/')) return next();
  const off = offModulesFor(req.path);
  if (!off.length) return next();
  return res.status(404).json({ error: 'not_found', message: offMessage(off) });
}

/**
 * Express middleware for pages: 404 through the normal error page for any
 * path owned by a module that is off. Mounted after the per-request view
 * locals, which the error page's layout needs.
 */
export function gate(req, res, next) {
  const off = offModulesFor(req.path);
  if (!off.length) return next();
  // error.ejs shows the message for this name instead of "doesn't exist".
  return next({ statusCode: 404, name: 'ModuleOffError', message: offMessage(off) });
}

/** Test hook: rebuild the lookup tables. */
export function _resetForTests() {
  tables = null;
}

export { MODULES };

export default {
  MODULES, configKey, isEnabled, disabledModules, offReason, modulesForPath,
  isPathEnabled, isModelEnabled, isDepartmentEnabled, isHelpEnabled, isJobEnabled,
  gate, apiGate, _resetForTests,
};
