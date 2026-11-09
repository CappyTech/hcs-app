/**
 * The Health & Safety panel on a contract's page: inductions, RAMS and
 * briefings for that site, shown only to people who can read those records
 * across a site or more. Accident reports are deliberately not included: that
 * book is health data and has its own, narrower access.
 */
import mdb from './mongooseDatabaseService.js';
import rbac from '../config/rolePermissionsConfig.js';
import { scopeQuery } from '../../services/dataScopingService.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DUE_WINDOW = 30 * DAY_MS;

/**
 * The filter for this model on this contract, or null when the viewer may not
 * see it. Own-only access (an employee's own induction) doesn't open the panel.
 */
async function siteFilter(req, model, contractId) {
  const user = req.user;
  const access = rbac.canAccess(rbac.rolesOf(user), model, 'l', user.customPermissions || {});
  if (user.role !== 'admin' && (!access.allowed || (access.ownOnly && !access.projectScoped))) return null;
  const scope = await scopeQuery(req, model, 'l');
  if (!scope) return null;
  return Object.keys(scope).length ? { $and: [{ contractId }, scope] } : { contractId };
}

/**
 * @param {Object} req        needs req.user
 * @param {Object} contract   the contract (uses _id)
 * @returns {Promise<null|{inductions:?Object, rams:?Object, briefings:?Object}>}
 */
export async function siteSafety(req, contract, db = mdb, now = new Date()) {
  if (!req?.user || !contract?._id) return null;
  const soon = new Date(now.getTime() + DUE_WINDOW);
  const { induction: Induction, rams: Rams, ramsBriefing: Briefing } = db.INTERNAL || {};
  const [inductionWhere, ramsWhere, briefingWhere] = await Promise.all(
    ['induction', 'rams', 'ramsBriefing'].map((m) => siteFilter(req, m, contract._id)),
  );

  const inductions = inductionWhere && Induction ? {
    total: await Induction.countDocuments(inductionWhere),
    unsigned: await Induction.countDocuments({ $and: [inductionWhere, { acknowledged: { $ne: true } }] }),
    due: await Induction.countDocuments({ $and: [inductionWhere, { expiryDate: { $ne: null, $lte: soon } }] }),
  } : null;

  let rams = null;
  if (ramsWhere && Rams) {
    const current = { $and: [ramsWhere, { status: { $ne: 'Superseded' } }] };
    rams = {
      total: await Rams.countDocuments(current),
      draft: await Rams.countDocuments({ $and: [ramsWhere, { status: 'Draft' }] }),
      reviewDue: await Rams.countDocuments({ $and: [current, { reviewDate: { $ne: null, $lte: soon } }] }),
      rows: await Rams.find(current)
        .select('uuid title version status reviewDate')
        .sort({ updatedAt: -1 }).limit(10).lean(),
    };
  }

  const briefings = briefingWhere && Briefing ? { total: await Briefing.countDocuments(briefingWhere) } : null;

  if (!inductions && !rams && !briefings) return null;
  return { inductions, rams, briefings };
}

export default { siteSafety };
