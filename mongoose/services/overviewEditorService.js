import mdb from './mongooseDatabaseService.js';
import registry from '../config/overviews/index.js';

/**
 * Overview editor helpers: turn definitions into form data and submitted forms
 * back into overrides. An override holds only what differs from the default
 * (per key, per figure), so improvements to the defaults keep reaching a company
 * that has customised other things. Validation is overviewConfigService's job.
 */

// The guided filter builder's operators, in the words people see.
const OPERATORS = [
  { op: 'is', label: 'is', needs: 'value' },
  { op: '$ne', label: 'is not', needs: 'value' },
  { op: '$in', label: 'is one of', needs: 'list' },
  { op: '$nin', label: 'is not one of', needs: 'list' },
  { op: '$gt', label: 'is more than', needs: 'number' },
  { op: '$gte', label: 'is at least', needs: 'number' },
  { op: '$lt', label: 'is less than', needs: 'number' },
  { op: '$lte', label: 'is at most', needs: 'number' },
  { op: '$set:true', label: 'has a value', needs: 'none' },
  { op: '$set:false', label: 'is empty', needs: 'none' },
  { op: '$withinNextDays', label: 'is within the next … days', needs: 'days' },
  { op: '$withinPastDays', label: 'is within the last … days', needs: 'days' },
  { op: '$notAfterDays', label: 'is no later than … days from now (includes the past)', needs: 'days' },
  { op: '$notAfterDays:ago', label: 'is more than … days ago', needs: 'days' },
  { op: '$beforeNow', label: 'is in the past', needs: 'none' },
  { op: '$afterNow', label: 'is now or later', needs: 'none' },
  { op: '$me', label: 'is the person viewing', needs: 'none' },
  { op: '$currentTaxYear', label: 'is this tax year', needs: 'none' },
];
const OP_BY_KEY = new Map(OPERATORS.map((o) => [o.op, o]));
const BLANK_ROWS = 3;

function modelFor(name) {
  for (const ns of ['INTERNAL', 'REST', 'PAPERLESS']) {
    const m = mdb[ns]?.[name];
    if (m && typeof m.find === 'function') return m;
  }
  return null;
}

