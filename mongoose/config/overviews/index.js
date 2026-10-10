import defaultAreas from './areas.js';
import employee from './nodes/employee.js';
import attendance from './nodes/attendance.js';
import task from './nodes/task.js';
import leave from './nodes/leave.js';
import vehicle from './nodes/vehicle.js';
import fleetLogs from './nodes/fleetLogs.js';
import projects from './nodes/projects.js';
import finance from './nodes/finance.js';
import payroll from './nodes/payroll.js';
import policies from './nodes/policies.js';
import subcontractor from './nodes/subcontractor.js';
import user from './nodes/user.js';

/**
 * Overview hierarchy registry.
 *
 * Areas (depth 1) contain nodes. A node is either a model (has `model`, owns
 * `figures`, may have its own generated overview at depth 2 and a list at
 * depth 3) or a group of models (no `model`; points at an overview page and
 * borrows other nodes' figures for its summary). A node's `parents` are area
 * or node ids; the first is its primary parent for breadcrumbs.
 *
 * A model node may also define `list: { columns: [{ field, label }] }`: the
 * columns its list page shows (depth 3), in order, opt-in. Without it the list
 * uses listControllerConfig's older automatic columns.
 *
 * Figure refs are 'nodeId.figureId'. Every figure links to its model's list
 * filtered by `?view=nodeId.figureId`.
 *
 * The files in this folder are the shipped DEFAULTS. A company's changes are
 * stored in the database (INTERNAL overviewConfig) and merged on top by
 * overviewConfigService, which calls `applyOverrides`. Everything below reads
 * the merged state, so the rest of the app never knows which is which.
 * See docs/OVERVIEW-HIERARCHY.md.
 */
const defaultNodes = [employee, attendance, task, ...leave, vehicle, ...fleetLogs, ...projects, ...finance, ...payroll, policies, subcontractor, user];

// ── Merging ───────────────────────────────────────────────────────────────
// Objects merge key by key; arrays and filters (`where`) are replaced whole;
// a `null` value removes the key (e.g. deletes a figure from the default).
const REPLACE_WHOLE = new Set(['where', 'baseWhere', 'sum']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

function mergeDef(base, override) {
  if (!isPlainObject(override)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v === null) { delete out[k]; continue; }
    if (!REPLACE_WHOLE.has(k) && isPlainObject(v) && isPlainObject(out[k])) out[k] = mergeDef(out[k], v);
    else out[k] = v;
  }
  return out;
}

/**
 * Build the merged hierarchy from the defaults and a list of override docs
 * ({ kind, key, custom, override }). Pure: the caller decides whether to apply it.
 * Hidden areas/nodes stay in `allAreas`/`allNodes` (for the editor) but drop out
 * of what pages see.
 */
function buildState(docs = []) {
  const byKey = (kind) => new Map(docs.filter((d) => d.kind === kind).map((d) => [d.key, d]));
  const areaDocs = byKey('area');
  const nodeDocs = byKey('node');

  const allAreas = defaultAreas.map((a, i) => ({ ...mergeDef(a, areaDocs.get(a.id)?.override), _default: true, _index: i, _customised: areaDocs.has(a.id) }));
  for (const d of areaDocs.values()) {
    if (d.custom && !defaultAreas.some((a) => a.id === d.key)) {
      allAreas.push({ ...d.override, id: d.key, path: `/overview/${d.key}`, _default: false, _index: 1000 + allAreas.length, _customised: true });
    }
  }
  // `order` is a position; when it ties with an unmoved area, the moved one goes first
  allAreas.sort((a, b) => ((a.order ?? a._index) - (b.order ?? b._index)) || ((a.order === undefined) - (b.order === undefined)));

  const allNodes = defaultNodes.map((n) => ({ ...mergeDef(n, nodeDocs.get(n.id)?.override), _default: true, _customised: nodeDocs.has(n.id) }));
  for (const d of nodeDocs.values()) {
    if (d.custom && !defaultNodes.some((n) => n.id === d.key)) {
      allNodes.push({ ...d.override, id: d.key, _default: false, _customised: true });
    }
  }

  return { allAreas, allNodes, areas: allAreas.filter((a) => !a.hidden), nodes: allNodes };
}

let state = buildState();
let areaById = new Map();
let nodeById = new Map();
function index() {
  areaById = new Map(state.allAreas.map((a) => [a.id, a]));
  nodeById = new Map(state.allNodes.map((n) => [n.id, n]));
}
index();

