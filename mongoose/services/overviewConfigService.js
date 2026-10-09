import mdb from './mongooseDatabaseService.js';
import registry from '../config/overviews/index.js';
import logger from '../../services/loggerService.js';
import overviewEngine from './overviewEngine.js';

/**
 * Stores a company's changes to the overview hierarchy and keeps the registry
 * up to date. Code definitions are the defaults; the INTERNAL `overviewConfig`
 * collection holds overrides (or whole custom areas/nodes). load() runs at
 * startup; save()/reset() validate, store, and re-apply immediately.
 *
 * Anything stored here becomes a database query on someone's page, so an
 * override is checked strictly before it's saved:
 *   • only known keys, with the right shapes;
 *   • filter fields must exist on the model; operators come from a fixed list;
 *     nothing that runs code ($where, $function, $expr, $regex…) is accepted;
 *   • the merged hierarchy must still validate (no broken references).
 * Code defaults may use more (e.g. $expr, custom panels); overrides may not
 * add them, but they leave a default's own filter alone unless they replace it.
 */

const ROLES = ['admin', 'accountant', 'employee', 'subcontractor', 'client', 'hmrc', 'none', 'auditor'];
// Operators an override may use in a filter. Everything else is refused.
const SAFE_OPS = new Set(['$eq', '$ne', '$in', '$nin', '$gt', '$gte', '$lt', '$lte', '$exists',
  '$withinNextDays', '$withinPastDays', '$notAfterDays', '$beforeNow', '$afterNow', '$set', '$me', '$currentTaxYear']);
const LOGIC_OPS = new Set(['$and', '$or']);
const SEVERITIES = ['critical', 'warning'];
const FORMATS = ['date', 'money'];
const ICON = /^bi-[a-z0-9-]{1,40}$/;
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PATH = /^\/[A-Za-z0-9/_-]{0,120}$/;

function modelFor(name) {
  for (const ns of ['INTERNAL', 'REST', 'PAPERLESS']) {
    const m = mdb[ns]?.[name];
    if (m && typeof m.find === 'function') return m;
  }
  return null;
}

// Does `field` exist on the model? Accepts nested paths ('contract.endDate')
// and subdocument/array paths ('totals.grossPay', 'Category.Name').
function fieldExists(model, field) {
  const schema = model?.schema;
  if (!schema || typeof field !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.]{0,80}$/.test(field)) return false;
  if (schema.path(field) || schema.pathType(field) === 'nested') return true;
  const parts = field.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const p = schema.path(parts.slice(0, i).join('.'));
    if (p && (p.instance === 'Mixed' || p.instance === 'Array' || p.schema)) return true;
  }
  return false;
}

class OverrideError extends Error {}
const fail = (msg) => { throw new OverrideError(msg); };

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const text = (v, max, what) => { if (typeof v !== 'string' || !v.trim() || v.length > max) fail(`${what} must be text (up to ${max} characters).`); };

function checkValue(v, where) {
  if (isScalar(v)) return;
  if (Array.isArray(v) && v.length <= 50 && v.every(isScalar)) return;
  fail(`${where}: values must be plain text, numbers, true/false, or a short list of those.`);
}

function checkWhere(where, model, at) {
  if (!isPlain(where)) fail(`${at}: a filter must be an object.`);
  for (const [k, v] of Object.entries(where)) {
    if (LOGIC_OPS.has(k)) {
      if (!Array.isArray(v) || !v.length || v.length > 10) fail(`${at}: ${k} needs a list of up to 10 conditions.`);
      v.forEach((c, i) => checkWhere(c, model, `${at}.${k}[${i}]`));
      continue;
    }
    if (k.startsWith('$')) fail(`${at}: "${k}" isn't allowed in a stored filter.`);
    if (!fieldExists(model, k)) fail(`${at}: "${k}" isn't a field of ${model.modelName}.`);
    if (isPlain(v)) {
      for (const [op, arg] of Object.entries(v)) {
        if (!SAFE_OPS.has(op)) fail(`${at}.${k}: "${op}" isn't allowed in a stored filter.`);
        if (['$withinNextDays', '$withinPastDays', '$notAfterDays'].includes(op) && !(Number.isInteger(arg) && Math.abs(arg) <= 3650)) {
          fail(`${at}.${k}: ${op} needs a whole number of days (up to 3650).`);
        }
        checkValue(arg, `${at}.${k}.${op}`);
      }
    } else {
      checkValue(v, `${at}.${k}`);
    }
  }
}

