/**
 * Role-Based Access Control (RBAC) configuration.
 *
 * Single source of truth for what each role can access.
 * Used by authService middleware, route files, controllers, templates.
 *
 * Roles: none | admin | accountant | employee | subcontractor | client | hmrc
 */

// ── Departments each role may access ──────────────────────────────────
const roleDepartments = {
  none: [],
  admin: [
    'construction-industry-scheme',
    'management',
    'payroll',
    'human-resources',
    'kashflow',
    'paperless',
    'finance',
  ],
  accountant: [
    'construction-industry-scheme',
    'kashflow',
    'finance',
  ],
  employee: [],
  subcontractor: [
    'construction-industry-scheme', // own CIS returns only
  ],
  client: [],
  hmrc: [
    'construction-industry-scheme',
  ],
};

// ── CRUD permissions per model per role ───────────────────────────────
// Operations: c = create, r = read, u = update, d = delete, l = list
// 'own' suffix means scoped to the user's linked entity (e.g. 'r:own')
const roleModelAccess = {
  none: {
    // No model access — awaiting role assignment by admin.
  },

  admin: {
    // Admin has unrestricted access — handled as a bypass in middleware.
    // Listed here for documentation only.
    _wildcard: 'crudl',
  },

  accountant: {
    invoice:    'rl',
    purchase:   'rl',     // listed as "supplier" receipts in KashFlow
    supplier:   'rl',
    customer:   'rl',
    project:    'rl',
    quote:      'rl',
    nominal:    'rl',
    note:       'rl',
  },

  employee: {
    attendance:       'r:own,l:own,c:own',
    employee:         'r:own',
    employeeHoliday:  'r:own,l:own',
    vehicle:          'r:own,l:own',
    vehicleFuelLog:   'r:own,l:own',
    vehicleMileageLog:'r:own,l:own',
  },

  subcontractor: {
    attendance:       'r:own,l:own,c:own',
    supplier:         'r:own',
    purchase:         'r:own,l:own',
    vehicle:          'r:own,l:own',
    vehicleFuelLog:   'r:own,l:own',
    vehicleMileageLog:'r:own,l:own',
  },

  client: {
    customer: 'r:own',
    invoice:  'r:own,l:own',
    quote:    'r:own,l:own',
    project:  'r:own,l:own',
  },

  hmrc: {
    supplier: 'rl',   // subcontractor verification data
  },
};

// ── Ownership field map ──────────────────────────────────────────────
// Maps role → the User model field that links to the entity,
// and model → the document field that identifies the owner.
const ownershipFields = {
  employee: {
    userField: 'employeeId',        // req.user.employeeId
    modelFields: {
      attendance:        'employeeId',
      employee:          '_id',
      employeeHoliday:   'employeeId',
      vehicle:           'employeeId',
      vehicleFuelLog:    'employeeId',
      vehicleMileageLog: 'employeeId',
    },
  },
  subcontractor: {
    userField: 'subcontractorId',   // req.user.subcontractorId
    modelFields: {
      attendance:        'subcontractorId',
      supplier:          '_id',
      purchase:          'SupplierId',
      vehicle:           'subcontractorId',
      vehicleFuelLog:    'subcontractorId',
      vehicleMileageLog: 'subcontractorId',
    },
  },
  client: {
    userField: 'clientId',          // req.user.clientId
    modelFields: {
      customer: '_id',
      invoice:  'CustomerId',
      quote:    'CustomerId',
      project:  'CustomerCode',
    },
  },
};

// ── Custom route access (non-CRUD routes) ────────────────────────────
// Maps route pattern → allowed roles.
const routeAccess = {
  // Attendance views
  '/daily':               ['admin', 'employee', 'subcontractor'],
  '/weekly':              ['admin', 'employee', 'subcontractor'],
  '/weekly-management':   ['admin'],
  '/attendance/submit':   ['employee', 'subcontractor'],
  '/attendance/approve':  ['admin'],
  '/attendance/reject':   ['admin'],
  '/attendance/bulk-approve': ['admin'],

  // CIS
  '/CIS/Dashboard':       ['admin', 'accountant', 'hmrc'],
  '/CIS/returns':         ['admin', 'accountant', 'hmrc', 'subcontractor'],

  // Subcontractor administration
  '/subcontractor/assign':['admin'],
  '/supplier/change':     ['admin'],

  // Submission changes
  '/receipts/change-submission': ['admin'],
  '/purchase/change':            ['admin'],

  // Department dashboards
  '/construction-industry-scheme': ['admin', 'accountant', 'hmrc', 'subcontractor'],
  '/management':          ['admin'],
  '/payroll':             ['admin'],
  '/human-resources':     ['admin'],
  '/kashflow':            ['admin', 'accountant'],
  '/create':              ['admin'],
  '/paperless':           ['admin'],
  '/finance':             ['admin', 'accountant'],

  // Settings / profile (all authenticated users)
  '/user/profile':        '*',
  '/user/account':        '*',
  '/user/2fa':            '*',
  '/user/logout':         '*',

  // Holiday dismiss (all authenticated users)
  '/holiday/dismiss':     '*',

  // Fleet
  '/fleet':               ['admin'],

  // Logs
  '/logs':                ['admin'],

  // Files
  '/files':               ['admin'],

  // Paperless OCR
  '/paperless/ocr':       ['admin'],
};

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Parse a permission string like 'r:own,l:own,c' into entries.
 * @param {string} perms
 * @returns {{ op: string, scope: string|undefined }[]}
 */
function parsePerms(perms) {
  if (!perms) return [];
  return perms.split(',').map(e => {
    const [op, scope] = e.trim().split(':');
    return { op, scope };
  });
}

