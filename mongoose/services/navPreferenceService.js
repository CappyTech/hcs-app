import mdb from './mongooseDatabaseService.js';
import configService from '../../services/configService.js';
import navigation from '../../services/navigationService.js';
import logger from '../../services/loggerService.js';

/**
 * Which header layout a person sees, resolved in this order: their own choice
 * (INTERNAL.navPreference), then the company default (the managed setting
 * NAV_STYLE_DEFAULT), then 'tabs', which is the header everyone had before
 * styles existed. Saving applies on the next page load; nothing is cached in
 * the session.
 */

export const STYLES = [
  { value: 'tabs', label: 'Icon tabs', description: 'The classic centred row of icon-over-label tabs, one per area.' },
  { value: 'grouped', label: 'Grouped menus', description: 'Text menus grouped as People, Money, Work and System, with Create and search on the right.' },
  { value: 'two-tier', label: 'Two-tier', description: 'A slim utility bar on top and a scrollable row of area tabs underneath, the active one underlined.' },
  { value: 'command', label: 'Command rail', description: 'Your pinned areas as chips, a More menu for the rest and a Jump-to box (Ctrl+K) in the middle.' },
  { value: 'sidebar', label: 'Sidebar', description: 'A slim header with a left sidebar grouping every area; the sidebar folds into a drawer on small screens.' },
];
const VALID = new Set(STYLES.map((s) => s.value));

export const CONFIG_KEY = 'NAV_STYLE_DEFAULT';

const Model = () => mdb.INTERNAL?.navPreference || null;

export function isStyle(value) {
  return VALID.has(String(value));
}

/** The company-wide default an admin set, or 'tabs'. */
export function companyDefault() {
  const value = String(configService.get(CONFIG_KEY, '') || '').trim();
  return isStyle(value) ? value : navigation.DEFAULT_STYLE;
}

async function find(userId) {
  const M = Model();
  if (!M || !userId) return null;
  try {
    return await M.findOne({ userId }).lean();
  } catch (err) {
    logger.warn(`[navPreference] read for ${userId} failed: ${err.message}`);
    return null;
  }
}

/**
 * The style and pinned list for a person, and where the style came from:
 * 'user' | 'company' | 'default'. `pinned` is null until they have chosen.
 */
export async function resolve(user) {
  const own = await find(user?._id);
  if (own && isStyle(own.navStyle)) {
    return { style: own.navStyle, pinned: Array.isArray(own.pinned) ? own.pinned : null, source: 'user' };
  }
  const pinned = Array.isArray(own?.pinned) ? own.pinned : null;
  const company = String(configService.get(CONFIG_KEY, '') || '').trim();
  if (isStyle(company)) return { style: company, pinned, source: 'company' };
  return { style: navigation.DEFAULT_STYLE, pinned, source: 'default' };
}

/**
 * Turn the account form into a preference. An unknown style is refused; the
 * pinned list keeps only slugs this person may pin, in form order.
 */
export function fromForm(body = {}, nav) {
  const navStyle = String(body.navStyle || '').trim();
  if (!isStyle(navStyle)) throw new Error('That navigation style does not exist.');
  const picked = [].concat(body.pinned ?? []).map(String);
  const pinned = navigation.normalisePinned(picked, nav?.items || []);
  return { navStyle, pinned };
}

export async function save(userId, { navStyle, pinned }) {
  const M = Model();
  if (!M) throw new Error('Navigation preferences are unavailable (no database connection).');
  await M.findOneAndUpdate(
    { userId },
    { $set: { navStyle, pinned } },
    { upsert: true, runValidators: true, setDefaultsOnInsert: true },
  );
}

export async function reset(userId) {
  const M = Model();
  if (M) await M.deleteOne({ userId });
}

export default { STYLES, CONFIG_KEY, isStyle, companyDefault, resolve, fromForm, save, reset };