/** Models the editor can build an overview on, by namespace. */
function modelNames() {
  const out = [];
  for (const ns of ['INTERNAL', 'REST']) {
    for (const [name, m] of Object.entries(mdb[ns] || {})) {
      if (name === 'connection' || typeof m?.find !== 'function') continue;
      if (['session', 'overviewConfig', 'auditLog', 'securityEvent'].includes(name)) continue;
      out.push({ name, ns });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Fields a filter, column or breakdown can use: [{ path, type }], nested paths included. */
function schemaFields(modelName) {
  const model = modelFor(modelName);
  if (!model?.schema) return [];
  const fields = [];
  model.schema.eachPath((path, type) => {
    if (['_id', '__v'].includes(path) || /(^|\.)(password|totpSecret|resetToken|unsubscribeToken)/i.test(path)) return;
    if (type.instance === 'Array' && type.schema) return; // arrays of subdocuments aren't filterable here
    fields.push({ path, type: type.instance });
  });
  return fields.sort((a, b) => a.path.localeCompare(b.path));
}

function fieldType(modelName, path) {
  const f = schemaFields(modelName).find((x) => x.path === path);
  return f?.type || null;
}

// ── Filters ↔ rows ────────────────────────────────────────────────────────
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

/**
 * A filter as builder rows [{ field, op, value }], or null when it can't be
 * shown that way ($and/$or, $expr, regex…). Those stay as they are unless the
 * admin builds a replacement.
 */
function whereToRows(where = {}) {
  const rows = [];
  for (const [field, cond] of Object.entries(where || {})) {
    if (field.startsWith('$')) return null;
    if (cond === null) { rows.push({ field, op: '$set:false', value: '' }); continue; }
    if (!isPlain(cond)) { rows.push({ field, op: 'is', value: String(cond) }); continue; }
    for (const [op, arg] of Object.entries(cond)) {
      if (op === '$set') { rows.push({ field, op: arg ? '$set:true' : '$set:false', value: '' }); continue; }
      if (op === '$eq') { rows.push({ field, op: 'is', value: String(arg) }); continue; }
      if (op === '$notAfterDays' && arg < 0) { rows.push({ field, op: '$notAfterDays:ago', value: String(-arg) }); continue; }
      if (!OP_BY_KEY.has(op)) return null;
      const value = Array.isArray(arg) ? arg.join(', ') : (arg === true || arg === null ? '' : String(arg));
      rows.push({ field, op, value });
    }
  }
  return rows;
}

function castValue(raw, type) {
  const v = String(raw ?? '').trim();
  if (type === 'Number' || type === 'Decimal128') {
    const n = Number(v);
    if (v === '' || Number.isNaN(n)) throw new Error(`"${raw}" isn't a number.`);
    return n;
  }
  if (type === 'Boolean') {
    if (/^(true|yes)$/i.test(v)) return true;
    if (/^(false|no)$/i.test(v)) return false;
    throw new Error(`"${raw}" should be yes or no.`);
  }
  if (type === 'Date') throw new Error('Dates can only be compared with the "within … days" and "past / now or later" options.');
  if (type === 'ObjectId') throw new Error('Linked records can only use "has a value", "is empty" or "is the person viewing".');
  return v;
}

/** Builder rows → a filter. Blank rows are ignored. Throws with a plain message. */
function rowsToWhere(rows, modelName) {
  const where = {};
  for (const row of rows) {
    if (!row || !row.field) continue;
    const meta = OP_BY_KEY.get(row.op);
    if (!meta) throw new Error(`Choose what "${row.field}" should be compared with.`);
    const type = fieldType(modelName, row.field);
    if (!type) throw new Error(`"${row.field}" isn't a field of ${modelName}.`);
    let cond;
    switch (meta.needs) {
      case 'none':
        if (row.op === '$set:true') cond = { $set: true };
        else if (row.op === '$set:false') cond = { $set: false };
        else cond = { [row.op]: true };
        break;
      case 'days': {
        const n = Number(String(row.value).trim());
        if (!Number.isInteger(n) || n < 1 || n > 3650) throw new Error(`"${row.field}": enter a whole number of days from 1 to 3650.`);
        cond = row.op === '$notAfterDays:ago' ? { $notAfterDays: -n } : { [row.op]: n };
        break;
      }
      case 'list': {
        const items = String(row.value || '').split(',').map((x) => x.trim()).filter(Boolean);
        if (!items.length) throw new Error(`"${row.field}": list at least one value, separated by commas.`);
        cond = { [row.op]: items.map((x) => castValue(x, type)) };
        break;
      }
      default: {
        const value = castValue(row.value, type);
        cond = row.op === 'is' ? value : { [row.op]: value };
      }
    }
    if (isPlain(cond) && isPlain(where[row.field])) where[row.field] = { ...where[row.field], ...cond };
    else if (where[row.field] !== undefined) throw new Error(`"${row.field}" is used twice in a way that can't be combined.`);
    else where[row.field] = cond;
  }
  return where;
}

/** Collect builder rows posted as cond[<prefix>][i][field|op|value]. */
function postedRows(body, prefix) {
  const raw = body?.cond?.[prefix];
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : Object.keys(raw).sort((a, b) => a - b).map((k) => raw[k]);
  return list.filter((r) => r && r.field);
}

// ── Diffing ───────────────────────────────────────────────────────────────
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** What `candidate` changes compared with `base`, per top-level key; figures per figure and key. */
function diffNode(base, candidate) {
  const out = {};
  for (const k of ['label', 'icon', 'description', 'parents', 'summary', 'actions', 'hidden']) {
    if (!same(base[k], candidate[k]) && !(k === 'hidden' && !base[k] && !candidate[k])) out[k] = candidate[k] ?? null;
  }
  const bf = base.figures || {};
  const cf = candidate.figures || {};
  const figs = {};
  for (const id of new Set([...Object.keys(bf), ...Object.keys(cf)])) {
    if (!cf[id]) { if (bf[id]) figs[id] = null; continue; }
    if (!bf[id]) { figs[id] = cf[id]; continue; }
    const d = {};
    for (const k of new Set([...Object.keys(bf[id]), ...Object.keys(cf[id])])) {
      if (!same(bf[id][k], cf[id][k])) d[k] = cf[id][k] ?? null;
    }
    if (Object.keys(d).length) figs[id] = d;
  }
  if (Object.keys(figs).length) out.figures = figs;
  const bo = base.overview || {};
  const co = candidate.overview || {};
  const ov = {};
  for (const k of ['figures', 'breakdowns', 'lists', 'panels', 'related']) {
    if (!same(bo[k], co[k])) ov[k] = co[k] ?? null;
  }
  if (Object.keys(ov).length) out.overview = ov;
  return out;
}

function diffArea(base, candidate) {
  const out = {};
  for (const k of ['label', 'icon', 'description', 'children', 'order', 'hidden']) {
    if (!same(base[k], candidate[k]) && !(k === 'hidden' && !base[k] && !candidate[k]) && !(k === 'order' && candidate[k] === undefined)) out[k] = candidate[k] ?? null;
  }
  return out;
}

// Strip the registry's bookkeeping (_default, _index…) before comparing or storing
function clean(def) {
  const out = {};
  for (const [k, v] of Object.entries(def || {})) if (!k.startsWith('_')) out[k] = v;
  return out;
}

function defaultNode(key) { return registry.defaults().nodes.find((n) => n.id === key) || null; }
function defaultArea(key) { return registry.defaults().areas.find((a) => a.id === key) || null; }

export default {
  OPERATORS, BLANK_ROWS, modelNames, schemaFields, fieldType, whereToRows, rowsToWhere, postedRows,
  diffNode, diffArea, clean, defaultNode, defaultArea, modelFor,
};
export {
  OPERATORS, BLANK_ROWS, modelNames, schemaFields, fieldType, whereToRows, rowsToWhere, postedRows,
  diffNode, diffArea, clean, defaultNode, defaultArea,
};