function checkFigure(fig, model, at) {
  if (fig === null) return; // removes a default figure
  if (!isPlain(fig)) fail(`${at}: a figure must be an object.`);
  for (const k of Object.keys(fig)) {
    if (!['label', 'hint', 'severity', 'where', 'sum', 'format', 'unit'].includes(k)) fail(`${at}: "${k}" isn't a figure setting.`);
  }
  if (fig.label !== undefined) text(fig.label, 120, `${at} label`);
  if (fig.hint !== undefined && fig.hint !== null) text(fig.hint, 200, `${at} hint`);
  if (fig.severity !== undefined && fig.severity !== null && !SEVERITIES.includes(fig.severity)) fail(`${at}: severity must be critical or warning.`);
  if (fig.where !== undefined) checkWhere(fig.where, model, `${at}.where`);
  if (fig.sum !== undefined && fig.sum !== null) {
    if (typeof fig.sum !== 'string' || !fieldExists(model, fig.sum)) fail(`${at}: a total must be a field of ${model.modelName}.`);
  }
  if (fig.format !== undefined && fig.format !== null && fig.format !== 'money') fail(`${at}: format must be money.`);
  if (fig.unit !== undefined && fig.unit !== null) text(fig.unit, 10, `${at} unit`);
}

function checkColumns(cols, model, at) {
  if (!Array.isArray(cols) || !cols.length || cols.length > 8) fail(`${at}: a list needs 1 to 8 columns.`);
  cols.forEach((c, i) => {
    if (!isPlain(c)) fail(`${at}[${i}]: a column must be an object.`);
    for (const k of Object.keys(c)) if (!['field', 'label', 'format', 'ref', 'minus'].includes(k)) fail(`${at}[${i}]: "${k}" isn't a column setting.`);
    if (!fieldExists(model, c.field)) fail(`${at}[${i}]: "${c.field}" isn't a field of ${model.modelName}.`);
    text(c.label, 60, `${at}[${i}] label`);
    if (c.format !== undefined && !FORMATS.includes(c.format)) fail(`${at}[${i}]: format must be date or money.`);
    if (c.minus !== undefined && !fieldExists(model, c.minus)) fail(`${at}[${i}]: "${c.minus}" isn't a field of ${model.modelName}.`);
    if (c.ref !== undefined) {
      const refModel = isPlain(c.ref) ? modelFor(c.ref.model) : null;
      if (!refModel || !fieldExists(refModel, c.ref.field)) fail(`${at}[${i}]: the linked record and field must exist.`);
    }
  });
}

const figureRefOk = (r) => typeof r === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}(\.[A-Za-z][A-Za-z0-9_-]{0,63})?$/.test(r);

