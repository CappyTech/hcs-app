import departmentsConfig from '../mongoose/config/departmentsConfig.js';
import rbac from '../mongoose/config/rolePermissionsConfig.js';
import registry from '../mongoose/config/overviews/index.js';
import { canUserOpenPath } from '../mongoose/services/overviewAccess.js';

/**
 * navigationService — the one list every navigation style draws from.
 *
 * The five header layouts (partials/nav/*.ejs) differ only in how they arrange
 * things; what they arrange is decided here, once per request.
 *
 * The items are the overview areas this person may open, in hierarchy order
 * (config/overviews/areas.js, with the company's changes from /admin/overviews
 * merged in), then the departments they may open that no area stands in for
 * (rbac + showInNav), in departmentsConfig order. A department with `navArea`
 * gives its place to that area when the area is shown, and keeps it when the
 * person can open the department but not the area. Also decided here: which
 * item is active for the current path, how they cluster into groups, and
 * which are pinned to the command rail.
 *
 * Nothing here touches the database. The person's chosen style and pinned
 * list come from navPreferenceService; the active-path rule is the same one
 * res.locals.navActive has always used, so 'tabs' highlights exactly what the
 * old inline header did.
 */

export const STYLES = Object.freeze(['tabs', 'grouped', 'two-tier', 'command', 'sidebar']);
export const DEFAULT_STYLE = 'tabs';

export const GROUPS = Object.freeze([
  { key: 'people', label: 'People', icon: 'bi-people' },
  { key: 'money', label: 'Money', icon: 'bi-wallet2' },
  { key: 'work', label: 'Work', icon: 'bi-briefcase' },
  { key: 'system', label: 'System', icon: 'bi-gear' },
]);
const GROUP_KEYS = GROUPS.map((g) => g.key);

/** Pinned to the command rail until the person chooses their own. */
export const DEFAULT_PINNED = Object.freeze([
  'human-resources',
  'attendance',
  'documents',
  'finance',
  'construction-industry-scheme',
]);

/** The same rule as res.locals.navActive in app.js. */
export function isActive(path, href) {
  const p = String(path || '/');
  if (href === '/') return p === '/';
  return p === href || p.startsWith(href + '/');
}

export function hrefFor(slug, dept = departmentsConfig[slug]) {
  return dept?.path || `/${slug}`;
}

function toItem(slug, dept, path) {
  const href = hrefFor(slug, dept);
  return {
    slug,
    label: dept.navLabel || dept.title || slug,
    title: dept.title || dept.navLabel || slug,
    icon: dept.icon || 'bi-grid',
    href,
    group: GROUP_KEYS.includes(dept.group) ? dept.group : 'work',
    special: dept.special || null,
    active: isActive(path, href),
  };
}

// The area a page belongs to: the area itself, or the area at the top of the
// primary-parent chain of the node whose overview this is.
function areaIdForPath(path) {
  const p = String(path || '/');
  const area = registry.getAreaByPath(p);
  if (area) return area.id;
  let node = registry.getNodeByOverviewPath(p);
  for (let hops = 0; node && hops < 10; hops++) {
    const parent = (node.parents || [])[0];
    if (!parent) return null;
    if (registry.getArea(parent)) return parent;
    node = registry.getNode(parent);
  }
  return null;
}

function areaItem(area, slug, path, activeArea) {
  return {
    slug,
    area: area.id,
    label: area.navLabel || area.label || area.id,
    title: area.label || area.id,
    icon: area.icon || 'bi-grid',
    href: area.path,
    group: GROUP_KEYS.includes(area.group) ? area.group : 'work',
    special: null,
    active: activeArea === area.id || isActive(path, area.path),
  };
}

/** Slugs a person may pin: everything they can see except Create and User, which every style places itself. */
export function pinnable(items) {
  return items.filter((i) => i.special !== 'create' && i.slug !== 'user');
}

/**
 * Keep only known, visible, pinnable slugs, in the order given, without
 * duplicates. `null` means "no choice made": fall back to the defaults.
 */
