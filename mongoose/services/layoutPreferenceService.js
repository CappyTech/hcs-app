import mdb from './mongooseDatabaseService.js';
import configService from '../../services/configService.js';
import logger from '../../services/loggerService.js';

/**
 * How wide a person's main content runs, resolved in this order: their own
 * choice (INTERNAL.layoutPreference), then the company default (the managed
 * setting CONTENT_WIDTH_DEFAULT), then 'standard', which is every page as it
 * was designed. layout.ejs puts the width on <main data-content-width>, and
 * assets/tailwind.css widens or narrows the page containers (max-w-5xl to
 * max-w-7xl) inside it. Narrow containers such as forms keep their width.
 */

export const DEFAULT_WIDTH = 'standard';

export const WIDTHS = [
  { value: 'narrow', label: 'Narrow', description: 'Pages stop at about 1024px wide, easier to read on a big screen.' },
  { value: 'standard', label: 'Standard', description: 'Each page at the width it was designed for, up to about 1280px.' },
  { value: 'wide', label: 'Wide', description: 'Pages run up to about 1536px, more room for tables and dashboards.' },
  { value: 'full', label: 'Full width', description: 'Pages fill the whole window, edge to edge.' },
];
const VALID = new Set(WIDTHS.map((w) => w.value));

export const CONFIG_KEY = 'CONTENT_WIDTH_DEFAULT';

const Model = () => mdb.INTERNAL?.layoutPreference || null;

export function isWidth(value) {
  return VALID.has(String(value));
}

/** The company-wide default an admin set, or 'standard'. */
export function companyDefault() {
  const value = String(configService.get(CONFIG_KEY, '') || '').trim();
  return isWidth(value) ? value : DEFAULT_WIDTH;
}

/** The width for a person and where it came from: 'user' | 'company' | 'default'. */
export async function resolve(user) {
  const M = Model();
  if (M && user?._id) {
    try {
      const own = await M.findOne({ userId: user._id }).lean();
      if (own && isWidth(own.contentWidth)) return { width: own.contentWidth, source: 'user' };
    } catch (err) {
      logger.warn(`[layoutPreference] read for ${user._id} failed: ${err.message}`);
    }
  }
  const company = String(configService.get(CONFIG_KEY, '') || '').trim();
  if (isWidth(company)) return { width: company, source: 'company' };
  return { width: DEFAULT_WIDTH, source: 'default' };
}

/** Turn the account form into a preference. An unknown width is refused. */
export function fromForm(body = {}) {
  const contentWidth = String(body.contentWidth || '').trim();
  if (!isWidth(contentWidth)) throw new Error('That layout width does not exist.');
  return { contentWidth };
}

export async function save(userId, { contentWidth }) {
  const M = Model();
  if (!M) throw new Error('Layout preferences are unavailable (no database connection).');
  await M.findOneAndUpdate(
    { userId },
    { $set: { contentWidth } },
    { upsert: true, runValidators: true, setDefaultsOnInsert: true },
  );
}

export async function reset(userId) {
  const M = Model();
  if (M) await M.deleteOne({ userId });
}

export default { DEFAULT_WIDTH, WIDTHS, CONFIG_KEY, isWidth, companyDefault, resolve, fromForm, save, reset };
