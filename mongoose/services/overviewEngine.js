import mdb from './mongooseDatabaseService.js';
import rbac from '../config/rolePermissionsConfig.js';
import registry from '../config/overviews/index.js';
import listControllerConfig from '../config/listControllerConfig.js';
import { scopeQuery } from '../../services/dataScopingService.js';
import logger from '../../services/loggerService.js';
import kashflowProjectService from './kashflowProjectService.js';
import { cisSupplierQuery } from '../../services/cisService.js';

/**
 * Overview engine: turns the definitions in config/overviews into page data.
 *
 * Depth 1 (area) → buildArea, depth 2 (model overview) → buildNodeOverview,
 * depth 3 (list) → resolveListView, used by listController for ?view= and
 * breadcrumbs. Every figure, link and page goes through the same permission
 * checks the routes use (rolePermissionsConfig + dataScopingService), so what
 * a person sees is never more than what they could open.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Filter vocabulary ────────────────────────────────────────────────────
// Definitions use plain Mongo conditions plus a few relative-date operators,
// resolved against `now` at request time:
//   { $withinNextDays: n }  → now … now + n days
//   { $withinPastDays: n }  → now − n days … now
//   { $notAfterDays: n }    → anything up to now + n days (includes the past)
//   { $beforeNow: true }    → before now
//   { $set: true|false }    → field has / has no value
//   { $me: true }           → equals the viewing user's _id (e.g. "your tasks")
const RELATIVE = {
  $withinNextDays: (n, now) => ({ $gte: now, $lte: new Date(now.getTime() + n * DAY_MS) }),
  $withinPastDays: (n, now) => ({ $gte: new Date(now.getTime() - n * DAY_MS), $lte: now }),
  $notAfterDays: (n, now) => ({ $ne: null, $lte: new Date(now.getTime() + n * DAY_MS) }),
  $beforeNow: (_v, now) => ({ $ne: null, $lt: now }),
  $set: (v) => (v ? { $ne: null } : null),
  // No user → match nothing rather than everything
  $me: (_v, _now, ctx) => (ctx?.userId ? { $eq: ctx.userId } : { $in: [] }),
};

function compileWhere(where = {}, now = new Date(), ctx = {}) {
  const out = {};
  for (const [field, cond] of Object.entries(where || {})) {
    if (field === '$and' || field === '$or') {
      out[field] = cond.map((c) => compileWhere(c, now, ctx));
      continue;
    }
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      const merged = {};
      for (const [op, arg] of Object.entries(cond)) {
        if (RELATIVE[op]) {
          const r = RELATIVE[op](arg, now, ctx);
          if (r === null) { out[field] = null; continue; }
          Object.assign(merged, r);
        } else {
          merged[op] = arg;
        }
      }
      if (out[field] !== null) out[field] = merged;
    } else {
      out[field] = cond;
    }
  }
  return out;
}

// ── Models & permissions ────────────────────────────────────────────────
function modelFor(name) {
  for (const ns of ['INTERNAL', 'REST', 'PAPERLESS']) {
    const m = mdb[ns]?.[name];
    if (m && typeof m.find === 'function') return m;
  }
  return null;
}

function perms(req) {
  return { role: req.user?.role, custom: req.user?.customPermissions || {} };
}

function canOpenPath(req, path) {
  if (!req.user || !path) return false;
  const { role, custom } = perms(req);
  return rbac.canAccessRoute(role, path, custom);
}

function canListModel(req, model) {
  if (!req.user || !model) return false;
  const { role, custom } = perms(req);
  return rbac.canAccess(role, model, 'l', custom).allowed;
}

// The figure's condition AND the node's base filter AND the user's data scope;
// null when they can't list it. `baseWhere` mirrors an alias list's baseFilter
// (e.g. subcontractors = suppliers with a WHT rate) so counts match the list.
async function scopedFilter(req, model, where, now, baseWhere = null) {
  const scope = await scopeQuery(req, model, 'l');
  if (scope === null) return null;
  const ctx = { userId: req.user?._id };
  const own = compileWhere(where, now, ctx);
  const base = baseWhere ? compileWhere(baseWhere, now, ctx) : {};
  const parts = [own, base].filter((p) => Object.keys(p).length);
  const compiled = parts.length > 1 ? { $and: parts } : (parts[0] || {});
  if (!Object.keys(scope).length) return compiled;
  if (!Object.keys(compiled).length) return scope;
  return { $and: [compiled, scope] };
}

// Where a node leads: its overview if the user can open it, else its list.
function nodeHref(req, node) {
  if (node.overviewPath && canOpenPath(req, node.overviewPath)) return node.overviewPath;
  if (node.model && node.listPath && canListModel(req, node.model)) return node.listPath;
  return null;
}

function figureHref(node, figureId) {
  return `${node.listPath}?view=${encodeURIComponent(`${node.id}.${figureId}`)}`;
}

// ── Breadcrumbs ──────────────────────────────────────────────────────────
// Home › area › … › node, following primary parents. `from` picks a
// non-primary parent when the visitor came that way.
function breadcrumbs(req, nodeOrAreaId, { from } = {}) {
  const chain = [];
  let id = nodeOrAreaId;
  const visited = new Set();
  while (id && !visited.has(id)) {
    visited.add(id);
    const area = registry.getArea(id);
    if (area) {
      chain.unshift({ label: area.label, href: canOpenPath(req, area.path) ? area.path : null });
      break;
    }
    const node = registry.getNode(id);
    if (!node) break;
    chain.unshift({ label: node.label.many, href: nodeHref(req, node) });
    const parents = node.parents || [];
    id = (from && parents.includes(from)) ? from : parents[0];
  }
  return [{ label: 'Home', href: '/' }, ...chain];
}

// ── Figures ──────────────────────────────────────────────────────────────
async function computeFigure(req, ref, now) {
  const found = registry.getFigure(ref);
  if (!found) return null;
  const { node, figureId, figure } = found;
  if (!canListModel(req, node.model)) return null;
  const base = {
    ref, label: figure.label, hint: figure.hint || null, severity: figure.severity || null,
    href: figureHref(node, figureId), value: null, display: null,
  };
  const Model = modelFor(node.model);
  if (!Model) return base;
  try {
    const filter = await scopedFilter(req, node.model, figure.where, now, node.baseWhere);
    if (filter === null) return null;
    if (figure.sum) {
      // A total over the matching rows (e.g. fuel spend); the link still opens those rows
      const [agg] = await Model.aggregate([
        { $match: filter },
        // `sum` is a field name, or a Mongo expression for derived totals (e.g. gross − paid)
        { $group: { _id: null, total: { $sum: typeof figure.sum === 'string' ? `$${figure.sum}` : figure.sum } } },
      ]);
      const total = agg?.total;
      base.value = Number(total?._bsontype === 'Decimal128' ? total.toString() : (total || 0));
      base.display = figure.format === 'money'
        ? formatValue(base.value, 'money')
        : `${Math.round(base.value).toLocaleString('en-GB')}${figure.unit ? ` ${figure.unit}` : ''}`;
    } else {
      base.value = await Model.countDocuments(filter);
    }
  } catch (err) {
    logger.warn(`[overviewEngine] figure ${ref} failed: ${err.message}`);
  }
  return base;
}

const fullRef = (node, ref) => (ref.includes('.') ? ref : `${node.id}.${ref}`);

async function computeFigures(req, node, refs, now) {
  const figures = await Promise.all((refs || []).map((r) => computeFigure(req, fullRef(node, r), now)));
  return figures.filter(Boolean);
}

// ── Breakdowns ───────────────────────────────────────────────────────────
// Segment links reuse the list's own tabs or select filters when they cover
// the field; otherwise the segment is shown without a link.
function segmentHref(node, by, value) {
  if (value === null || value === undefined || value === '') return null;
  const cfg = listControllerConfig[node.listName || node.model] || {};
  if (cfg.tabsby === by) return `${node.listPath}?tab=${encodeURIComponent(value)}`;
  const filter = (cfg.filters || []).find((f) => f.field === by && f.type === 'select');
  if (filter) return `${node.listPath}?f_${encodeURIComponent(by)}=${encodeURIComponent(value)}`;
  return null;
}

async function computeBreakdown(req, node, bd, now) {
  const Model = modelFor(node.model);
  if (!Model) return null;
  try {
    const filter = await scopedFilter(req, node.model, bd.where, now, node.baseWhere);
    if (filter === null) return null;
    const groups = await Model.aggregate([
      { $match: filter },
      { $group: { _id: `$${bd.by}`, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    return {
      label: bd.label,
      segments: groups.map((g) => ({
        label: g._id === null || g._id === undefined || g._id === '' ? 'Not set' : (bd.labels?.[g._id] || String(g._id)),
        count: g.count,
        href: segmentHref(node, bd.by, g._id),
      })),
    };
  } catch (err) {
    logger.warn(`[overviewEngine] breakdown ${node.id}.${bd.by} failed: ${err.message}`);
    return null;
  }
}

// ── Row lists ────────────────────────────────────────────────────────────
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

function formatValue(value, format) {
  if (value === null || value === undefined || value === '') return '—';
  if (format === 'date' || value instanceof Date) {
    const d = new Date(value);
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB');
  }
  if (format === 'money') {
    const n = Number(value?._bsontype === 'Decimal128' ? value.toString() : value);
    return isNaN(n) ? '—' : n.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' });
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value?._bsontype === 'Decimal128') return value.toString();
  return String(value);
}

async function resolveRefs(rows, columns) {
  const lookups = {};
  for (const col of columns.filter((c) => c.ref)) {
    const ids = [...new Set(rows.map((r) => getPath(r, col.field)).filter(Boolean).map(String))];
    const RefModel = modelFor(col.ref.model);
    if (!ids.length || !RefModel) { lookups[col.field] = {}; continue; }
    try {
      const docs = await RefModel.find({ _id: { $in: ids } }).select(col.ref.field).lean();
      lookups[col.field] = Object.fromEntries(docs.map((d) => [String(d._id), getPath(d, col.ref.field)]));
    } catch {
      lookups[col.field] = {};
    }
  }
  return lookups;
}

async function computeList(req, node, list, now) {
  const Model = modelFor(node.model);
  if (!Model) return null;
  const figure = list.figure ? registry.getFigure(fullRef(node, list.figure)) : null;
  const where = figure ? figure.figure.where : list.where;
  try {
    const filter = await scopedFilter(req, node.model, where, now, node.baseWhere);
    if (filter === null) return null;
    const [rows, total] = await Promise.all([
      Model.find(filter).sort(list.sort || { createdAt: -1 }).limit(list.limit || 10).lean(),
      Model.countDocuments(filter),
    ]);
    // Hide columns that are empty on every row (e.g. Subcontractor on employee-only records)
    const columns = list.columns.filter((c) => rows.some((r) => getPath(r, c.field) != null && getPath(r, c.field) !== ''));
    const lookups = await resolveRefs(rows, columns);
    return {
      title: list.title || figure?.figure.label || node.label.many,
      severity: figure?.figure.severity || null,
      columns: columns.map((c) => c.label),
      rows: rows.map((r) => ({
        href: r.uuid ? `/${node.model}/read/${r.uuid}` : null,
        cells: columns.map((c) => {
          const raw = getPath(r, c.field);
          if (c.ref) return formatValue(lookups[c.field]?.[String(raw)] ?? null);
          // `minus`: show field − other field (e.g. gross − paid = still owed)
          if (c.minus) {
            const num = (v) => Number(v?._bsontype === 'Decimal128' ? v.toString() : (v || 0));
            return formatValue(num(raw) - num(getPath(r, c.minus)), c.format);
          }
          return formatValue(raw, c.format);
        }),
      })),
      total,
      href: figure ? figureHref(figure.node, figure.figureId) : node.listPath,
    };
  } catch (err) {
    logger.warn(`[overviewEngine] list ${node.id} failed: ${err.message}`);
    return null;
  }
}

// ── Custom panels ────────────────────────────────────────────────────────
// For things a generic definition can't express. Each returns the same shape
// as computeList so the template renders them identically.
const customPanels = {
  async unassignedEmployees(req, now) {
    if (!canListModel(req, 'employee') || !canListModel(req, 'assignment')) return null;
    const Employee = modelFor('employee');
    const Assignment = modelFor('assignment');
    if (!Employee || !Assignment) return null;
    const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
    const assigned = await Assignment.distinct('assignedEmployees', {
      status: { $in: ['Planned', 'In Progress'] },
      weekStart: { $gte: weekAgo },
    });
    const filter = { status: 'active', _id: { $nin: assigned } };
    const [rows, total] = await Promise.all([
      Employee.find(filter).sort({ name: 1 }).limit(10).select('uuid name position').lean(),
      Employee.countDocuments(filter),
    ]);
    return {
      title: 'Active employees with no current assignment',
      severity: null,
      columns: ['Name', 'Role'],
      rows: rows.map((r) => ({ href: `/employee/read/${r.uuid}`, cells: [formatValue(r.name), formatValue(r.position)] })),
      total,
      href: '/assignments',
      linkLabel: 'Open assignments',
    };
  },
};

// Purchases are joined to suppliers by SupplierCode (KashFlow data: no ObjectId refs).
customPanels.subcontractorRecentPurchases = async (req, now) => {
  if (!canListModel(req, 'supplier') || !canListModel(req, 'purchase')) return null;
  const Supplier = modelFor('supplier');
  const Purchase = modelFor('purchase');
  if (!Supplier || !Purchase) return null;
  const codes = await Supplier.distinct('Code', { $and: [cisSupplierQuery(), { IsArchived: { $ne: true } }] });
  if (!codes.length) return null;
  const scope = await scopeQuery(req, 'purchase', 'l');
  if (scope === null) return null;
  const own = { SupplierCode: { $in: codes }, IssuedDate: { $gte: new Date(now.getTime() - 30 * DAY_MS) } };
  const filter = Object.keys(scope).length ? { $and: [own, scope] } : own;
  const [rows, total] = await Promise.all([
    Purchase.find(filter).sort({ IssuedDate: -1 }).limit(10).select('uuid Number SupplierName IssuedDate GrossAmount').lean(),
    Purchase.countDocuments(filter),
  ]);
  return {
    title: 'Subcontractor purchases in the last 30 days',
    severity: null,
    columns: ['Number', 'Subcontractor', 'Date', 'Gross'],
    rows: rows.map((r) => ({
      href: r.uuid ? `/purchase/read/${r.uuid}` : null,
      cells: [formatValue(r.Number), formatValue(r.SupplierName), formatValue(r.IssuedDate, 'date'), formatValue(r.GrossAmount, 'money')],
    })),
    total,
    href: '/purchases',
  };
};

// In-progress contracts with no Planned/In Progress assignment against them.
customPanels.contractsWithoutAssignments = async (req) => {
  if (!canListModel(req, 'contract') || !canListModel(req, 'assignment')) return null;
  const Contract = modelFor('contract');
  const Assignment = modelFor('assignment');
  if (!Contract || !Assignment) return null;
  const staffed = await Assignment.distinct('contractId', { status: { $in: ['Planned', 'In Progress'] } });
  const filter = { status: 'In Progress', _id: { $nin: staffed } };
  const [rows, total] = await Promise.all([
    Contract.find(filter).sort({ endDate: 1 }).limit(10).select('uuid title endDate').lean(),
    Contract.countDocuments(filter),
  ]);
  return {
    title: 'In progress with no current assignments',
    severity: 'warning',
    columns: ['Contract', 'Ends'],
    rows: rows.map((r) => ({ href: `/contract/read/${r.uuid}`, cells: [formatValue(r.title), formatValue(r.endDate, 'date')] })),
    total,
    href: '/assignments',
    linkLabel: 'Open assignments',
  };
};

// KashFlow project financial health with its two actions (Run Financial Check,
// Mark Complete). Rendered by its own partial: it has forms and modals the
// generic list shape can't express. The POST routes stay in overviewRoutes.
customPanels.projectFinancials = async (req) => {
  if (!canListModel(req, 'project') || !canOpenPath(req, '/overview/projects')) return null;
  const RestProject = modelFor('project');
  if (!RestProject) return null;
  const active = await RestProject.find({ Status: { $nin: ['Completed', 'Archived'] } }).sort({ StartDate: -1 }).lean();
  for (const p of active) p._financials = kashflowProjectService.computeFinancials(p);
  const restProjectsAtRisk = active.filter((p) => p._financials.atRisk);
  const restProjectsReadyToComplete = active.filter((p) => !p._financials.atRisk && p._financials.incomeTarget > 0 && p._financials.incomeActual > 0);
  return {
    partial: 'panels/projectFinancials',
    always: true, // keeps the Run Financial Check button even when nothing needs attention
    locals: { restProjects: [...restProjectsAtRisk, ...restProjectsReadyToComplete], restProjectsAtRisk, restProjectsReadyToComplete },
  };
};

// ── Pages ────────────────────────────────────────────────────────────────
function actionsFor(req, node) {
  const { role, custom } = perms(req);
  // An action is shown only if its page would open: a controlled route's rule, or the model operation
  return (node.actions || []).filter((a) => {
    if (a.route) return canOpenPath(req, a.route);
    return !a.op || rbac.canAccess(role, node.model, a.op, custom).allowed;
  });
}

// Home page Overviews grid: every top-level area the user can open, in order.
function homeTiles(req) {
  return registry.listAreas()
    .filter((a) => canOpenPath(req, a.path))
    .map((a) => ({ href: a.path, label: a.label, icon: a.icon || 'bi-grid', description: a.description || '' }));
}

async function buildArea(req, areaId, now = new Date()) {
  const area = registry.getArea(areaId);
  if (!area || area.bespoke) return null;
  const cards = [];
  for (const childId of area.children || []) {
    const node = registry.getNode(childId);
    if (!node) continue;
    let href = nodeHref(req, node);
    if (!href) continue; // nothing here the user may open
    // Reached through a secondary parent: carry it so the breadcrumb leads back here
    if (href === node.overviewPath && node.parents?.[0] !== area.id) href += `?from=${encodeURIComponent(area.id)}`;
    const figures = await computeFigures(req, node, node.summary, now);
    const linkLabel = href.split('?')[0] === node.overviewPath ? `${node.label.many} overview` : `All ${node.label.many.toLowerCase()}`;
    cards.push({ id: node.id, label: node.label.many, icon: node.icon || null, description: node.description || '', href, linkLabel, figures });
  }
  return {
    kind: 'area',
    title: area.label,
    description: area.description || '',
    icon: area.icon || null,
    crumbs: breadcrumbs(req, area.id).slice(0, -1),
    cards,
    actions: [],
  };
}

async function buildNodeOverview(req, nodeId, now = new Date()) {
  const node = registry.getNode(nodeId);
  if (!node?.overview) return null;
  const ov = node.overview;
  const [figures, breakdowns, lists, panels, related] = await Promise.all([
    computeFigures(req, node, ov.figures, now),
    Promise.all((ov.breakdowns || []).map((b) => computeBreakdown(req, node, b, now))),
    Promise.all((ov.lists || []).map((l) => computeList(req, node, l, now))),
    Promise.all((ov.panels || []).map(async (name) => {
      try { return customPanels[name] ? await customPanels[name](req, now) : null; } catch (err) {
        logger.warn(`[overviewEngine] panel ${name} failed: ${err.message}`);
        return null;
      }
    })),
    computeFigures(req, node, ov.related, now).then((figs) => figs.map((f) => ({
      ...f, group: registry.getFigure(f.ref)?.node.label.many || null,
    }))),
  ]);
  return {
    kind: 'node',
    title: node.label.many,
    description: node.description || '',
    icon: node.icon || null,
    crumbs: breadcrumbs(req, node.id, { from: req.query?.from }).slice(0, -1),
    figures,
    breakdowns: breakdowns.filter((b) => b && b.segments.length),
    lists: [...lists, ...panels].filter((l) => l && !l.partial && l.total > 0),
    partials: panels.filter((p) => p && p.partial),
    related,
    listHref: node.listPath && canListModel(req, node.model) ? node.listPath : null,
    listLabel: `All ${node.label.many.toLowerCase()}`,
    actions: actionsFor(req, node),
  };
}

/**
 * For listController: the extra filter for ?view=, its banner, and the
 * breadcrumbs for a model's list. Unknown or foreign views are ignored, so a
 * hand-typed ?view= can only ever narrow a list to a definition in code.
 */
async function resolveListView(req, listName, now = new Date()) {
  const node = registry.getNodeForList(listName);
  if (!node) return { filter: null, view: null, crumbs: null };
  const crumbs = breadcrumbs(req, node.id, { from: req.query?.from });
  // The list itself is the last crumb, shown as the page title, so drop it
  const result = { filter: null, view: null, crumbs: crumbs.slice(0, -1) };
  const ref = typeof req.query?.view === 'string' ? req.query.view : null;
  const found = ref ? registry.getFigure(ref) : null;
  if (found && found.node.id === node.id) {
    result.filter = compileWhere(found.figure.where, now, { userId: req.user?._id });
    const clear = new URLSearchParams(Object.entries(req.query || {}).filter(([k]) => k !== 'view' && k !== 'page'));
    result.view = { ref, label: found.figure.label, clearHref: `${node.listPath}${clear.toString() ? `?${clear}` : ''}` };
  }
  return result;
}

export default {
  compileWhere, breadcrumbs, homeTiles, buildArea, buildNodeOverview, resolveListView, computeFigure, customPanels,
};
export { compileWhere, breadcrumbs, homeTiles, buildArea, buildNodeOverview, resolveListView, computeFigure, customPanels };
