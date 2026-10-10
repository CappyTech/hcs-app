import path from 'path';
import registry from '../config/overviews/index.js';
import overviewConfig from '../services/overviewConfigService.js';
import editor from '../services/overviewEditorService.js';
import listDefs from '../services/listDefinitionService.js';
import overviewEngine from '../services/overviewEngine.js';
import logger from '../../services/loggerService.js';

/**
 * Overview editor (/admin/overviews, admin only). Every save builds the
 * complete candidate definition from the form, stores only what differs from
 * the code default, and goes through overviewConfigService's validation, so
 * nothing reaches a page that it would refuse.
 */

const view = (name) => path.join('tailwindcss', 'admin', 'overviews', name);
const on = (v) => v === 'on' || v === '1' || v === 'true' || v === true;
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const intOr = (v, d) => { const n = parseInt(v, 10); return Number.isInteger(n) ? n : d; };

// Picked items, ordered by their order inputs (then by the order they were shown)
function picked(body, pickKey, orderKey, candidates) {
  const pick = body[pickKey] || {};
  const order = body[orderKey] || {};
  return candidates
    .map((ref, i) => ({ ref, i, n: intOr(order[ref], 1000 + i) }))
    .filter((x) => on(pick[x.ref]))
    .sort((a, b) => (a.n - b.n) || (a.i - b.i))
    .map((x) => x.ref);
}

function allFigureRefs() {
  const refs = [];
  for (const n of registry.listNodes()) {
    if (!n.model) continue;
    for (const id of Object.keys(n.figures || {})) refs.push({ ref: `${n.id}.${id}`, node: n.id, nodeLabel: n.label.many, label: n.figures[id].label });
  }
  return refs;
}

function fail(req, res, err, back) {
  const msg = err instanceof overviewConfig.OverrideError || err?.message ? err.message : 'That change could not be saved.';
  if (!(err instanceof overviewConfig.OverrideError)) logger.warn(`[overviewEditor] ${msg}`);
  req.flash('error', msg);
  return res.redirect(back);
}

// ── Index ─────────────────────────────────────────────────────────────────
export const getIndex = (req, res) => {
  const stored = overviewConfig.list();
  const changed = (kind, key) => stored.some((d) => d.kind === kind && d.key === key);
  const areas = registry.listAllAreas().map((a) => ({
    id: a.id, label: a.label, path: a.path, hidden: !!a.hidden, bespoke: !!a.bespoke, custom: !a._default, changed: changed('area', a.id),
    children: (a.children || []).map((c) => registry.getNode(c)).filter(Boolean).map((n) => ({
      id: n.id, label: n.label.many, hidden: !!n.hidden, custom: !n._default, changed: changed('node', n.id), editable: true,
    })),
  }));
  const inAreas = new Set(areas.flatMap((a) => a.children.map((c) => c.id)));
  const otherNodes = registry.listNodes().filter((n) => !inAreas.has(n.id)).map((n) => ({
    id: n.id, label: n.label.many, hidden: !!n.hidden, custom: !n._default, changed: changed('node', n.id),
    parent: n.parents?.[0] ? (registry.getNode(n.parents[0])?.label?.many || n.parents[0]) : null,
  }));
  res.render(view('index'), {
    title: 'Overview settings',
    areas, otherNodes,
    models: editor.modelNames(),
    roles: overviewConfig.ROLES,
  });
};

// ── Areas ─────────────────────────────────────────────────────────────────
export const getArea = (req, res, next) => {
  const area = registry.getArea(req.params.key);
  if (!area) return next();
  const nodes = registry.listNodes().filter((n) => !n.hidden || (area.children || []).includes(n.id));
  res.render(view('area'), {
    title: `Overview settings: ${area.label}`,
    area,
    custom: !area._default,
    changed: overviewConfig.list().some((d) => d.kind === 'area' && d.key === area.id),
    nodes: nodes.map((n) => ({ id: n.id, label: n.label.many, inArea: (area.children || []).includes(n.id), order: (area.children || []).indexOf(n.id) })),
    roles: overviewConfig.ROLES,
  });
};

