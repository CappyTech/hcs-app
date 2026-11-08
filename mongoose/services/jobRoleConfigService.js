/**
 * Job roles a company has changed or added (docs/PERMISSION-GROUPS.md,
 * phase 4: the role editor at /admin/job-roles).
 *
 * The code definitions in accessGroupsConfig.js are the defaults. The
 * INTERNAL `jobRoleConfig` collection holds a company's whole definition of
 * any role it changed, turned off or added. load() runs at startup; save(),
 * create() and reset() validate, store, and re-apply straight away:
 * accessGroups.applyJobRoleOverrides() rebuilds the definitions and
 * rbac.recompileJobRoles() rebuilds the permission tables in place.
 *
 * What a definition may hold is checked strictly, because it becomes access:
 *   • groups and levels from accessGroupsConfig only;
 *   • one grant per group; System at view at most (System's admin pages
 *     stay with the admin role whatever a job role holds);
 *   • 'project' scope only on groups where it limits something;
 *   • slugs that never collide with a legacy role.
 * Any level is allowed, including manage on the money groups: the
 * separation-of-duties rule (separationOfDutiesService) applies to every
 * user who isn't admin or accountant, so a second person is still needed.
 */
import mdb from './mongooseDatabaseService.js';
import accessGroups from '../config/accessGroupsConfig.js';
import rbac from '../config/rolePermissionsConfig.js';
import logger from '../../services/loggerService.js';

export class JobRoleError extends Error {}
const fail = (msg) => { throw new JobRoleError(msg); };

const SLUG = /^[a-z][A-Za-z0-9]{1,39}$/;
const VALUES = ['always', 'never', 'flag'];
// The most a job role may hold on a group.
const MAX_LEVEL = { system: 'view' };

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

/** Does project scope limit anything on this group (a scoped model or route)? */
export function groupScopable(key) {
  const g = accessGroups.groups[key];
  if (!g) return false;
  if (g.models.some((m) => accessGroups.PROJECT_SCOPE_FIELDS[m])) return true;
  const routes = Object.values(g.routes || {}).flat();
  const scoped = [...accessGroups.PROJECT_SCOPE_ROUTES];
  return routes.some((r) => (r.endsWith('*')
    ? scoped.some((s) => s.startsWith(r.slice(0, -1)))
    : accessGroups.PROJECT_SCOPE_ROUTES.has(r)));
}

/** The highest level a job role may hold on a group. */
export function maxLevel(key) {
  return MAX_LEVEL[key] || accessGroups.LEVELS[accessGroups.LEVELS.length - 1];
}

/**
 * Check a definition and return it normalised. Throws JobRoleError.
 * @param {Object} input  { label, description, values, grants, disabled }
 * @param {Object} opts   { slug, custom }
 */
export function validate(input, { slug, custom = false } = {}) {
  if (typeof slug !== 'string' || !SLUG.test(slug)) fail('That job role name can\'t be used as an identifier.');
  if (accessGroups.RESERVED_ROLE_SLUGS.includes(slug)) fail(`"${slug}" is a built-in account role.`);
  if (custom && accessGroups.defaultJobRoles[slug]) fail(`"${slug}" is a built-in job role.`);
  if (!custom && !accessGroups.defaultJobRoles[slug]) fail(`There is no built-in job role "${slug}".`);

  const label = clean(input.label);
  if (!label || label.length > 60) fail('Give the job role a name (up to 60 characters).');
  const description = clean(input.description);
  if (description.length > 300) fail('Keep the description to 300 characters.');
  if (!VALUES.includes(input.values)) fail('Choose whether this job role sees money.');

  const grants = [];
  const seen = new Set();
  for (const raw of Array.isArray(input.grants) ? input.grants : []) {
    const group = accessGroups.groups[raw?.group];
    if (!group) fail(`Unknown area "${raw?.group}".`);
    if (seen.has(raw.group)) fail(`${group.label} is listed twice.`);
    seen.add(raw.group);
    const level = raw.level;
    if (!accessGroups.LEVELS.includes(level)) fail(`Choose a level for ${group.label}.`);
    if (accessGroups.LEVELS.indexOf(level) > accessGroups.LEVELS.indexOf(maxLevel(raw.group))) {
      fail(`${group.label} can be given at ${maxLevel(raw.group)} at most: the rest stays with the admin role.`);
    }
    const scope = raw.scope || 'all';
    if (!accessGroups.SCOPES.includes(scope)) fail(`Unknown scope for ${group.label}.`);
    if (scope === 'project' && !groupScopable(raw.group)) fail(`${group.label} can't be limited to someone's own sites.`);
    const g = { group: raw.group, level };
    if (scope !== 'all') g.scope = scope;
    if (raw.values === true) g.values = true;
    grants.push(g);
  }
  const disabled = input.disabled === true;
  if (!disabled && !grants.length) fail('Give the job role at least one area, or turn it off.');

  return { slug, custom: !!custom, label, description, values: input.values, grants, disabled };
}

