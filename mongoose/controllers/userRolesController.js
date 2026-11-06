/**
 * Assign job roles (user.roles[]) to a user.
 *
 * Kept out of the generic CRUD form on purpose: `roles` is hidden there, and
 * this one handler is the only way it changes, so the allow-list check and
 * the audit record can't be skipped. Admin only (adminRoutes.js).
 */
import mdb from '../services/mongooseDatabaseService.js';
import rbac from '../config/rolePermissionsConfig.js';
import auditLog from '../../services/auditLogService.js';

/**
 * Normalise the posted `roles` field to available job role slugs.
 * Unknown or unavailable values are dropped, not saved.
 * @param {string|string[]|undefined} raw
 * @returns {string[]}
 */
export function parseRoles(raw) {
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return [...new Set(list.map((r) => String(r).trim()))].filter((r) => rbac.JOB_ROLES.has(r));
}

export const postUserRoles = async (req, res, next) => {
  try {
    const { uuid } = req.params;
    const user = await mdb.INTERNAL.user.findOne({ uuid });
    if (!user) {
      return next({ statusCode: 404, name: 'NotFoundError', message: 'User not found.' });
    }

    const next_ = parseRoles(req.body.roles);
    const previous = [...(user.roles || [])];
    user.roles = next_;
    await user.save();

    const changed = previous.length !== next_.length || previous.some((r) => !next_.includes(r));
    if (changed) {
      auditLog.record('role_changed', req, {
        userId: user._id,
        username: user.username,
        meta: { field: 'roles', from: previous, to: next_ },
      });
    }

    if (typeof req.flash === 'function') {
      req.flash('success', changed ? 'Job roles updated.' : 'Job roles unchanged.');
    }
    return res.redirect(`/user/update/${encodeURIComponent(uuid)}`);
  } catch (err) {
    return next(err);
  }
};

export default { postUserRoles, parseRoles };
