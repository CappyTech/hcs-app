import mdb from './mongooseDatabaseService.js';
import registry from '../config/overviews/index.js';
import overviewEngine from './overviewEngine.js';
import logger from '../../services/loggerService.js';

/**
 * Per-person home page: which overview areas, figures and lists it shows.
 *
 * A layout is found in this order: the person's own (scope 'user'), then the
 * default an admin set for their role (scope 'role'), then the built-in one
 * (every area they may open, no figures or lists). Stored layouts are only
 * references; each pin is checked against the viewer's permissions every time
 * home is drawn, so a pin never shows what the person couldn't open anyway,
 * and pins whose area, figure or list has since been removed are skipped.
 *
 * Pin keys:
 *   area   'human'
 *   figure 'employee.rtwDue'                  (a figure ref, as in config/overviews)
 *   list   'employee:list:contractsExpired'   (an overview's list, by its figure)
 *          'leave:panel:upcomingHolidays'     (a list-shaped custom panel)
 */

const LIMITS = { areas: 30, figures: 24, lists: 8 };
const HOME_LIST_ROWS = 5;

const Model = () => mdb.INTERNAL?.homeLayout || null;

// ── What exists ───────────────────────────────────────────────────────────
// Lists are identified by the figure they show, so editing a list's columns
// keeps the pin; removing the list drops it.
function listEntries(node) {
  const out = [];
  if (!node?.overview || node.hidden) return out;
  for (const list of node.overview.lists || []) {
    if (!list.figure) continue;
    const ref = list.figure.includes('.') ? list.figure : `${node.id}.${list.figure}`;
    const found = registry.getFigure(ref);
    if (!found) continue;
    out.push({ key: `${node.id}:list:${list.figure}`, kind: 'list', node, list, figureNode: found.node, label: list.title || found.figure.label });
  }
  for (const name of node.overview.panels || []) {
    const label = overviewEngine.pinnablePanels[name];
    if (label) out.push({ key: `${node.id}:panel:${name}`, kind: 'panel', node, panel: name, label });
  }
  return out;
}

function findList(key) {
  const node = registry.getNode(String(key).split(':')[0]);
  return listEntries(node).find((e) => e.key === key) || null;
}

/**
 * Everything that could be pinned, grouped by area for the customise form.
 * With `req`, only what that person may open; without, everything (role defaults).
 */
function options(req = null) {
  const may = (path) => !req || overviewEngine.canOpenPath(req, path);
  const sees = (node) => !req || overviewEngine.canSeeNode(req, node);
  const seen = new Set();
  const groups = [];
  for (const area of registry.listAreas()) {
    if (!may(area.path)) continue;
    const group = { area: { key: area.id, label: area.label, icon: area.icon || 'bi-grid', description: area.description || '' }, sections: [] };
    // An area's own nodes, then nodes inside them (holiday requests inside Holiday)
    const queue = [...(area.children || [])];
    while (queue.length) {
      const node = registry.getNode(queue.shift());
      if (!node || node.hidden || seen.has(node.id)) continue;
      seen.add(node.id);
      queue.push(...registry.listNodes().filter((n) => n.parents?.[0] === node.id).map((n) => n.id));
      const figures = node.model && sees(node)
        ? Object.entries(node.figures || {}).map(([id, f]) => ({ key: `${node.id}.${id}`, label: f.label }))
        : [];
      const lists = (node.overviewPath && !may(node.overviewPath)) ? [] : listEntries(node)
        .filter((e) => (e.kind === 'panel' ? true : sees(e.figureNode)))
        .map((e) => ({ key: e.key, label: e.label }));
      if (figures.length || lists.length) group.sections.push({ label: node.label.many, figures, lists });
    }
    groups.push(group);
  }
  return groups;
}

function allKeys(groups) {
  const keys = { areas: new Set(), figures: new Set(), lists: new Set() };
  for (const g of groups) {
    keys.areas.add(g.area.key);
    for (const s of g.sections) {
      s.figures.forEach((f) => keys.figures.add(f.key));
      s.lists.forEach((l) => keys.lists.add(l.key));
    }
  }
  return keys;
}

