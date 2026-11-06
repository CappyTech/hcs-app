import features from '../mongoose/config/publicFeaturesConfig.js';
import configService from './configService.js';
import organisationService from './organisationService.js';
import microsoftSsoService from './microsoftSsoService.js';

/**
 * publicFeaturesService — the signed-out home page's feature list for this
 * company.
 *
 * Starts from publicFeaturesConfig and leaves out:
 *   - entries an admin listed in PUBLIC_HOME_HIDDEN (comma-separated ids;
 *     unknown ids are ignored), for modules this company doesn't use
 *   - entries whose `when` condition doesn't hold, e.g. Website with no
 *     company website set
 * and adds an entry's `extra` sentence only when its condition holds, so the
 * page never offers Microsoft sign-in that isn't switched on.
 *
 * Groups left empty are dropped.
 */

export const IDS = features.flatMap((g) => g.items.map((i) => i.id));

const CONDITIONS = {
  website: () => !!organisationService.websiteUrl(),
  microsoftSso: () => microsoftSsoService.isEnabled(),
};

function holds(name) {
  try {
    return !!CONDITIONS[name]?.();
  } catch {
    return false;
  }
}

/** Ids an admin chose to leave off, as a Set of known ids. */
export function hiddenIds(raw = configService.get('PUBLIC_HOME_HIDDEN', '')) {
  const known = new Set(IDS);
  return new Set(String(raw || '').split(',').map((s) => s.trim()).filter((id) => known.has(id)));
}

/** Groups with only the entries this company shows: [{ group, icon, items: [{ id, icon, title, text }] }]. */
export function visibleGroups({ hidden = hiddenIds(), when = holds } = {}) {
  return features
    .map((g) => ({
      group: g.group,
      icon: g.icon,
      items: g.items
        .filter((i) => !hidden.has(i.id) && (!i.when || when(i.when)))
        .map((i) => ({
          id: i.id,
          icon: i.icon,
          title: i.title,
          text: i.extra && when(i.extra.when) ? `${i.text} ${i.extra.text}` : i.text,
        })),
    }))
    .filter((g) => g.items.length);
}

export default { IDS, hiddenIds, visibleGroups };