export const postArea = async (req, res) => {
  const key = req.params.key;
  const back = `/admin/overviews/area/${encodeURIComponent(key)}`;
  try {
    const area = registry.getArea(key);
    if (!area) throw new Error('That area no longer exists.');
    const b = req.body;
    const candidate = {
      ...editor.clean(area),
      label: str(b.label) || area.label,
      icon: str(b.icon) || area.icon,
      description: str(b.description) || undefined,
      hidden: on(b.hidden),
      children: picked(b, 'child_pick', 'child_order', registry.listNodes().map((n) => n.id)),
    };
    if (str(b.order) !== '') candidate.order = intOr(b.order, undefined);
    if (!area._default) candidate.roles = [].concat(b.roles || []).filter(Boolean);

    // Moving a model into an area also makes the area one of its parents, so the
    // two stay consistent; parents are added before the area and removed after.
    const before = new Set(area.children || []);
    const after = new Set(candidate.children);
    const added = [...after].filter((c) => !before.has(c));
    const removed = [...before].filter((c) => !after.has(c));
    for (const id of added) await setParents(id, (p) => (p.includes(key) ? p : [...p, key]), req.user);
    await saveArea(key, area, candidate, req.user);
    for (const id of removed) await setParents(id, (p) => p.filter((x) => x !== key), req.user);
    req.flash('success', `Saved ${candidate.label}.`);
    return res.redirect(back);
  } catch (err) {
    return fail(req, res, err, back);
  }
};

async function saveArea(key, current, candidate, user) {
  const base = editor.defaultArea(key);
  if (!base) {
    const { id, path: p, ...def } = candidate;
    return overviewConfig.save({ kind: 'area', key, override: def, custom: true }, user);
  }
  const override = editor.diffArea(base, candidate);
  if (!Object.keys(override).length) return overviewConfig.reset({ kind: 'area', key });
  return overviewConfig.save({ kind: 'area', key, override }, user);
}

async function setParents(nodeId, change, user) {
  const node = registry.getNode(nodeId);
  if (!node) return;
  const parents = change(node.parents || []);
  if (JSON.stringify(parents) === JSON.stringify(node.parents || [])) return;
  await saveNode(nodeId, { ...editor.clean(node), parents }, user);
}

async function saveNode(key, candidate, user) {
  const base = editor.defaultNode(key);
  if (!base) {
    const { id, ...def } = candidate;
    return overviewConfig.save({ kind: 'node', key, override: def, custom: true }, user);
  }
  const override = editor.diffNode(base, candidate);
  if (!Object.keys(override).length) return overviewConfig.reset({ kind: 'node', key });
  return overviewConfig.save({ kind: 'node', key, override }, user);
}

export const postAreaReset = async (req, res) => {
  const key = req.params.key;
  try {
    const area = registry.getArea(key);
    if (area && !area._default) {
      // Deleting an added area: its overviews stay, but stop listing it as a place
      for (const id of area.children || []) await setParents(id, (p) => p.filter((x) => x !== key), req.user);
    }
    await overviewConfig.reset({ kind: 'area', key });
    req.flash('success', area?._default ? `${area.label} is back to its default.` : 'Area deleted.');
    return res.redirect(area?._default ? `/admin/overviews/area/${encodeURIComponent(key)}` : '/admin/overviews');
  } catch (err) {
    return fail(req, res, err, `/admin/overviews/area/${encodeURIComponent(key)}`);
  }
};

export const postNewArea = async (req, res) => {
  const key = str(req.body.key);
  try {
    if (registry.getArea(key) || registry.getNode(key)) throw new Error(`"${key}" is already used.`);
    const override = {
      label: str(req.body.label),
      icon: str(req.body.icon) || 'bi-grid',
      description: str(req.body.description) || undefined,
      roles: [].concat(req.body.roles || []).filter(Boolean),
      children: [],
    };
    if (!override.description) delete override.description;
    await overviewConfig.save({ kind: 'area', key, override, custom: true }, req.user);
    req.flash('success', `Created ${override.label}. Add overviews to it below.`);
    return res.redirect(`/admin/overviews/area/${encodeURIComponent(key)}`);
  } catch (err) {
    return fail(req, res, err, '/admin/overviews');
  }
};

