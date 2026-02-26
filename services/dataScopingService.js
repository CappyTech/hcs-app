/**
 * Data-scoping service: builds Mongoose query filters based on the
 * logged-in user's role and their linked entity.
 *
 * Admin and unrestricted-read roles get `{}` (no filter).
 * Ownership-scoped roles (employee, subcontractor, client) get a filter
 * that limits results to their own records.
 */

const rbac = require('../mongoose/config/rolePermissionsConfig');
const logger = require('./loggerService');

/**
 * Build a Mongoose filter object that scopes a query to the current user.
 *
 * Usage in a controller:
 *   const filter = await scopeQuery(req, 'attendance');
 *   const records = await Model.find(filter);
 *
 * @param {Object}  req       Express request (must have req.user populated)
 * @param {string}  model     Model name as it appears in rolePermissionsConfig
 * @param {string}  [operation='r'] CRUD operation character
 * @returns {Object} Mongoose query filter (may be empty `{}`)
 */
async function scopeQuery(req, model, operation = 'r') {
  if (!req.user) return null; // caller should 401

  const role = req.user.role;

  // Admin bypasses all scoping
  if (role === 'admin') return {};

  const customPerms = req.user?.customPermissions || {};
  const { allowed, ownOnly } = rbac.canAccess(role, model, operation, customPerms);
  if (!allowed) return null; // caller should 403

  // If not own-only, return unscoped
  if (!ownOnly) return {};

  // Resolve ownership
  const ownerCfg = rbac.getOwnershipConfig(role, model);
  if (!ownerCfg) {
    logger.warn(`[dataScopingService] No ownership mapping for role="${role}" model="${model}"`);
    return null;
  }

  const userEntityId = req.user[ownerCfg.userField];
  if (!userEntityId) {
    logger.warn(`[dataScopingService] User ${req.user.uuid} (${role}) has no ${ownerCfg.userField}`);
    return null;
  }

  // For REST models that use KashFlow-style numeric Ids (e.g. SupplierId, CustomerId)
  // we may need to resolve the linked document's Id field.
  const mdb = require('../mongoose/services/mongooseDatabaseService');

  if (['SupplierId', 'CustomerId', 'CustomerCode'].includes(ownerCfg.modelField)) {
    // Find the linked entity to get its KashFlow Id/Code
    const linkedDoc = await resolveLinkedEntity(mdb, role, userEntityId);
    if (!linkedDoc) {
      logger.warn(`[dataScopingService] Could not resolve linked entity for user ${req.user.uuid}`);
      return null;
    }

    if (ownerCfg.modelField === 'SupplierId') {
      return { SupplierId: linkedDoc.Id };
    }
    if (ownerCfg.modelField === 'CustomerId') {
      return { CustomerId: linkedDoc.Id };
    }
    if (ownerCfg.modelField === 'CustomerCode') {
      return { CustomerCode: linkedDoc.Code };
    }
  }

  // Standard ObjectId-based ownership
  return { [ownerCfg.modelField]: userEntityId };
}

/**
 * Resolve the linked KashFlow entity for a user's role.
 */
async function resolveLinkedEntity(mdb, role, entityId) {
  try {
    if (role === 'subcontractor') {
      return await mdb.REST.supplier.findById(entityId);
    }
    if (role === 'client') {
      return await mdb.REST.customer.findById(entityId);
    }
    return null;
  } catch (err) {
    logger.error(`[dataScopingService] resolveLinkedEntity error: ${err.message}`);
    return null;
  }
}

/**
 * Shortcut: get filter or throw appropriate error.
 * Use in route handlers that need a clean pattern.
 */
function scopeQueryOrError(req, model, operation = 'r') {
  return scopeQuery(req, model, operation).then(filter => {
    if (filter === null) {
      const err = new Error(
        req.user ? `Access denied to ${model}` : 'Not authenticated'
      );
      err.statusCode = req.user ? 403 : 401;
      throw err;
    }
    return filter;
  });
}

module.exports = {
  scopeQuery,
  scopeQueryOrError,
};