export function normalisePinned(pinned, items) {
  const allowed = new Set(pinnable(items).map((i) => i.slug));
  // A pinned department an area now stands in for pins that area.
  const replacedBy = new Map(items.filter((i) => i.replaces).flatMap((i) => i.replaces.map((d) => [d, i.slug])));
  const source = Array.isArray(pinned) ? pinned : DEFAULT_PINNED;
  return [...new Set(source.map(String).map((s) => (allowed.has(s) ? s : replacedBy.get(s) || s)))].filter((slug) => allowed.has(slug));
}

/**
 * Build the navigation for one request.
 *
 * @param {object} opts
 * @param {string} opts.path      req.path
 * @param {object} opts.user      req.user (role + customPermissions); null = nobody signed in
 * @param {string[]|null} [opts.pinned]  the person's pinned slugs, or null for the defaults
 */
export function build({ path = '/', user = null, pinned = null } = {}) {
  const customPerms = user?.customPermissions || {};
  const can = (slug) => (user ? rbac.canAccessDepartment(rbac.rolesOf(user), slug, customPerms) : false);

  const departments = Object.entries(departmentsConfig)
    .filter(([slug, dept]) => dept.showInNav !== false && can(slug));

  const activeArea = user ? areaIdForPath(path) : null;
  const shownAreas = user ? registry.listAreas().filter((a) => a.path && canUserOpenPath(user, a.path)) : [];
  const shownAreaIds = new Set(shownAreas.map((a) => a.id));
  const kept = departments.filter(([, dept]) => !(dept.navArea && shownAreaIds.has(dept.navArea)));
  const keptSlugs = new Set(kept.map(([slug]) => slug));

  const areaItems = shownAreas.map((area) => {
    // An area's slug is its id, unless a department still in the nav has it.
    const item = areaItem(area, keptSlugs.has(area.id) ? `area-${area.id}` : area.id, path, activeArea);
    const replaced = departments.filter(([, d]) => d.navArea === area.id);
    if (!replaced.length) return item;
    // The department's own pages (its dashboard and below) still light up the area.
    const active = item.active || replaced.some(([slug, d]) => isActive(path, hrefFor(slug, d)));
    return { ...item, active, replaces: replaced.map(([slug]) => slug) };
  });
  const items = [...areaItems, ...kept.map(([slug, dept]) => toItem(slug, dept, path))];

  const home = { slug: 'home', label: 'Home', icon: 'bi-house', href: '/', active: isActive(path, '/') };
  const help = { slug: 'help', label: 'Help', icon: 'bi-question-circle', href: '/help', active: isActive(path, '/help') };
  const create = items.find((i) => i.special === 'create') || null;
  const account = items.find((i) => i.slug === 'user') || null;

  // Groups never carry Create or the account link: every style places those itself.
  const grouped = items.filter((i) => i.special !== 'create' && i.slug !== 'user');
  const groups = GROUPS
    .map((g) => ({ ...g, items: grouped.filter((i) => i.group === g.key) }))
    .filter((g) => g.items.length)
    .map((g) => ({ ...g, active: g.items.some((i) => i.active) }));

  const pinnedSlugs = normalisePinned(pinned, items);
  const pinnedItems = pinnedSlugs.map((slug) => items.find((i) => i.slug === slug));
  const more = GROUPS
    .map((g) => ({ ...g, items: grouped.filter((i) => i.group === g.key && !pinnedSlugs.includes(i.slug)) }))
    .filter((g) => g.items.length)
    .map((g) => ({ ...g, active: g.items.some((i) => i.active) }));

  const active = items.find((i) => i.active) || (home.active ? home : null) || (help.active ? help : null);

  return { items, groups, home, help, create, account, pinned: pinnedItems, more, active };
}

export default { STYLES, DEFAULT_STYLE, GROUPS, DEFAULT_PINNED, isActive, hrefFor, pinnable, normalisePinned, build };