// ── Nodes ─────────────────────────────────────────────────────────────────
export const getNode = (req, res, next) => {
  const node = registry.getNode(req.params.key);
  if (!node) return next();
  const fields = node.model ? editor.schemaFields(node.model) : [];
  const own = Object.keys(node.figures || {}).map((id) => `${node.id}.${id}`);
  const others = allFigureRefs().filter((f) => f.node !== node.id);
  const expand = (refs) => refs.map((r) => (r.includes('.') ? r : `${node.id}.${r}`));
  const summary = expand(node.summary || []);
  const ovFigures = expand(node.overview?.figures || []);
  const related = expand(node.overview?.related || []);
  const figures = Object.entries(node.figures || {}).map(([id, f]) => {
    const rows = editor.whereToRows(f.where);
    return { id, ...f, sumField: typeof f.sum === 'string' ? f.sum : '', sumExpr: f.sum && typeof f.sum !== 'string', rows, editable: rows !== null };
  });
  res.render(view('node'), {
    title: `Overview settings: ${node.label.many}`,
    node,
    custom: !node._default,
    changed: overviewConfig.list().some((d) => d.kind === 'node' && d.key === node.id),
    fields,
    operators: editor.OPERATORS,
    blankRows: editor.BLANK_ROWS,
    figures,
    summaryChoices: [...new Set([...own, ...summary])],
    summary,
    overviewChoices: [...new Set([...own, ...ovFigures])],
    ovFigures,
    relatedChoices: others,
    related,
    figureLabel: (ref) => registry.getFigure(ref)?.figure.label || ref,
    parentChoices: [...registry.listAllAreas().map((a) => ({ id: a.id, label: `${a.label} (area)` })),
      ...registry.listNodes().filter((n) => n.id !== node.id && !n.model).map((n) => ({ id: n.id, label: `${n.label.many} (group)` }))],
    panels: node.overview?.panels || [],
    roles: overviewConfig.ROLES,
    listColumns: node.list?.columns || [],
    listControls: node.model ? listDefs.currentControls(node.listName || node.model) : null,
    // The list table reads each row's own keys, so only top-level fields
    listFields: fields.filter((f) => !f.path.includes('.')),
  });
};

// The list page from the form. Columns: 'auto' drops them (older automatic
// columns), 'defined' takes the filled rows in the order given. Sort, tabs and
// filters are stored only where they differ from listControllerConfig, so an
// untouched list keeps following the code. Forms without these fields
// (`list_controls` absent) leave them as they are.
// Compared as text: the form casts 'false' to false for a Boolean field, while
// listControllerConfig often writes the string; both mean the same tab or option.
const sameJson = (a, b) => JSON.stringify(a, (k, v) => (typeof v === 'number' || typeof v === 'boolean' ? String(v) : v))
  === JSON.stringify(b, (k, v) => (typeof v === 'number' || typeof v === 'boolean' ? String(v) : v));
const rowsOf = (raw) => (Array.isArray(raw) ? raw : Object.keys(raw || {}).sort((a, b) => a - b).map((k) => raw[k]))
  .map((r, i) => ({ r: r || {}, i }));

function castOption(raw, type) {
  const v = String(raw).trim();
  if (type === 'Number') { const n = Number(v); if (v === '' || Number.isNaN(n)) throw new Error(`"${raw}" isn't a number.`); return n; }
  if (type === 'Boolean') { if (/^(true|yes)$/i.test(v)) return true; if (/^(false|no)$/i.test(v)) return false; throw new Error(`"${raw}" should be yes or no.`); }
  return v;
}

