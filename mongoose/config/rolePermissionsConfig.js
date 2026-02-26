/**
 * Role-Based Access Control (RBAC) configuration.
 *
 * Single source of truth for what each role can access.
 * Used by authService middleware, route files, controllers, templates.
 *
 * Roles: admin | accountant | employee | subcontractor | client | hmrc
 */

// ── Departments each role may access ──────────────────────────────────
const roleDepartments = {
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
 * Return the departments a role can access.
 * @param {string} role
 * @returns {string[]}
 */
function getDepartmentsForRole(role) {
  return roleDepartments[role] || [];
}

/**
 * Check whether a role may perform an operation on a model.
 * @param {string}  role       e.g. 'accountant'
 * @param {string}  model      e.g. 'invoice'
 * @param {string}  operation  one of 'c','r','u','d','l'
 * @returns {{ allowed: boolean, ownOnly: boolean }}
 */
function canAccess(role, model, operation) {
  if (role === 'admin') return { allowed: true, ownOnly: false };

  const access = roleModelAccess[role];
  if (!access) return { allowed: false, ownOnly: false };

  const perms = access[model];
  if (!perms) return { allowed: false, ownOnly: false };

  // Parse permission string, e.g. 'r:own,l:own,c:own'
  const entries = perms.split(',').map(e => e.trim());
  for (const entry of entries) {
    const [op, scope] = entry.split(':');
    if (op === operation) {
      return { allowed: true, ownOnly: scope === 'own' };
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
 * Check whether a role can access a given department.
 * @param {string} role
 * @param {string} department
 * @returns {boolean}
 */
function canAccessDepartment(role, department) {
  if (role === 'admin') return true;
  return (roleDepartments[role] || []).includes(department);
}

/**
 * Get all models a role can list (for nav/UI filtering).
 * @param {string} role
 * @returns {{ model: string, ownOnly: boolean }[]}
 */
function getListableModels(role) {
  if (role === 'admin') return [{ model: '_wildcard', ownOnly: false }];

  const access = roleModelAccess[role];
  if (!access) return [];

  const result = [];
  for (const [model, perms] of Object.entries(access)) {
    const { allowed, ownOnly } = canAccess(role, model, 'l');
    if (allowed) result.push({ model, ownOnly });
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
  getOwnershipConfig,
  getAllowedRolesForRoute,
  canAccessDepartment,
  getListableModels,
};
