import areas from './areas.js';
import employee from './nodes/employee.js';
import attendance from './nodes/attendance.js';
import task from './nodes/task.js';
import leave from './nodes/leave.js';
import vehicle from './nodes/vehicle.js';
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
 * Figure refs are 'nodeId.figureId'. Every figure links to its model's list
 * filtered by `?view=nodeId.figureId`.
 *
 * Definitions are plain data so they can later move to the config store
 * (single-tenant config direction). See docs/OVERVIEW-HIERARCHY.md.
 */
const nodeList = [employee, attendance, task, ...leave, vehicle, subcontractor, user];

const areaById = new Map(areas.map((a) => [a.id, a]));
const nodeById = new Map(nodeList.map((n) => [n.id, n]));

function getArea(id) { return areaById.get(id) || null; }
function getNode(id) { return nodeById.get(id) || null; }
function getNodeForModel(model) {
  return nodeList.find((n) => n.model === model) || null;
}
// The node whose list is `listName` (a model's own list, or an alias list such
// as 'subcontractor', which lists suppliers through a base filter).
function getNodeForList(listName) {
  return nodeList.find((n) => n.model && (n.listName || n.model) === listName) || null;
}
function getNodeByOverviewPath(path) {
  return nodeList.find((n) => n.model && n.overviewPath === path) || null;
}
function listAreas() { return areas; }
function listNodes() { return nodeList; }

/** Resolve 'nodeId.figureId' → { node, figureId, figure } or null. */
function getFigure(ref) {
  if (typeof ref !== 'string') return null;
  const dot = ref.indexOf('.');
  if (dot < 1) return null;
  const node = getNode(ref.slice(0, dot));
  const figureId = ref.slice(dot + 1);
  const figure = node?.figures?.[figureId];
  return figure && node.model ? { node, figureId, figure, ref } : null;
}

/**
 * Check the registry hangs together. Returns a list of problems (empty when
 * fine); the tests assert it's empty so a bad definition fails CI, not a page.
 */
function validate() {
  const problems = [];
  const seen = new Set();
  for (const id of [...areaById.keys(), ...nodeList.map((n) => n.id)]) {
    if (seen.has(id)) problems.push(`duplicate id '${id}'`);
    seen.add(id);
  }
  const refOk = (nodeId, ref) => {
    const full = ref.includes('.') ? ref : `${nodeId}.${ref}`;
    if (!getFigure(full)) problems.push(`${nodeId}: unknown figure '${ref}'`);
  };
  for (const area of areas) {
    for (const child of area.children || []) {
      const node = getNode(child);
      if (!node) problems.push(`area ${area.id}: unknown child '${child}'`);
      else if (!(node.parents || []).includes(area.id)) problems.push(`area ${area.id}: child '${child}' doesn't list it as a parent`);
    }
  }
  for (const node of nodeList) {
    for (const p of node.parents || []) {
      if (!areaById.has(p) && !nodeById.has(p)) problems.push(`${node.id}: unknown parent '${p}'`);
    }
    for (const ref of node.summary || []) refOk(node.id, ref);
    const ov = node.overview || {};
    for (const ref of ov.figures || []) refOk(node.id, ref);
    for (const ref of ov.related || []) refOk(node.id, ref);
    for (const list of ov.lists || []) if (list.figure) refOk(node.id, list.figure);
    if (node.overview && !node.overviewPath) problems.push(`${node.id}: overview without overviewPath`);
  }
  return problems;
}

export default { getArea, getNode, getNodeForModel, getNodeForList, getNodeByOverviewPath, getFigure, listAreas, listNodes, validate };
export { getArea, getNode, getNodeForModel, getNodeForList, getNodeByOverviewPath, getFigure, listAreas, listNodes, validate };
