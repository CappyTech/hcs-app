/**
 * Data-scoping service: builds Mongoose query filters based on the
 * logged-in user's role and their linked entity.
 *
 * Admin and unrestricted-read roles get `{}` (no filter).
 * Ownership-scoped roles (employee, subcontractor, client) get a filter
 * that limits results to their own records.
 */

const rbac = require("../mongoose/config/rolePermissionsConfig");
const logger = require("./loggerService");

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
async function scopeQuery(req, model, operation = "r") {
  if (!req.user) return null; // caller should 401

  const role = req.user.role;

  // Admin bypasses all scoping
  if (role === "admin") return {};

  const customPerms = req.user?.customPermissions || {};
  const { allowed, ownOnly } = rbac.canAccess(
    role,
    model,
    operation,
    customPerms,
  );
  if (!allowed) return null; // caller should 403

  // If not own-only, return unscoped
  if (!ownOnly) return {};

  // Resolve ownership — build filter for the user's primary role, then
  // extend with a secondary role when both employeeId and subcontractorId
  // are set (IR35 off-payroll workers).
  const mdb = require("../mongoose/services/mongooseDatabaseService");

  const primaryFilter = await buildOwnershipFilter(req, mdb, role, model);
  if (!primaryFilter) return null;

  // IR35 dual-link: if the employee record has ir35 + subcontractorSupplierId,
  // or the user has both employeeId and subcontractorId, extend the filter
  // so the worker sees data from both capacities.
  if (role === "employee" || role === "subcontractor") {
    const dualRole = await resolveIR35DualRole(req, mdb, role);
    if (dualRole) {
      const secondaryFilter = await buildOwnershipFilter(req, mdb, dualRole, model);
      if (secondaryFilter) {
        return { $or: [primaryFilter, secondaryFilter] };
      }
    }
  }

  return primaryFilter;
}

/**
 * Build a Mongoose ownership filter for a given role + model.
 * Returns null if no mapping exists or the user lacks the required link.
 */
async function buildOwnershipFilter(req, mdb, role, model) {
  const ownerCfg = rbac.getOwnershipConfig(role, model);
  if (!ownerCfg) return null;

  const userEntityId = req.user[ownerCfg.userField]
    || (ownerCfg.userField === "subcontractorId" && req.user._ir35SupplierId)
    || null;
  if (!userEntityId) return null;

  if (
    ["SupplierId", "CustomerId", "CustomerCode"].includes(ownerCfg.modelField)
  ) {
    const linkedDoc = await resolveLinkedEntity(mdb, role, userEntityId);
    if (!linkedDoc) return null;

    if (ownerCfg.modelField === "SupplierId") return { SupplierId: linkedDoc.Id };
    if (ownerCfg.modelField === "CustomerId") return { CustomerId: linkedDoc.Id };
    if (ownerCfg.modelField === "CustomerCode") return { CustomerCode: linkedDoc.Code };
  }

  return { [ownerCfg.modelField]: userEntityId };
}

/**
 * Determine whether this user has an IR35 dual-role.
 * Checks: 1) employee.ir35 flag with subcontractorSupplierId, or
 *         2) user model dual-link (employeeId + subcontractorId).
 * Returns the secondary role name, or null.
 */
async function resolveIR35DualRole(req, mdb, primaryRole) {
  // Path 1: employee record has ir35 flag
  if (primaryRole === "employee" && req.user.employeeId) {
    try {
      const emp = await mdb.INTERNAL.employee
        .findById(req.user.employeeId)
        .select("ir35 subcontractorSupplierId")
        .lean();
      if (emp?.ir35 && emp.subcontractorSupplierId) {
        // Temporarily set subcontractorId on req.user so buildOwnershipFilter
        // can resolve the supplier link.
        if (!req.user.subcontractorId) {
          req.user._ir35SupplierId = emp.subcontractorSupplierId;
        }
        return "subcontractor";
      }
    } catch (_) { /* proceed without dual-role */ }
  }

  // Path 2: user model dual-link (legacy / direct assignment)
  if (primaryRole === "employee" && req.user.subcontractorId) return "subcontractor";
  if (primaryRole === "subcontractor" && req.user.employeeId) return "employee";

  return null;
}

/**
 * Resolve the linked KashFlow entity for a user's role.
 */
async function resolveLinkedEntity(mdb, role, entityId) {
  try {
    if (role === "subcontractor") {
      return await mdb.REST.supplier.findById(entityId);
    }
    if (role === "client") {
      return await mdb.REST.customer.findById(entityId);
    }
    return null;
  } catch (err) {
    logger.error(
      `[dataScopingService] resolveLinkedEntity error: ${err.message}`,
    );
    return null;
  }
}

/**
 * Shortcut: get filter or throw appropriate error.
 * Use in route handlers that need a clean pattern.
 */
function scopeQueryOrError(req, model, operation = "r") {
  return scopeQuery(req, model, operation).then((filter) => {
    if (filter === null) {
      const err = new Error(
        req.user ? `Access denied to ${model}` : "Not authenticated",
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
