/**
 * Project scope: which records a project-scoped job role (Site Manager,
 * Supervisor) may see.
 *
 * A user runs a site when a contract names them in `siteManagers` and the
 * contract isn't Completed. From those contracts come the sets every scoped
 * model filters on (accessGroupsConfig.PROJECT_SCOPE_FIELDS): the contracts
 * themselves, their projects (by _id and by KashFlow Number), quotes and
 * locations, and the people assigned to them in the last four weeks or the
 * coming week (so a site manager can check the cards of who is on site).
 *
 * Resolved once per request and cached on req, because a list page can ask
 * for several models' scopes.
 */
import mdb from './mongooseDatabaseService.js';
import accessGroups from '../config/accessGroupsConfig.js';

const EMPTY = Object.freeze({
  contractIds: [], projectIds: [], projectNumbers: [], quoteIds: [], locationIds: [],
  employeeIds: [], subcontractorIds: [],
});

const DAY_MS = 24 * 60 * 60 * 1000;
// Who counts as "on a site": assigned to it from four weeks ago to a week
// ahead. Shared with the induction form, which offers the same people.
export const PEOPLE_WINDOW_BACK = 28 * DAY_MS;
export const PEOPLE_WINDOW_AHEAD = 7 * DAY_MS;

const uniq = (values) => [...new Map(values.filter(Boolean).map((v) => [String(v), v])).values()];

/** The people assigned to `contractIds` around `now`. */
async function sitePeople(db, contractIds, now) {
  const Assignment = db.INTERNAL?.assignment;
  if (!contractIds.length || !Assignment) return { employeeIds: [], subcontractorIds: [] };
  const rows = await Assignment
    .find({
      contractId: { $in: contractIds },
      weekStart: { $gte: new Date(now.getTime() - PEOPLE_WINDOW_BACK), $lte: new Date(now.getTime() + PEOPLE_WINDOW_AHEAD) },
    })
    .select('assignedEmployees assignedSubcontractors')
    .lean();
  return {
    employeeIds: uniq(rows.flatMap((a) => a.assignedEmployees || [])),
    subcontractorIds: uniq(rows.flatMap((a) => a.assignedSubcontractors || [])),
  };
}

/**
 * The scope sets for a user. Never throws: on a database error the sets are
 * empty, so a scoped query matches nothing (fails closed).
 * @param {Object} user  req.user
 * @param {Object} [db]  mongooseDatabaseService (tests pass a stub)
 * @param {Date} [now]
 */
export async function resolve(user, db = mdb, now = new Date()) {
  const Contract = db.INTERNAL?.contract;
  if (!user?._id || !Contract) return EMPTY;
  try {
    const contracts = await Contract
      .find({ siteManagers: user._id, status: { $ne: 'Completed' } })
      .select('_id projectId quoteId locationId')
      .lean();
    const ids = (key) => uniq(contracts.map((c) => c[key]));
    const projectIds = ids('projectId');
    let projectNumbers = [];
    if (projectIds.length && db.REST?.project) {
      const projects = await db.REST.project.find({ _id: { $in: projectIds } }).select('Number').lean();
      projectNumbers = projects.map((p) => p.Number).filter((n) => n != null);
    }
    const contractIds = contracts.map((c) => c._id);
    return {
      contractIds,
      projectIds,
      projectNumbers,
      quoteIds: ids('quoteId'),
      locationIds: ids('locationId'),
      ...(await sitePeople(db, contractIds, now)),
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

export default { resolve, forRequest, filterFor, PEOPLE_WINDOW_BACK, PEOPLE_WINDOW_AHEAD };