/** Replace the live state (overviewConfigService, after load or save). */
function applyOverrides(docs) {
  state = buildState(docs);
  index();
  return state;
}

// ── Lookups (merged state) ────────────────────────────────────────────────
function getArea(id) { return areaById.get(id) || null; }
function getNode(id) { return nodeById.get(id) || null; }
function getNodeForModel(model) {
  return state.allNodes.find((n) => n.model === model) || null;
}
// The node whose list is `listName` (a model's own list, or an alias list such
// as 'subcontractor', which lists suppliers through a base filter).
function getNodeForList(listName) {
  return state.allNodes.find((n) => n.model && (n.listName || n.model) === listName) || null;
}
function getNodeByOverviewPath(path) {
  return state.allNodes.find((n) => n.overview && n.overviewPath === path && !n.hidden) || null;
}
function getAreaByPath(path) {
  return state.areas.find((a) => a.path === path) || null;
}
/** Visible areas, in order (home page, routes). */
function listAreas() { return state.areas; }
function listNodes() { return state.allNodes; }
/** Everything including hidden areas, for the editor. */
function listAllAreas() { return state.allAreas; }
function defaults() { return { areas: defaultAreas, nodes: defaultNodes }; }

/** Resolve 'nodeId.figureId' → { node, figureId, figure } or null. */
function getFigure(ref, lookup = getNode) {
  if (typeof ref !== 'string') return null;
  const dot = ref.indexOf('.');
  if (dot < 1) return null;
  const node = lookup(ref.slice(0, dot));
  const figureId = ref.slice(dot + 1);
  const figure = node?.figures?.[figureId];
  return figure && node.model ? { node, figureId, figure, ref } : null;
}

/**
 * Check a hierarchy hangs together. Returns a list of problems (empty when
 * fine). With no argument it checks the live state; overviewConfigService
 * checks a candidate state before saving an override.
 */
function validate(candidate = state) {
  const problems = [];
  const areasById = new Map(candidate.allAreas.map((a) => [a.id, a]));
  const nodesById = new Map(candidate.allNodes.map((n) => [n.id, n]));
  const lookup = (id) => nodesById.get(id) || null;
  const seen = new Set();
  for (const id of [...candidate.allAreas.map((a) => a.id), ...candidate.allNodes.map((n) => n.id)]) {
    if (seen.has(id)) problems.push(`duplicate id '${id}'`);
    seen.add(id);
  }
  const refOk = (nodeId, ref) => {
    const full = ref.includes('.') ? ref : `${nodeId}.${ref}`;
    if (!getFigure(full, lookup)) problems.push(`${nodeId}: unknown figure '${ref}'`);
  };
  for (const area of candidate.allAreas) {
    for (const child of area.children || []) {
      const node = lookup(child);
      if (!node) problems.push(`area ${area.id}: unknown child '${child}'`);
      else if (!(node.parents || []).includes(area.id)) problems.push(`area ${area.id}: child '${child}' doesn't list it as a parent`);
    }
  }
  for (const node of candidate.allNodes) {
    for (const p of node.parents || []) {
      if (!areasById.has(p) && !nodesById.has(p)) problems.push(`${node.id}: unknown parent '${p}'`);
    }
    for (const ref of node.summary || []) refOk(node.id, ref);
    const ov = node.overview || {};
    for (const ref of ov.figures || []) refOk(node.id, ref);
    for (const ref of ov.related || []) refOk(node.id, ref);
    for (const list of ov.lists || []) if (list.figure) refOk(node.id, list.figure);
    if (node.overview && !node.overviewPath) problems.push(`${node.id}: overview without overviewPath`);
    if (node.list !== undefined) {
      const cols = node.list?.columns;
      if (!node.model) problems.push(`${node.id}: a group has no list of its own`);
      else if (!Array.isArray(cols) || !cols.length || !cols.every((c) => c && typeof c.field === 'string' && !c.field.includes('.') && typeof c.label === 'string')) {
        problems.push(`${node.id}: list.columns must be [{ field, label }] with top-level fields`);
      }
    }
  }
  return problems;
}

export default {
  getArea, getNode, getNodeForModel, getNodeForList, getNodeByOverviewPath, getAreaByPath, getFigure,
  listAreas, listNodes, listAllAreas, defaults, validate, buildState, applyOverrides, mergeDef,
};
export {
  getArea, getNode, getNodeForModel, getNodeForList, getNodeByOverviewPath, getAreaByPath, getFigure,
  listAreas, listNodes, listAllAreas, defaults, validate, buildState, applyOverrides, mergeDef,
};