// ── Store ─────────────────────────────────────────────────────────────────
let cache = [];

/** Apply a full set of definitions; on failure put the previous set back. */
function apply(defs) {
  const previous = cache;
  try {
    accessGroups.applyJobRoleOverrides(defs);
    rbac.recompileJobRoles();
    cache = defs;
  } catch (err) {
    accessGroups.applyJobRoleOverrides(previous);
    rbac.recompileJobRoles();
    throw err instanceof JobRoleError ? err : new JobRoleError(`That change doesn't work: ${err.message}`);
  }
}

const toDef = (d) => ({
  slug: d.slug, custom: !!d.custom, label: d.label, description: d.description || '',
  values: d.values, grants: (d.grants || []).map((g) => ({ group: g.group, level: g.level, scope: g.scope, values: g.values })),
  disabled: !!d.disabled,
});

async function load() {
  const Model = mdb.INTERNAL?.jobRoleConfig;
  if (!Model) return [];
  const docs = await Model.find({}).lean();
  const usable = [];
  for (const d of docs) {
    // A stored role that no longer fits (e.g. a group removed in an upgrade)
    // is skipped, not fatal: the defaults keep working.
    try {
      usable.push(validate(toDef(d), { slug: d.slug, custom: !!d.custom }));
    } catch (err) {
      logger.warn(`[jobRoleConfig] Skipping stored job role "${d.slug}": ${err.message}`);
    }
  }
  apply(usable);
  if (usable.length) logger.info(`[jobRoleConfig] Applied ${usable.length} job role change(s) from the database.`);
  return usable;
}

async function persist(def, user) {
  const Model = mdb.INTERNAL?.jobRoleConfig;
  if (!Model) fail('The database isn\'t ready.');
  // findOne + save so the audit plugin sees the change
  let doc = await Model.findOne({ slug: def.slug });
  if (!doc) doc = new Model({ slug: def.slug });
  Object.assign(doc, { custom: def.custom, label: def.label, description: def.description, values: def.values, grants: def.grants, disabled: def.disabled, updatedBy: user?._id || null });
  await doc.save();
}

/** Save a changed built-in role, or an added one that already exists. */
async function save(slug, input, user) {
  const custom = !accessGroups.defaultJobRoles[slug];
  if (custom && !cache.some((d) => d.slug === slug)) fail('There is no such job role.');
  const def = validate(input, { slug, custom });
  const previous = cache;
  apply([...cache.filter((d) => d.slug !== slug), def]);
  try {
    await persist(def, user);
  } catch (err) {
    apply(previous);
    throw err;
  }
  return def;
}

/** camelCase identifier from a name, unique among job roles. */
export function slugFor(label) {
  const words = clean(label).normalize('NFKD').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  let base = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('');
  if (!/^[a-z]/.test(base)) base = `role${base[0] ? base[0].toUpperCase() + base.slice(1) : ''}`;
  base = base.slice(0, 36);
  if (base.length < 2) base = 'role';
  const taken = (s) => accessGroups.jobRoles[s] || accessGroups.RESERVED_ROLE_SLUGS.includes(s);
  let slug = base;
  for (let n = 2; taken(slug); n += 1) slug = `${base}${n}`;
  return slug;
}

/** Add a job role. It starts turned off, with no areas, for the admin to fill in. */
async function create(label, user) {
  const slug = slugFor(label);
  const def = validate({ label, description: '', values: 'never', grants: [], disabled: true }, { slug, custom: true });
  const previous = cache;
  apply([...cache, def]);
  try {
    await persist(def, user);
  } catch (err) {
    apply(previous);
    throw err;
  }
  return def;
}

/** How many users hold each job role in roles[]: { slug: n }. */
async function holders() {
  const User = mdb.INTERNAL?.user;
  if (!User) return {};
  const rows = await User.aggregate([{ $unwind: '$roles' }, { $group: { _id: '$roles', n: { $sum: 1 } } }]);
  return Object.fromEntries(rows.map((r) => [r._id, r.n]));
}

/** Reset a built-in role to its default, or delete an added one nobody holds. */
async function reset(slug) {
  const Model = mdb.INTERNAL?.jobRoleConfig;
  if (!Model) fail('The database isn\'t ready.');
  const custom = !accessGroups.defaultJobRoles[slug];
  if (custom) {
    const n = (await holders())[slug] || 0;
    if (n) fail(`${n} ${n === 1 ? 'person holds' : 'people hold'} this job role. Take it off them first, or turn the role off.`);
  }
  apply(cache.filter((d) => d.slug !== slug));
  const doc = await Model.findOne({ slug });
  if (doc) await doc.deleteOne();
}

function list() { return cache.slice(); }

/** Has the company changed this role from its code default (or added it)? */
function isChanged(slug) { return cache.some((d) => d.slug === slug); }

export default { load, save, create, reset, list, isChanged, holders, validate, groupScopable, maxLevel, slugFor, JobRoleError };
export { load, save, create, reset, list, isChanged, holders };