function checkNodeOverride(key, ov, { custom, base, customPanels }) {
  const model = modelFor(ov.model ?? base?.model);
  const allowed = ['label', 'icon', 'description', 'parents', 'summary', 'figures', 'overview', 'actions', 'hidden'];
  // Only a node that doesn't exist in code may set where it lives and what it lists
  if (custom) allowed.push('model', 'listPath', 'overviewPath', 'roles');
  for (const k of Object.keys(ov)) if (!allowed.includes(k)) fail(`${key}: "${k}" can't be changed here.`);

  if (custom) {
    if (!model) fail(`${key}: choose a model that exists.`);
    if (ov.listPath !== undefined && !PATH.test(ov.listPath)) fail(`${key}: the list path must start with / and use plain characters.`);
    if (ov.overviewPath !== undefined && ov.overviewPath !== `/overview/${key}`) fail(`${key}: its overview path must be /overview/${key}.`);
    if (ov.roles !== undefined && (!Array.isArray(ov.roles) || !ov.roles.every((r) => ROLES.includes(r)))) fail(`${key}: roles must come from the role list.`);
  }
  if (ov.label !== undefined) {
    if (!isPlain(ov.label)) fail(`${key}: label needs a singular and a plural.`);
    text(ov.label.one, 60, `${key} label`); text(ov.label.many, 60, `${key} label`);
  }
  if (ov.icon !== undefined && !ICON.test(ov.icon)) fail(`${key}: icon must be a Bootstrap icon name like bi-people.`);
  if (ov.description !== undefined) text(ov.description, 300, `${key} description`);
  if (ov.hidden !== undefined && typeof ov.hidden !== 'boolean') fail(`${key}: hidden must be true or false.`);
  if (ov.parents !== undefined && (!Array.isArray(ov.parents) || !ov.parents.every((p) => ID.test(p)))) fail(`${key}: parents must be a list of area or node ids.`);
  if (ov.summary !== undefined && (!Array.isArray(ov.summary) || ov.summary.length > 8 || !ov.summary.every(figureRefOk))) fail(`${key}: summary must be up to 8 figure references.`);
  if (ov.figures !== undefined) {
    if (!isPlain(ov.figures)) fail(`${key}: figures must be an object.`);
    if (!model) fail(`${key}: a group has no figures of its own.`);
    for (const [id, fig] of Object.entries(ov.figures)) {
      if (!ID.test(id)) fail(`${key}: "${id}" isn't a usable figure id.`);
      checkFigure(fig, model, `${key}.figures.${id}`);
      const merged = registry.mergeDef(base?.figures?.[id] || {}, fig || {});
      if (fig && !base?.figures?.[id] && (!merged.label || !merged.where)) fail(`${key}.figures.${id}: a new figure needs a label and a filter.`);
    }
  }
  if (ov.actions !== undefined) {
    if (!Array.isArray(ov.actions) || ov.actions.length > 4) fail(`${key}: up to 4 actions.`);
    ov.actions.forEach((a, i) => {
      if (!isPlain(a)) fail(`${key}.actions[${i}] must be an object.`);
      text(a.label, 40, `${key}.actions[${i}] label`);
      if (!PATH.test(a.href || '')) fail(`${key}.actions[${i}]: the link must be a path in this app.`);
      if (a.op !== undefined && !['c', 'r', 'u', 'l'].includes(a.op)) fail(`${key}.actions[${i}]: op must be c, r, u or l.`);
      if (a.route !== undefined && !PATH.test(a.route)) fail(`${key}.actions[${i}]: route must be a path.`);
      if (a.icon !== undefined && !ICON.test(a.icon)) fail(`${key}.actions[${i}]: bad icon.`);
    });
  }
  if (ov.overview !== undefined && ov.overview !== null) {
    const o = ov.overview;
    if (!isPlain(o)) fail(`${key}: overview must be an object.`);
    for (const k of Object.keys(o)) if (!['figures', 'breakdowns', 'lists', 'panels', 'related'].includes(k)) fail(`${key}.overview: "${k}" isn't an overview setting.`);
    for (const k of ['figures', 'related']) {
      if (o[k] !== undefined && (!Array.isArray(o[k]) || o[k].length > 12 || !o[k].every(figureRefOk))) fail(`${key}.overview.${k}: up to 12 figure references.`);
    }
    if (o.panels !== undefined) {
      if (!Array.isArray(o.panels) || !o.panels.every((p) => customPanels.includes(p))) fail(`${key}.overview.panels: only built-in panels can be used.`);
      // Panels carry their own access checks, but only where code placed them
      const basePanels = base?.overview?.panels || [];
      if (o.panels.some((p) => !basePanels.includes(p))) fail(`${key}.overview.panels: a panel can be removed or reordered here, not added.`);
    }
    if (o.breakdowns !== undefined) {
      if (!Array.isArray(o.breakdowns) || o.breakdowns.length > 6) fail(`${key}.overview.breakdowns: up to 6.`);
      o.breakdowns.forEach((b, i) => {
        if (!isPlain(b) || !model) fail(`${key}.overview.breakdowns[${i}] needs a model.`);
        text(b.label, 60, `${key}.overview.breakdowns[${i}] label`);
        if (!fieldExists(model, b.by)) fail(`${key}.overview.breakdowns[${i}]: "${b.by}" isn't a field of ${model.modelName}.`);
        if (b.where !== undefined) checkWhere(b.where, model, `${key}.overview.breakdowns[${i}].where`);
        if (b.labels !== undefined && (!isPlain(b.labels) || !Object.values(b.labels).every((l) => typeof l === 'string' && l.length <= 60))) fail(`${key}.overview.breakdowns[${i}]: labels must be text.`);
      });
    }
    if (o.lists !== undefined) {
      if (!Array.isArray(o.lists) || o.lists.length > 8) fail(`${key}.overview.lists: up to 8.`);
      o.lists.forEach((l, i) => {
        const at = `${key}.overview.lists[${i}]`;
        if (!isPlain(l)) fail(`${at} must be an object.`);
        for (const k of Object.keys(l)) if (!['figure', 'title', 'sort', 'limit', 'columns'].includes(k)) fail(`${at}: "${k}" isn't a list setting.`);
        if (!figureRefOk(l.figure)) fail(`${at}: a list shows the rows behind a figure.`);
        const fr = l.figure.includes('.') ? l.figure.split('.')[0] : key;
        const listModel = modelFor(registry.getNode(fr)?.model ?? (fr === key ? (ov.model ?? base?.model) : null));
        if (!listModel) fail(`${at}: its figure must belong to a model.`);
        if (l.title !== undefined) text(l.title, 80, `${at} title`);
        if (l.limit !== undefined && !(Number.isInteger(l.limit) && l.limit >= 1 && l.limit <= 25)) fail(`${at}: show 1 to 25 rows.`);
        if (l.sort !== undefined) {
          const entries = isPlain(l.sort) ? Object.entries(l.sort) : [];
          if (entries.length !== 1 || ![1, -1].includes(entries[0][1]) || !fieldExists(listModel, entries[0][0])) fail(`${at}: sort by one field, up or down.`);
        }
        checkColumns(l.columns, listModel, `${at}.columns`);
      });
    }
  }
}