// "value = Label" per line (or separated by ;). A line without "=" uses itself as both.
function parseOptions(text, type, what) {
  const items = String(text || '').split(/[;\r\n]/).map((x) => x.trim()).filter(Boolean);
  if (!items.length) throw new Error(`${what}: list its choices, one per line, as value = label.`);
  return items.map((item) => {
    const eq = item.indexOf('=');
    const value = eq >= 0 ? item.slice(0, eq).trim() : item;
    const label = eq >= 0 ? item.slice(eq + 1).trim() || value : value;
    return { value: castOption(value, type), label };
  });
}

function listFromForm(body, current, modelName, listName) {
  const out = {};
  if (body.list_mode === 'defined') {
    const cols = rowsOf(body.lcol)
      .filter(({ r }) => str(r.field) && !on(r.remove))
      .sort((x, y) => (intOr(x.r.order, 1000 + x.i) - intOr(y.r.order, 1000 + y.i)) || (x.i - y.i))
      .map(({ r }) => ({ field: str(r.field), label: str(r.label) || str(r.field) }));
    if (!cols.length) throw new Error('Add at least one column, or choose Automatic.');
    out.columns = cols;
  } else if (body.list_mode !== 'auto' && current?.columns) out.columns = current.columns;

  if (!body.list_controls) {
    for (const k of ['sort', 'tabs', 'filters']) if (current?.[k] !== undefined) out[k] = current[k];
  } else {
    const base = listDefs.baseControls(listName);
    const sortField = str(body.lsort_field);
    if (sortField) {
      const sort = { [sortField]: body.lsort_order === '1' ? 1 : -1 };
      if (!sameJson(sort, base.sort)) out.sort = sort;
    }

    const by = str(body.ltabs_by);
    const tabs = by ? {
      by,
      values: rowsOf(body.ltab).filter(({ r }) => str(r.value) && !on(r.remove))
        .map(({ r }) => ({ value: castOption(r.value, editor.fieldType(modelName, by)), label: str(r.label) || str(r.value) })),
    } : null;
    if (tabs && !tabs.values.length) throw new Error('Add at least one tab, or leave "Tabs by" empty for none.');
    // No tabs is stored as false: in a stored change, null means "back to the default"
    if (!sameJson(tabs, base.tabs) && !(tabs === null && base.dynamicTabs)) out.tabs = tabs || false;

    const filters = rowsOf(body.lfil).filter(({ r }) => str(r.field) && !on(r.remove)).map(({ r }) => {
      const field = str(r.field);
      const type = ['select', 'boolean', 'daterange', 'numberrange'].includes(r.type) ? r.type : 'select';
      const f = { field, label: str(r.label) || field, type };
      if (type === 'select') f.options = parseOptions(r.options, editor.fieldType(modelName, field), `Filter "${f.label}"`);
      return f;
    });
    if (!sameJson(filters, base.filters)) out.filters = filters;
  }
  return Object.keys(out).length ? out : undefined;
}

function figureFromForm(body, id, current, modelName) {
  const f = body.fig?.[id] || {};
  const out = { ...current };
  out.label = str(f.label) || current.label;
  if (str(f.hint)) out.hint = str(f.hint); else delete out.hint;
  if (['critical', 'warning'].includes(f.severity)) out.severity = f.severity; else delete out.severity;
  if (!(current.sum && typeof current.sum !== 'string')) {
    if (str(f.sum)) { out.sum = str(f.sum); if (on(f.money)) { out.format = 'money'; delete out.unit; } else { delete out.format; if (str(f.unit)) out.unit = str(f.unit); else delete out.unit; } } else { delete out.sum; delete out.format; delete out.unit; }
  }
  const rows = editor.postedRows(body, id);
  if (on(f.keepFilter)) return out; // a filter the builder can't show stays as it is
  const rebuilt = rows.length ? editor.rowsToWhere(rows, modelName) : {};
  // Unchanged conditions keep the default's exact form, so the stored change
  // stays empty and later improvements to the default still arrive.
  const asBuilt = (w) => { try { const r = editor.whereToRows(w); return r ? JSON.stringify(editor.rowsToWhere(r, modelName)) : null; } catch { return null; } };
  if (asBuilt(current.where || {}) !== JSON.stringify(rebuilt)) out.where = rebuilt;
  return out;
}