/**
 * Return the departments a role can access, merged with any custom
 * per-user departments.
 * @param {string} role
 * @param {Object} [customPerms]  user.customPermissions
 * @returns {string[]}
 */
function getDepartmentsForRole(role, customPerms) {
  const base = roleDepartments[role] || [];
  const extra = customPerms?.departments || [];
  if (!extra.length) return base;
  return [...new Set([...base, ...extra])];
}

/**
 * Check whether a role (+ optional custom permissions) may perform an
 * operation on a model.
 * @param {string}  role
 * @param {string}  model
 * @param {string}  operation  one of 'c','r','u','d','l'
 * @param {Object}  [customPerms]  user.customPermissions
 * @returns {{ allowed: boolean, ownOnly: boolean }}
 */
function canAccess(role, model, operation, customPerms) {
  if (role === 'admin') return { allowed: true, ownOnly: false };

  // 1) Check role-level access
  const access = roleModelAccess[role];
  if (access) {
    const perms = access[model];
    if (perms) {
      for (const { op, scope } of parsePerms(perms)) {
        if (op === operation) {
          return { allowed: true, ownOnly: scope === 'own' };
        }
      }
    }
  }

  // 2) Check user-level custom permissions (always additive)
  if (customPerms?.models) {
    const customModelPerms = customPerms.models instanceof Map
      ? customPerms.models.get(model)
      : customPerms.models[model];
    if (customModelPerms) {
      for (const { op, scope } of parsePerms(customModelPerms)) {
        if (op === operation) {
          // Custom per-user model access is never own-scoped (admin granted it)
          return { allowed: true, ownOnly: false };
        }
      }
    }
  }

  return { allowed: false, ownOnly: false };
}

/**
 * Return the ownership config for a role + model combination.
 * @param {string} role
 * @param {string} model
 * @returns {{ userField: string, modelField: string } | null}
 */
function getOwnershipConfig(role, model) {
  const cfg = ownershipFields[role];
  if (!cfg) return null;
  const modelField = cfg.modelFields[model];
  if (!modelField) return null;
  return { userField: cfg.userField, modelField };
}

/**
 * Get the allowed roles for a custom route.
 * Returns '*' for any-authenticated, an array of role strings, or null.
 * @param {string} routePattern
 * @returns {string[]|'*'|null}
 */
function getAllowedRolesForRoute(routePattern) {
  return routeAccess[routePattern] || null;
}

/**
 * Match a real request path (e.g. '/CIS/Dashboard/2026/2') to the best
 * routeAccess key using longest-prefix matching.
 * Returns the matched pattern key, or null if no pattern covers this path.
 * @param {string} reqPath
 * @returns {string|null}
 */
function matchRoutePattern(reqPath) {
  // Strip trailing slash for consistent comparison
  const normalised = reqPath.endsWith('/') && reqPath.length > 1
    ? reqPath.slice(0, -1)
    : reqPath;
  let best = null;
  let bestLen = 0;
  for (const pattern of Object.keys(routeAccess)) {
    if (normalised === pattern || normalised.startsWith(pattern + '/')) {
      if (pattern.length > bestLen) { best = pattern; bestLen = pattern.length; }
    }
  }
  return best;
}

/**
 * Check whether a user can access a custom route (role + custom grants).
 * @param {string} role
 * @param {string} routePattern
 * @param {Object} [customPerms]  user.customPermissions
 * @returns {boolean}
 */
function canAccessRoute(role, routePattern, customPerms) {
  if (role === 'admin') return true;
  const allowed = routeAccess[routePattern];
  if (allowed === '*') return true;
  if (Array.isArray(allowed) && allowed.includes(role)) return true;
  if (customPerms?.routes?.includes(routePattern)) return true;
  return false;
}

/**
 * Check whether a role can access a given department.
 * @param {string} role
 * @param {string} department
 * @param {Object} [customPerms]  user.customPermissions
 * @returns {boolean}
 */
function canAccessDepartment(role, department, customPerms) {
  if (role === 'admin') return true;
  if ((roleDepartments[role] || []).includes(department)) return true;
  if (customPerms?.departments?.includes(department)) return true;
  return false;
}

/**
 * Get all models a role can list (for nav/UI filtering).
 * @param {string} role
 * @param {Object} [customPerms]  user.customPermissions
 * @returns {{ model: string, ownOnly: boolean }[]}
 */
function getListableModels(role, customPerms) {
  if (role === 'admin') return [{ model: '_wildcard', ownOnly: false }];

  const result = [];
  const seen = new Set();

  // Role-level
  const access = roleModelAccess[role];
  if (access) {
    for (const [model, perms] of Object.entries(access)) {
      const { allowed, ownOnly } = canAccess(role, model, 'l');
      if (allowed) { result.push({ model, ownOnly }); seen.add(model); }
    }
  }

  // Custom user-level
  if (customPerms?.models) {
    const entries = customPerms.models instanceof Map
      ? [...customPerms.models.entries()]
      : Object.entries(customPerms.models);
    for (const [model, perms] of entries) {
      if (seen.has(model)) continue;
      for (const { op } of parsePerms(perms)) {
        if (op === 'l') { result.push({ model, ownOnly: false }); seen.add(model); break; }
      }
    }
  }

  return result;
}

module.exports = {
  roleDepartments,
  roleModelAccess,
  ownershipFields,
  routeAccess,
  getDepartmentsForRole,
  canAccess,
  canAccessRoute,
  matchRoutePattern,
  getOwnershipConfig,
  getAllowedRolesForRoute,
  canAccessDepartment,
  getListableModels,
};