function checkAreaOverride(key, ov, { custom }) {
  const allowed = ['label', 'icon', 'description', 'children', 'order', 'hidden'];
  if (custom) allowed.push('roles');
  for (const k of Object.keys(ov)) if (!allowed.includes(k)) fail(`${key}: "${k}" can't be changed here.`);
  if (ov.label !== undefined) text(ov.label, 60, `${key} label`);
  if (ov.icon !== undefined && !ICON.test(ov.icon)) fail(`${key}: icon must be a Bootstrap icon name like bi-people.`);
  if (ov.description !== undefined) text(ov.description, 300, `${key} description`);
  if (ov.children !== undefined && (!Array.isArray(ov.children) || ov.children.length > 12 || !ov.children.every((c) => ID.test(c)))) fail(`${key}: children must be up to 12 node ids.`);
  if (ov.order !== undefined && !(Number.isInteger(ov.order) && ov.order >= 0 && ov.order <= 999)) fail(`${key}: order must be a whole number from 0 to 999.`);
  if (ov.hidden !== undefined && typeof ov.hidden !== 'boolean') fail(`${key}: hidden must be true or false.`);
  if (custom) {
    if (!Array.isArray(ov.roles) || !ov.roles.length || !ov.roles.every((r) => ROLES.includes(r))) fail(`${key}: a new area needs the roles that may open it.`);
    if (!ov.label) fail(`${key}: a new area needs a name.`);
  }
}