export const postNode = async (req, res) => {
  const key = req.params.key;
  const back = `/admin/overviews/node/${encodeURIComponent(key)}`;
  try {
    const node = registry.getNode(key);
    if (!node) throw new Error('That overview no longer exists.');
    const b = req.body;
    const candidate = editor.clean(node);
    candidate.label = { one: str(b.label_one) || node.label.one, many: str(b.label_many) || node.label.many };
    candidate.icon = str(b.icon) || node.icon;
    candidate.description = str(b.description) || undefined;
    candidate.hidden = on(b.hidden);
    const parentIds = [...registry.listAllAreas().map((a) => a.id), ...registry.listNodes().map((n) => n.id)];
    candidate.parents = picked(b, 'parent_pick', 'parent_order', parentIds);
    if (!node._default) {
      candidate.roles = [].concat(b.roles || []).filter(Boolean);
      if (str(b.listPath)) candidate.listPath = str(b.listPath);
    }

    if (node.model) {
      // Figures: edit, remove, add
      const figures = {};
      for (const [id, f] of Object.entries(node.figures || {})) {
        if (on(b.fig?.[id]?.remove)) continue;
        figures[id] = figureFromForm(b, id, f, node.model);
      }
      const newId = str(b.newfig?.id);
      if (newId) {
        if (figures[newId]) throw new Error(`There's already a figure called "${newId}".`);
        const rows = editor.postedRows(b, '__new');
        if (!rows.length) throw new Error('A new figure needs at least one condition.');
        figures[newId] = { label: str(b.newfig.label) || newId, where: editor.rowsToWhere(rows, node.model) };
        if (['critical', 'warning'].includes(b.newfig.severity)) figures[newId].severity = b.newfig.severity;
        if (str(b.newfig.sum)) { figures[newId].sum = str(b.newfig.sum); if (on(b.newfig.money)) figures[newId].format = 'money'; }
      }
      candidate.figures = figures;
      candidate.list = listFromForm(b, node.list, node.model, node.listName || node.model);
      if (candidate.list === undefined) delete candidate.list;
    }
    const own = Object.keys(candidate.figures || {}).map((id) => `${key}.${id}`);
    const shorten = (refs) => refs.map((r) => (r.startsWith(`${key}.`) ? r.slice(key.length + 1) : r));
    const keep = (refs) => refs.filter((r) => !r.startsWith(`${key}.`) || own.includes(r));
    candidate.summary = shorten(keep(picked(b, 'sum_pick', 'sum_order', [...new Set([...own, ...(node.summary || []).map((r) => (r.includes('.') ? r : `${key}.${r}`))])])));

    if (node.overview) {
      const ov = { ...node.overview };
      ov.figures = shorten(keep(picked(b, 'ov_pick', 'ov_order', [...new Set([...own, ...(ov.figures || []).map((r) => (r.includes('.') ? r : `${key}.${r}`))])])));
      ov.related = picked(b, 'rel_pick', 'rel_order', allFigureRefs().map((f) => f.ref).filter((r) => !r.startsWith(`${key}.`)));
      ov.panels = (ov.panels || []).filter((p) => on(b.panel_pick?.[p]));
      // Breakdowns: relabel/remove existing, add one
      ov.breakdowns = (ov.breakdowns || []).map((bd, i) => ({ bd, f: b.bd?.[i] || {} }))
        .filter(({ f }) => !on(f.remove))
        .map(({ bd, f }) => ({ ...bd, label: str(f.label) || bd.label }));
      if (str(b.bd_new?.by)) ov.breakdowns.push({ label: str(b.bd_new.label) || `By ${b.bd_new.by}`, by: str(b.bd_new.by) });
      // Lists: retitle, resize, reorder, remove existing; add one
      ov.lists = (ov.lists || []).map((l, i) => ({ l, f: b.list?.[i] || {}, i }))
        .filter(({ f }) => !on(f.remove))
        .sort((x, y) => (intOr(x.f.order, x.i) - intOr(y.f.order, y.i)) || (x.i - y.i))
        .map(({ l, f }) => {
          const out = { ...l };
          if (str(f.title)) out.title = str(f.title); else delete out.title;
          const limit = intOr(f.limit, l.limit || 10);
          out.limit = Math.min(Math.max(limit, 1), 25);
          return out;
        })
        // A list whose figure was removed above goes too
        .filter((l) => !l.figure || l.figure.includes('.') || candidate.figures?.[l.figure]);
      if (str(b.list_new?.figure)) {
        const fig = str(b.list_new.figure);
        const cols = [].concat(Object.values(b.list_new.col || {})).filter((c) => c && str(c.field))
          .map((c) => ({ field: str(c.field), label: str(c.label) || str(c.field), ...(['date', 'money'].includes(c.format) ? { format: c.format } : {}) }));
        if (!cols.length) throw new Error('A new list needs at least one column.');
        ov.lists.push({
          figure: fig.startsWith(`${key}.`) ? fig.slice(key.length + 1) : fig,
          ...(str(b.list_new.title) ? { title: str(b.list_new.title) } : {}),
          limit: Math.min(Math.max(intOr(b.list_new.limit, 10), 1), 25),
          columns: cols,
        });
      }
      candidate.overview = ov;
    }

    await saveNode(key, candidate, req.user);
    req.flash('success', `Saved ${candidate.label.many}.`);
    return res.redirect(back);
  } catch (err) {
    return fail(req, res, err, back);
  }
};

