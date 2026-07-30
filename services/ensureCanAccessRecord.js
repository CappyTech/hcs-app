/**
 * Authorise a document request against its *parent record*, not just a role.
 *
 * The file routes were previously gated on ensureRole("admin"), which is both too
 * strict (nobody else could ever see a document attached to a record they own) and
 * the wrong axis — it says nothing about whether this user may see *this* record.
 *
 * This middleware reuses the RBAC primitives the rest of the app already uses:
 *   1. rbac.canAccess(role, model, operation) — may this role touch this model at all,
 *      and is it restricted to its own records?
 *   2. rbac.getOwnershipConfig(...) — build the ownership filter for own-only roles.
 *   3. Load the parent record through that filter. If it does not come back, the user
 *      cannot see the record, so they cannot see its documents either.
 *
 * Admin keeps its existing bypass, exactly as canAccess/ensureOwnership define it.
 */
import rbac from '../mongoose/config/rolePermissionsConfig.js';
import mdb from '../mongoose/services/mongooseDatabaseService.js';

export default function ensureCanAccessRecord(operation = 'r') {
  return async (req, res, next) => {
    if (!req.user) {
      return next({
        statusCode: 401,
        name: 'UnauthorizedError',
        message: 'User not authenticated',
      });
    }

    const modelName = String(req.params.model || '').toLowerCase();
    const { uuid } = req.params;
    const customPerms = req.user.customPermissions || {};

    const { allowed, ownOnly } = rbac.canAccess(
      req.user.role,
      modelName,
      operation,
      customPerms,
    );
    if (!allowed) {
      return next({
        statusCode: 403,
        name: 'ForbiddenError',
        message: `Role "${req.user.role}" cannot ${operation} on ${modelName}`,
      });
    }

    let filter = { uuid };
    if (ownOnly) {
      const ownerCfg = rbac.getOwnershipConfig(req.user.role, modelName);
      if (!ownerCfg) {
        return next({
          statusCode: 403,
          name: 'ForbiddenError',
          message: `No ownership mapping for role "${req.user.role}" on model "${modelName}"`,
        });
      }
      const userEntityId = req.user[ownerCfg.userField];
      if (!userEntityId) {
        return next({
          statusCode: 403,
          name: 'ForbiddenError',
          message: `User has no linked ${ownerCfg.userField}`,
        });
      }
      filter = { ...filter, [ownerCfg.modelField]: userEntityId };
    }

    try {
      const model = mdb[modelName];
      if (!model) {
        return next({
          statusCode: 404,
          name: 'NotFoundError',
          message: `Unknown model "${modelName}"`,
        });
      }

      const record = await model.findOne(filter).lean();
      if (!record) {
        // Deliberately 404, not 403: telling an unauthorised caller that the record
        // exists but is off-limits leaks its existence.
        return next({
          statusCode: 404,
          name: 'NotFoundError',
          message: 'Record not found',
        });
      }

      req.parentRecord = record;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