// ── Layouts ───────────────────────────────────────────────────────────────
const builtIn = (req) => ({
  areas: registry.listAreas().filter((a) => !req || overviewEngine.canOpenPath(req, a.path)).map((a) => a.id),
  figures: [],
  lists: [],
});

async function find(scope, key) {
  const M = Model();
  if (!M || !key) return null;
  try {
    return await M.findOne({ scope, key: String(key) }).lean();
  } catch (err) {
    logger.warn(`[homeLayout] read ${scope}/${key} failed: ${err.message}`);
    return null;
  }
}

/** The layout this person sees, and where it came from: 'user' | 'role' | 'default'. */
async function resolve(req) {
  const own = await find('user', req.user?._id);
  if (own) return { layout: own, source: 'user' };
  const role = await find('role', req.user?.role);
  if (role) return { layout: role, source: 'role' };
  return { layout: builtIn(req), source: 'default' };
}

/**
 * Turn a submitted form into a layout. The form posts `pin` (checked keys)
 * and `order[<key>]` (a number; lower first, blanks keep form order). Keys not
 * in `allowed` are dropped, so nobody can store a pin they couldn't choose.
 */
function fromForm(body = {}, allowed) {
  const picked = [].concat(body.pin || []).map(String);
  const order = body.order && typeof body.order === 'object' ? body.order : {};
  const pos = (k, i) => {
    const n = Number(order[k]);
    return Number.isFinite(n) && String(order[k]).trim() !== '' ? n : 1000 + i;
  };
  const pick = (kind) => [...new Set(picked.filter((k) => allowed[kind].has(k)))]
    .map((k, i) => ({ k, p: pos(k, i), i }))
    .sort((a, b) => (a.p - b.p) || (a.i - b.i))
    .map((x) => x.k)
    .slice(0, LIMITS[kind]);
  return { areas: pick('areas'), figures: pick('figures'), lists: pick('lists') };
}

async function save(scope, key, layout, userId = null) {
  const M = Model();
  if (!M) throw new Error('Home layouts are unavailable (no database connection).');
  await M.findOneAndUpdate(
    { scope, key: String(key) },
    { $set: { areas: layout.areas, figures: layout.figures, lists: layout.lists, updatedBy: userId } },
    { upsert: true, runValidators: true, setDefaultsOnInsert: true },
  );
}

async function reset(scope, key) {
  const M = Model();
  if (M) await M.deleteOne({ scope, key: String(key) });
}

// ── Drawing home ──────────────────────────────────────────────────────────
/** The home page's overview section for this person, permission-checked pin by pin. */
async function build(req, now = new Date()) {
  const { layout, source } = await resolve(req);
  const tiles = (layout.areas || [])
    .map((id) => registry.getArea(id))
    .filter((a) => a && !a.hidden && overviewEngine.canOpenPath(req, a.path))
    .map((a) => ({ href: a.path, label: a.label, icon: a.icon || 'bi-grid', description: a.description || '' }));

  const figures = (await Promise.all((layout.figures || []).map(async (ref) => {
    const f = await overviewEngine.computeFigure(req, ref, now);
    if (!f) return null;
    return { ...f, group: registry.getFigure(ref)?.node.label.many || null };
  }))).filter(Boolean);

  const lists = (await Promise.all((layout.lists || []).map(async (key) => {
    const entry = findList(key);
    if (!entry) return null;
    if (entry.node.overviewPath && !overviewEngine.canOpenPath(req, entry.node.overviewPath)) return null;
    try {
      if (entry.kind === 'panel') {
        const out = await overviewEngine.customPanels[entry.panel]?.(req, now);
        if (!out || out.partial) return null;
        return { ...out, rows: (out.rows || []).slice(0, HOME_LIST_ROWS) };
      }
      return await overviewEngine.computeList(req, entry.node, { ...entry.list, limit: HOME_LIST_ROWS }, now);
    } catch (err) {
      logger.warn(`[homeLayout] list ${key} failed: ${err.message}`);
      return null;
    }
  }))).filter(Boolean);

  return { tiles, figures, lists, source };
}

export default { LIMITS, options, allKeys, resolve, fromForm, save, reset, build, findList, builtIn };
export { LIMITS, options, allKeys, resolve, fromForm, save, reset, build, findList, builtIn };
