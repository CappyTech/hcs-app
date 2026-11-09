/**
 * pageSearchService — the pages of the app, for the search box.
 *
 * searchService looks through records, so a word that names a place in the app
 * ("weekly", "payroll") found nothing. This lists the pages a person can open,
 * from what already describes them: the overview hierarchy (areas, overviews
 * and their route-guarded actions) and the dashboard tiles. Nothing is declared
 * twice, so a company's overview changes show up here as well.
 *
 * A page is listed only when its own guard would admit the person: the same
 * route rule the overviews and dashboards apply.
 */

import rbac from '../config/rolePermissionsConfig.js';
import registry from '../config/overviews/index.js';
import tiles from '../config/dashboardTilesConfig.js';
import { canOpenPath } from './overviewEngine.js';

export const PAGE_LIMIT = 8;

const labelOf = (def) => (def.label && typeof def.label === 'object' ? def.label.many || def.label.one : def.label) || '';

/**
 * Whether a dashboard tile's page opens for this person. A controlled route
 * decides by its rule; a page with no rule falls back to the tile's departments,
 * as the dashboards do.
 */
function canUseTile(req, tile, access) {
  const roles = access.rolesOf(req.user);
  const custom = req.user.customPermissions || {};
  if (roles.includes('admin')) return true;
  const pattern = access.matchRoutePattern(tile.link);
  if (pattern) return access.canAccessRoute(roles, pattern, custom);
  return [].concat(tile.department || []).some((d) => access.canAccessDepartment(roles, d, custom));
}

/**
 * Build the page lister over injectable dependencies (tests swap them).
 * Returns (req) => [{ title, subtitle, href }], one entry per page.
 */
export function createPageList({ hierarchy = registry, tileConfig = tiles, access = rbac, canOpen = canOpenPath } = {}) {
  return function listPages(req) {
    if (!req.user) return [];
    const seen = new Set();
    const pages = [];
    const add = (title, subtitle, href) => {
      if (!title || !href || seen.has(href)) return;
      seen.add(href);
      pages.push({ title, subtitle: subtitle || '', href });
    };
    const addActions = (def) => {
      for (const a of def.actions || []) {
        if (a.route && canOpen(req, a.route)) add(a.label, def.description, a.href);
      }
    };

    for (const area of hierarchy.listAreas()) {
      if (canOpen(req, area.path)) add(labelOf(area), area.description, area.path);
      addActions(area);
    }
    for (const node of hierarchy.listNodes()) {
      if (node.hidden) continue;
      if (node.overview && node.overviewPath && canOpen(req, node.overviewPath)) add(labelOf(node), node.description, node.overviewPath);
      addActions(node);
    }
    for (const tile of Object.values(tileConfig)) {
      // Links outside the app, and tiles a company hasn't configured, aren't pages here
      if (typeof tile.link !== 'string' || !tile.link.startsWith('/')) continue;
      if (canUseTile(req, tile, access)) add(tile.title, tile.description, tile.link);
    }
    return pages;
  };
}

/**
 * The pages matching a term: contains, ignoring case, on the title or the
 * description. Title matches come first; `PAGE_LIMIT` caps the group.
 */
export function matchPages(pages, term, limit = PAGE_LIMIT) {
  const needle = String(term || '').toLowerCase();
  if (!needle) return [];
  const inTitle = [];
  const inText = [];
  for (const p of pages) {
    if (p.title.toLowerCase().includes(needle)) inTitle.push(p);
    else if (p.subtitle.toLowerCase().includes(needle)) inText.push(p);
  }
  return [...inTitle, ...inText].slice(0, limit);
}

export const listPages = createPageList();

export default { createPageList, listPages, matchPages, PAGE_LIMIT };
