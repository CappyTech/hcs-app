/**
 * Project scope: which records a project-scoped job role (Site Manager,
 * Supervisor) may see.
 *
 * A user runs a site when a contract names them in `siteManagers` and the
 * contract isn't Completed. From those contracts come the sets every scoped
 * model filters on (accessGroupsConfig.PROJECT_SCOPE_FIELDS): the contracts
 * themselves, their projects (by _id and by KashFlow Number), quotes and
 * locations.
 *
 * Resolved once per request and cached on req, because a list page can ask
 * for several models' scopes.
 */
import mdb from './mongooseDatabaseService.js';
import accessGroups from '../config/accessGroupsConfig.js';

const EMPTY = Object.freeze({
  contractIds: [], projectIds: [], projectNumbers: [], quoteIds: [], locationIds: [],
});

/**
 * The scope sets for a user. Never throws: on a database error the sets are
 * empty, so a scoped query matches nothing (fails closed).
 * @param {Object} user  req.user
 * @param {Object} [db]  mongooseDatabaseService (tests pass a stub)
 */
export async function resolve(user, db = mdb) {
  const Contract = db.INTERNAL?.contract;
  if (!user?._id || !Contract) return EMPTY;
  try {
    const contracts = await Contract
      .find({ siteManagers: user._id, status: { $ne: 'Completed' } })
      .select('_id projectId quoteId locationId')
      .lean();
    const ids = (key) => [...new Map(contracts
      .map((c) => c[key]).filter(Boolean).map((v) => [String(v), v])).values()];
    const projectIds = ids('projectId');
    let projectNumbers = [];
    if (projectIds.length && db.REST?.project) {
      const projects = await db.REST.project.find({ _id: { $in: projectIds } }).select('Number').lean();
      projectNumbers = projects.map((p) => p.Number).filter((n) => n != null);
    }
    return {
      contractIds: contracts.map((c) => c._id),
      projectIds,
      projectNumbers,
      quoteIds: ids('quoteId'),
      locationIds: ids('locationId'),
    };
  } catch {
    return EMPTY;
  }
}

/** resolve(), cached on the request. */
export async function forRequest(req, db = mdb) {
  if (!req._projectScope) req._projectScope = resolve(req.user, db);
  return req._projectScope;
}

/**
 * The Mongo filter that limits `model` to the user's sites, or null when the
 * model has no project mapping (the caller then grants nothing).
 * @param {string} model
 * @param {Object} sets  from resolve()
 */
export function filterFor(model, sets) {
  const spec = accessGroups.PROJECT_SCOPE_FIELDS[model];
  if (!spec) return null;
  const parts = (Array.isArray(spec) ? spec : [spec])
    .map(({ field, set }) => ({ [field]: { $in: sets[set] || [] } }));
  return parts.length === 1 ? parts[0] : { $or: parts };
}

export default { resolve, forRequest, filterFor };
