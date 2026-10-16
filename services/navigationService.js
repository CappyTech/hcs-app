import departmentsConfig from '../mongoose/config/departmentsConfig.js';
import rbac from '../mongoose/config/rolePermissionsConfig.js';

/**
 * navigationService — the one list every navigation style draws from.
 *
 * The five header layouts (partials/nav/*.ejs) differ only in how they arrange
 * things; what they arrange is decided here, once per request: which
 * departments this person may open (rbac + showInNav), in the order
 * departmentsConfig declares them, which one is active for the current path,
 * how they cluster into groups, and which are pinned to the command rail.
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
  const source = Array.isArray(pinned) ? pinned : DEFAULT_PINNED;
  return [...new Set(source.map(String))].filter((slug) => allowed.has(slug));
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
  const can = (slug) => (user ? rbac.canAccessDepartment(user.role, slug, customPerms) : false);

  const items = Object.entries(departmentsConfig)
    .filter(([slug, dept]) => dept.showInNav !== false && can(slug))
    .map(([slug, dept]) => toItem(slug, dept, path));

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