/**
 * Validate one override against the current overrides. Returns the candidate
 * docs list (with this one applied) so save() can store and apply it.
 */
function validateOverride({ kind, key, override, custom = false }, currentDocs, { customPanels = [] } = {}) {
  if (!['area', 'node'].includes(kind)) fail('Kind must be area or node.');
  if (!ID.test(key || '')) fail('The id must start with a letter and use letters, numbers, - or _.');
  if (!isPlain(override)) fail('The change must be an object.');
  const defaults = registry.defaults();
  const base = kind === 'area' ? defaults.areas.find((a) => a.id === key) : defaults.nodes.find((n) => n.id === key);
  if (custom && base) fail(`"${key}" already exists; change it instead of creating it.`);
  if (!custom && !base) {
    const existingCustom = currentDocs.find((d) => d.kind === kind && d.key === key && d.custom);
    if (!existingCustom) fail(`There's no ${kind} called "${key}".`);
    custom = true;
  }
  if (kind === 'area') checkAreaOverride(key, override, { custom });
  else checkNodeOverride(key, override, { custom, base, customPanels });

  const docs = currentDocs.filter((d) => !(d.kind === kind && d.key === key)).concat([{ kind, key, custom, override }]);
  const problems = registry.validate(registry.buildState(docs));
  if (problems.length) fail(`That would break the overviews: ${problems.slice(0, 3).join('; ')}.`);
  return docs;
}

// ── Store ─────────────────────────────────────────────────────────────────
let docsCache = [];

async function load() {
  const Model = mdb.INTERNAL?.overviewConfig;
  if (!Model) return registry.applyOverrides([]);
  const docs = await Model.find({}).lean();
  const usable = [];
  for (const d of docs) {
    // A stored override that no longer fits (e.g. a field removed in an upgrade)
    // is skipped, not fatal: the defaults keep working and the editor shows it.
    try {
      validateOverride(d, usable, { customPanels: overviewEngine.customPanelNames() });
      usable.push({ kind: d.kind, key: d.key, custom: !!d.custom, override: d.override });
    } catch (err) {
      logger.warn(`[overviewConfig] Skipping stored ${d.kind} "${d.key}": ${err.message}`);
    }
  }
  docsCache = usable;
  registry.applyOverrides(usable);
  if (usable.length) logger.info(`[overviewConfig] Applied ${usable.length} overview change(s) from the database.`);
  return usable;
}

async function save({ kind, key, override, custom = false }, user) {
  const Model = mdb.INTERNAL?.overviewConfig;
  if (!Model) fail('The database isn\'t ready.');
  const docs = validateOverride({ kind, key, override, custom }, docsCache, { customPanels: overviewEngine.customPanelNames() });
  const stored = docs.find((d) => d.kind === kind && d.key === key);
  // Audit plugin records the change; findOne+save so it sees the document
  let doc = await Model.findOne({ kind, key });
  if (!doc) doc = new Model({ kind, key });
  doc.custom = stored.custom;
  doc.override = override;
  doc.updatedBy = user?._id || null;
  doc.markModified('override');
  await doc.save();
  docsCache = docs;
  registry.applyOverrides(docs);
  return stored;
}

/** Reset to default (or delete a custom area/node). */
async function reset({ kind, key }) {
  const Model = mdb.INTERNAL?.overviewConfig;
  if (!Model) fail('The database isn\'t ready.');
  const docs = docsCache.filter((d) => !(d.kind === kind && d.key === key));
  const problems = registry.validate(registry.buildState(docs));
  if (problems.length) fail(`Resetting that would break the overviews: ${problems.slice(0, 3).join('; ')}.`);
  const doc = await Model.findOne({ kind, key });
  if (doc) await doc.deleteOne();
  docsCache = docs;
  registry.applyOverrides(docs);
}

function list() { return docsCache.slice(); }

export default { load, save, reset, list, validateOverride, fieldExists, OverrideError, ROLES, SAFE_OPS };
export { load, save, reset, list, validateOverride, fieldExists, OverrideError };