export const postNodeReset = async (req, res) => {
  const key = req.params.key;
  try {
    const node = registry.getNode(key);
    if (node && !node._default) {
      // A custom overview: take it out of its areas first, then delete it
      for (const a of registry.listAllAreas().filter((x) => (x.children || []).includes(key))) {
        await saveArea(a.id, a, { ...editor.clean(a), children: a.children.filter((c) => c !== key) }, req.user);
      }
    }
    await overviewConfig.reset({ kind: 'node', key });
    req.flash('success', node?._default ? `${node.label.many} is back to its default.` : 'Overview deleted.');
    return res.redirect(node?._default ? `/admin/overviews/node/${encodeURIComponent(key)}` : '/admin/overviews');
  } catch (err) {
    return fail(req, res, err, `/admin/overviews/node/${encodeURIComponent(key)}`);
  }
};

export const postNewNode = async (req, res) => {
  const key = str(req.body.key);
  try {
    if (registry.getArea(key) || registry.getNode(key)) throw new Error(`"${key}" is already used.`);
    const model = str(req.body.model);
    if (!editor.modelFor(model)) throw new Error('Choose a model.');
    const many = str(req.body.label_many) || key;
    const areaId = str(req.body.area);
    const area = registry.getArea(areaId);
    if (!area) throw new Error('Choose the area it belongs to.');
    const override = {
      model,
      label: { one: str(req.body.label_one) || many, many },
      icon: str(req.body.icon) || 'bi-grid',
      parents: [areaId],
      listPath: str(req.body.listPath) || `/${model}s`,
      overviewPath: `/overview/${key}`,
      roles: [].concat(req.body.roles || []).filter(Boolean),
      figures: { all: { label: `All ${many.toLowerCase()}`, where: {} } },
      summary: ['all'],
      overview: { figures: ['all'], breakdowns: [], lists: [], related: [] },
    };
    if (!override.roles.length) throw new Error('Choose who may open it.');
    await overviewConfig.save({ kind: 'node', key, override, custom: true }, req.user);
    await saveArea(areaId, area, { ...editor.clean(area), children: [...(area.children || []), key] }, req.user);
    req.flash('success', `Created ${many}. Add figures and lists below.`);
    return res.redirect(`/admin/overviews/node/${encodeURIComponent(key)}`);
  } catch (err) {
    return fail(req, res, err, '/admin/overviews');
  }
};

// Used by the views to show where a page lives
export const previewHref = (def) => def?.overviewPath || def?.path || null;

export default { getIndex, getArea, postArea, postAreaReset, postNewArea, getNode, postNode, postNodeReset, postNewNode };
