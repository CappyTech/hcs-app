/**
 * Role-Based Access Control (RBAC) configuration.
 *
 * Single source of truth for what each role can access.
 * Used by authService middleware, route files, controllers, templates.
 *
 * Roles: none | admin | accountant | employee | subcontractor | client | hmrc
 *        | auditor (external, read-only)
 *
 * Job roles (director, contractsManager, ...) are defined as permission-group
 * grants in accessGroupsConfig.js and compiled into the same tables below --
 * see compileJobRoles(). A user holds one primary `role` plus any number of
 * job roles in `roles[]`; every helper here accepts either a single role or
 * an array (use rolesOf(user)), and grants are the union.
 */

import departmentsConfig from './departmentsConfig.js';
import accessGroups from './accessGroupsConfig.js';

// ── Departments each role may access ──────────────────────────────────
// Derived from departmentsConfig roles: ['public'] departments go to every
// role except 'none' (unassigned users keep an empty nav).
// 'auditor' is an external, read-only role: an outside accountant who may look
// at the reconciliation but change nothing. It has no roleModelAccess entry at
// all — that absence is what keeps it off every generic CRUD route — and the
// only routes it can reach are the GET-only ones in accountantRoutes.js.
const ALL_ROLES = ['admin', 'accountant', 'employee', 'subcontractor', 'client', 'hmrc', 'auditor'];
const roleDepartments = { none: [] };
for (const role of ALL_ROLES) roleDepartments[role] = [];
for (const [slug, dept] of Object.entries(departmentsConfig)) {
  const roles = dept.roles.includes('public') ? ALL_ROLES : dept.roles;
  for (const role of roles) {
    if (roleDepartments[role]) roleDepartments[role].push(slug);
  }
}

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
    // Unscoped, not ':own' — running payroll means reading everyone's
    // attendance for the period. The weekly controller already treated
    // accountant as payroll-privileged when deciding whether to strip pay
    // figures; only the route guard had never been updated to let them in.
    attendance:         'r,l',
    invoice:            'r,l',
    purchase:           'r,l',    // listed as "supplier" receipts in KashFlow
    supplier:           'r,l',
    customer:           'r,l',
    project:            'r,l',
    quote:              'r,l',
    nominal:            'r,l',
    note:               'r,l',
    // KashFlow reference collections mirrored by hcs-sync. Read-only
    // everywhere — the write ops are denied in listControllerConfig, so 'r,l'
    // is the whole grant. Without these the finance dashboard filters the
    // tiles out for accountants (getDashboardModels checks canAccess) and the
    // pages exist for admins only.
    journal:               'r,l',
    vatReturn:             'r,l',
    accountingPeriod:      'r,l',
    country:               'r,l',
    currency:              'r,l',
    quoteCategory:         'r,l',
    purchaseOrderCategory: 'r,l',
    vehicleDeployment:  'c,r,u,l',
    assignment:         'c,r,u,l',
    // Bank reconciliation. The KashFlow-synced collections are read-only
    // everywhere; matches and sign-offs are created through /bank, which has
    // its own validation, not through the generic CRUD routes.
    bankAccount:        'r,l',
    bankTransaction:    'r,l',
    bankReconciliation: 'r,l',
    bankMatch:          'r,l',
    bankSignOff:        'r,l',
    bankRule:           'r,l',
    statementImport:    'r,l',
    statementLine:      'r,l',
  },

  employee: {
    attendance:       'r:own,l:own,c:own',
    employee:         'r:own',
    employeeHoliday:  'r:own,l:own',
    holidayRequest:   'c:own,r:own,l:own',
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
    supplier: 'r,l',  // subcontractor verification data
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
      holidayRequest:    'employeeId',
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
  // 'accountant' reads these for payroll: Payroll is a periodic run, and the
  // attendance for the period is its input. Everyone else here is scoped to
  // their own records in the controller; the accountant is not, deliberately.
  '/daily':               ['admin', 'accountant', 'employee', 'subcontractor'],
  '/weekly':              ['admin', 'accountant', 'employee', 'subcontractor'],
  '/weekly-management':   ['admin'],
  '/weekly-flow':         ['admin', 'accountant'],
  '/attendance/submit':   ['employee', 'subcontractor'],
  '/attendance/approve':  ['admin'],
  '/attendance/reject':   ['admin'],
  '/attendance/bulk-approve': ['admin'],

  // CIS
  '/CIS/Dashboard':       ['admin', 'accountant', 'hmrc'],
  '/CIS/returns':         ['admin', 'accountant', 'hmrc', 'subcontractor'],

  // Bank reconciliation.
  //
  // matchRoutePattern does literal longest-prefix matching with no support for
  // :params, so '/bank' alone covers the whole module. Listing something like
  // '/bank/matches/:uuid/unconfirm' here would never match a real request and
  // would read as protection that does not exist.
  //
  // The two admin-only actions — reversing a confirmation, and reopening a
  // signed period, both of which undo something a reviewer put their name to —
  // are enforced by the adminGuard on those routes in bankRoutes.js.
  '/bank':                ['admin', 'accountant'],

  // Bulk supplier payments. Same longest-prefix rule and same finance audience
  // as '/bank': the one '/payments' entry covers the whole module. The confirm
  // step writes real payments to KashFlow — see the strict limiter in
  // paymentRoutes.js.
  '/payments':            ['admin', 'accountant'],

  // Inbound mail filtering log. Same longest-prefix rule as '/bank': the one
  // '/mail' entry covers the whole module.
  //
  // Admin only, and narrower than the finance department on purpose: every
  // record names a sender and a recipient, including people who appear nowhere
  // else in this system and never chose to deal with us. Widening it is a
  // decision about third-party personal data, not a convenience.
  '/mail':                ['admin'],

  // Website content editor. Same longest-prefix rule as '/bank': one entry
  // covers the whole module.
  //
  // The public content API is NOT listed here on purpose. routeAccess is only
  // consulted for a request that already has req.user, and that API is read by
  // hcs-web with a bearer token and no session at all — an entry here would
  // govern nothing. Its guard is the token check in webApiRoutes.js.
  '/website':             ['admin'],

  // Read-only accountant portal. Same longest-prefix rule as '/bank' above, so
  // this one entry covers the whole surface.
  //
  // 'auditor' appears here and nowhere else. Note this does NOT give it '/bank':
  // that pattern is longer and more specific, so a request to /bank matches
  // '/bank' and is refused. The write half of the module stays unreachable by
  // routing, not merely by hidden buttons.
  '/accountant':          ['admin', 'accountant', 'auditor'],

  // Overview (analytics) pages.
  //
  // These were guarded only by ensureRole* in overviewRoutes.js and had no
  // entry here at all, which made routeAccess incomplete as a registry — and
  // dashboard tiles pointing at them could not be role-filtered, because
  // matchRoutePattern returned nothing to filter on.
  //
  // Every line below mirrors the guard already on the route, so nothing gains
  // or loses access; the point is that the fact is now written down where the
  // rest of the app can read it. '/overview' is deliberately NOT a blanket
  // entry: '/overview/finance' and '/overview/payroll' are wider than the
  // rest, and longest-prefix matching would hide that.
  '/overview/admin':          ['admin'],
  '/admin/overviews':         ['admin'],
  '/overview/assignment':     ['admin'],
  '/overview/attendance':     ['admin'],
  '/overview/contract':       ['admin'],
  '/overview/customer':       ['admin', 'accountant'],
  '/overview/documents':      ['admin'],
  '/overview/employee':       ['admin'],
  '/overview/finance':        ['admin', 'accountant'],
  '/overview/fleet':          ['admin'],
  '/overview/holiday':        ['admin'],
  '/overview/human':          ['admin'],
  '/overview/invoice':        ['admin', 'accountant'],
  '/overview/payroll':        ['admin', 'accountant'],
  '/overview/payrollRun':     ['admin', 'accountant'],
  '/overview/payrollSubmission': ['admin', 'accountant'],
  '/overview/policies':       ['admin'],
  '/overview/policyDocument': ['admin'],
  '/overview/project':        ['admin'],
  '/overview/purchase':       ['admin', 'accountant'],
  '/overview/quote':          ['admin', 'accountant'],
  '/overview/projects':       ['admin'],
  '/overview/subcontractors': ['admin', 'accountant', 'hmrc'],
  '/overview/subcontractor':  ['admin', 'accountant', 'hmrc'],
  '/overview/supplier':       ['admin', 'accountant'],
  '/overview/task':           ['admin'],
  '/overview/user':           ['admin'],
  '/overview/vehicle':        ['admin'],
  '/overview/vehicleFuelLog': ['admin'],
  '/overview/vehicleMileageLog': ['admin'],
  '/overview/weekly':         ['admin', 'accountant'], // same as /weekly-flow
  '/overview/vehicleService': ['admin'],

  // Subcontractor administration
  '/subcontractor/assign':['admin'],
  '/supplier/change':     ['admin'],

  // Submission changes
  '/receipts/change-submission': ['admin'],
  '/purchase/change':            ['admin'],

  // Department dashboards — generated from departmentsConfig
  ...Object.fromEntries(
    Object.entries(departmentsConfig)
      .filter(([, dept]) => dept.hasDashboard !== false)
      .map(([slug, dept]) => [
        dept.path || `/${slug}`,
        dept.roles.includes('public') ? '*' : dept.roles,
      ]),
  ),
  '/payroll/dashboard':   ['admin', 'accountant'],
  // Mirror the guards in payrollRoutes.js so the overviews can tell who may see runs and submissions
  '/payroll/runs':        ['admin', 'accountant'],
  '/payroll/submissions': ['admin', 'accountant'],
  // Legacy dashboard URLs that now redirect (kashflow → finance,
  // paperless dashboard → documents; /paperless/* OCR routes listed below)
  '/kashflow':            ['admin', 'accountant'],
  '/paperless':           ['admin'],

  // Settings / profile (all authenticated users)
  '/user/profile':        '*',
  '/user/account':        '*',
  '/user/2fa':            '*',
  '/user/logout':         '*',

  // Holiday dismiss (all authenticated users)
  '/holiday/dismiss':     '*',

  // GDPR requests
  '/gdpr/requests':       '*',
  '/admin/gdpr/requests': ['admin'],

  // Logs
  '/logs':                ['admin'],

  // Background jobs dashboard
  '/admin/jobs':          ['admin'],

  // Maintenance mode controls
  '/admin/maintenance':   ['admin'],

  // Security audit trail
  '/admin/security-events': ['admin'],
  '/audit':                 ['admin'],

  // Files
  '/files':               ['admin'],

  // External connection settings
  '/admin/connections': ['admin'],
  '/admin/config': ['admin'],

  // Email & notifications admin dashboard
  '/admin/emails': ['admin'],

  // Personal notification settings (all authenticated users)
  '/user/account/settings/notifications': '*',

  // Internal API reference
  '/help/api': ['admin'],

  // Paperless OCR
  '/paperless/ocr':                    ['admin'],
  '/paperless/ocr/:paperlessId':       ['admin'],
  '/paperless/ocr/:paperlessId/draft': ['admin'],
  '/paperless/ocr/:paperlessId/send':  ['admin'],
  '/paperless/ocr/:paperlessId/ingest':['admin'],
  '/paperless/ocr/:paperlessId/unlink':['admin'],
  '/paperless/suppliers':              ['admin'],
  '/paperless/ingest':                 ['admin'],
  '/paperless/ingest/trigger':         ['admin'],
  '/paperless/ocr/:paperlessId/entry':       ['admin'],
  '/paperless/ocr/:paperlessId/credit-note': ['admin'],
  '/paperless/ocr/:paperlessId/not-for-kashflow': ['admin'],
  '/paperless/ocr/:paperlessId/reopen':      ['admin'],
  '/paperless/ocr/:paperlessId/resend-invoice': ['admin'],
  '/paperless/ocr/:paperlessId/reviewed':    ['admin'],
  '/paperless/ocr/:paperlessId/type':        ['admin'],
  '/paperless/ocr/:paperlessId/supplier':    ['admin'],
  '/paperless/ocr/:paperlessId/type-confirmed': ['admin'],
  '/paperless/ocr/:paperlessId/file':        ['admin'],
  '/paperless/ocr/:paperlessId/insights':        ['admin'],
  '/paperless/ocr/:paperlessId/read':            ['admin'],
  '/paperless/ocr/:paperlessId/reprocess':       ['admin'],
  '/paperless/ocr/:paperlessId/reading-fixture': ['admin'],
  '/paperless/reading':                          ['admin'],
  '/paperless/reading/supplier/:correspondentId':        ['admin'],
  '/paperless/reading/supplier/:correspondentId/teach':  ['admin'],
  '/paperless/reading/supplier/:correspondentId/forget': ['admin'],
  '/paperless/reading/supplier/:correspondentId/labels': ['admin'],
  '/paperless/shadow-report':          ['admin'],
  '/paperless/mail-rules':             ['admin'],
  '/paperless/queues':                 ['admin'],
  '/paperless/queues/:queue':          ['admin'],

  // Company Documents (letterhead + policies)
  '/company-docs':                                  ['admin'],
  '/company-docs/letterhead':                       ['admin'],
  '/company-docs/policies':                         ['admin'],
  '/company-docs/policies/create':                  ['admin'],
  '/company-docs/policies/:uuid/edit':              ['admin'],
  '/company-docs/policies/:uuid/print':             ['admin'],
};

// ── Job roles: compiled from permission groups ───────────────────────
// Every job role in accessGroupsConfig becomes ordinary entries in
// roleDepartments, roleModelAccess and routeAccess, so nothing downstream
// needs to know groups exist. Route lists are copied before a job role is
// added, so departmentsConfig's own `roles` arrays are never mutated.
function compileJobRoles() {
  const { groups, jobRoles, LEVEL_OPS, READ_ONLY_MODELS, levelsUpTo } = accessGroups;
  const routeKeys = Object.keys(routeAccess);
  const expandRoute = (key) => (key.endsWith('*')
    ? routeKeys.filter((k) => k.startsWith(key.slice(0, -1)))
    : routeKeys.filter((k) => k === key));
  const grantRoute = (key, slug) => {
    const current = routeAccess[key];
    if (current === '*' || !Array.isArray(current)) return;
    if (!current.includes(slug)) routeAccess[key] = [...current, slug];
  };

  // A 'flag' role compiles twice: without its values grants, and as
  // `<slug>+values` with them (see accessGroupsConfig VALUES_SUFFIX).
  const compiled = [];
  for (const [slug, def] of Object.entries(jobRoles)) {
    if (roleModelAccess[slug] || ownershipFields[slug]) {
      throw new Error(`Job role "${slug}" collides with a hand-written role`);
    }
    if (!['always', 'never', 'flag'].includes(def.values)) {
      throw new Error(`Job role "${slug}" needs values: 'always' | 'never' | 'flag'`);
    }
    compiled.push([slug, def.values === 'always' ? def.grants : def.grants.filter((g) => !g.values)]);
    if (def.values === 'flag') compiled.push([slug + accessGroups.VALUES_SUFFIX, def.grants]);
  }

  const { PROJECT_SCOPE_FIELDS, PROJECT_SCOPE_MAX_LEVEL, PROJECT_SCOPE_ROUTES } = accessGroups;
  for (const [slug, grants] of compiled) {
    const departments = new Set();
    const modelOps = {};   // model -> Map(op -> '' (all records) | 'project')

    for (const grant of grants) {
      const scope = grant.scope || 'all';
      const group = groups[grant.group];
      if (!group) throw new Error(`Job role "${slug}" grants unknown group "${grant.group}"`);
      const levels = levelsUpTo(grant.level);
      if (!levels.length) throw new Error(`Job role "${slug}" grants unknown level "${grant.level}"`);

      if (scope === 'project') {
        // Read and list only, on models that can be limited to a site, and
        // only the routes whose data is scoped per record (see
        // accessGroupsConfig PROJECT_SCOPE_*). No department dashboards.
        const viewLevels = levelsUpTo(PROJECT_SCOPE_MAX_LEVEL).filter((l) => levels.includes(l));
        const ops = LEVEL_OPS[viewLevels[viewLevels.length - 1]] || [];
        for (const model of group.models) {
          if (!PROJECT_SCOPE_FIELDS[model]) continue;
          const m = modelOps[model] || (modelOps[model] = new Map());
          for (const op of ops) if (!m.has(op)) m.set(op, 'project');
        }
        for (const level of levels) {
          for (const key of (group.routes && group.routes[level]) || []) {
            for (const matched of expandRoute(key)) {
              if (PROJECT_SCOPE_ROUTES.has(matched)) grantRoute(matched, slug);
            }
          }
        }
        continue;
      }

      for (const d of group.departments) departments.add(d);
      for (const model of group.models) {
        const ops = READ_ONLY_MODELS.has(model) ? LEVEL_OPS.view : LEVEL_OPS[grant.level];
        const m = modelOps[model] || (modelOps[model] = new Map());
        for (const op of ops) m.set(op, ''); // all records beats project
      }
      for (const level of levels) {
        for (const key of (group.routes && group.routes[level]) || []) {
          for (const matched of expandRoute(key)) grantRoute(matched, slug);
        }
      }
    }

    // Department dashboards ('public' ones come with every role).
    for (const [deptSlug, dept] of Object.entries(departmentsConfig)) {
      if (dept.roles.includes('public')) departments.add(deptSlug);
    }
    roleDepartments[slug] = Object.keys(departmentsConfig).filter((d) => departments.has(d));
    for (const d of roleDepartments[slug]) {
      const dept = departmentsConfig[d];
      if (dept.hasDashboard !== false && !dept.roles.includes('public')) grantRoute(dept.path || `/${d}`, slug);
    }

    const order = ['c', 'r', 'u', 'd', 'l'];
    roleModelAccess[slug] = Object.fromEntries(
      Object.entries(modelOps).map(([m, ops]) => [m, order
        .filter((o) => ops.has(o))
        .map((o) => (ops.get(o) ? `${o}:${ops.get(o)}` : o))
        .join(',')]),
    );
  }
}
compileJobRoles();

const JOB_ROLES = new Set(accessGroups.JOB_ROLE_SLUGS.filter(accessGroups.isJobRoleAvailable));

/**
 * Every role a user holds, as compiled role names: the primary `role` plus
 * any available job roles in `roles[]`. Anything in `roles[]` that is not an
 * available job role (including a legacy role such as 'admin') is ignored, so
 * the secondary list can never be used to grant a primary role.
 *
 * A 'flag' job role (Site Manager, Supervisor) resolves to `<slug>+values`
 * when the user's canSeeValues is ticked, so its money-bearing grants apply.
 * @param {Object} user  req.user
 * @returns {string[]}
 */
function rolesOf(user) {
  if (!user) return [];
  const primary = user.role || 'none';
  const extra = (Array.isArray(user.roles) ? user.roles : [])
    .filter((r) => JOB_ROLES.has(r))
    .map((r) => (accessGroups.jobRoles[r].values === 'flag' && user.canSeeValues === true
      ? r + accessGroups.VALUES_SUFFIX
      : r));
  return [...new Set([primary, ...extra])];
}

/** The job roles (not the primary role) a user holds, as compiled names. */
function jobRolesOf(user) {
  return rolesOf(user).filter((r) => JOB_ROLES.has(accessGroups.baseRole(r)));
}

/**
 * May this user see money: pay and day rates, costs, purchase and project
 * values? Admin and accountant always; a job role by its `values` rule; a
 * 'flag' role (Site Manager, Supervisor) only when canSeeValues is ticked.
 *
 * Phase 2 moves the checks that hide pay figures onto this, in place of
 * comparing the role to 'admin' / 'accountant'.
 * @param {Object} user  req.user
 * @returns {boolean}
 */
function canSeeValues(user) {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'accountant') return true;
  return jobRolesOf(user).some((r) => r.endsWith(accessGroups.VALUES_SUFFIX)
    || accessGroups.jobRoles[accessGroups.baseRole(r)]?.values === 'always');
}

/**
 * Does this user hold `group` at `level` or above, through a job role?
 * Admin always does. Legacy roles (accountant, employee, ...) hold no groups:
 * a caller that also wants them names them itself, e.g.
 * ensureGroup('siteOps', 'approve', 'admin').
 *
 * A 'project'-scoped grant counts only with { project: true } (the caller
 * checks each record against the viewer's sites), and a values grant only
 * counts where the role sees values.
 * @param {Object} user   req.user
 * @param {string} group  key in accessGroupsConfig.groups
 * @param {string} level  'view' | 'edit' | 'approve' | 'manage'
 * @returns {boolean}
 */
function hasGroup(user, group, level, { project = false } = {}) {
  if (!accessGroups.groups[group]) throw new Error(`Unknown permission group "${group}"`);
  const need = accessGroups.LEVELS.indexOf(level);
  if (need < 0) throw new Error(`Unknown permission level "${level}"`);
  if (!user) return false;
  if (user.role === 'admin') return true;
  // A project-scoped grant counts only where the caller checks each record
  // against the viewer's sites ({ project: true }); then at its full level.
  return jobRolesOf(user).some((compiled) => {
    const def = accessGroups.jobRoles[accessGroups.baseRole(compiled)];
    if (!def) return false;
    const seesValues = def.values === 'always' || compiled.endsWith(accessGroups.VALUES_SUFFIX);
    return def.grants.some((g) => {
      if (g.group !== group || !(seesValues || !g.values)) return false;
      const scope = g.scope || 'all';
      if (scope === 'project') {
        return project && accessGroups.LEVELS.indexOf(g.level) >= need;
      }
      return accessGroups.LEVELS.indexOf(g.level) >= need;
    });
  });
}

/**
 * Model access across several roles, for display: { model: 'c,r:own,...' }.
 * Where two roles grant the same operation, the unscoped grant wins over
 * ':own'. Admin's '_wildcard' passes through as-is.
 * @param {string|string[]} roleOrRoles
 * @returns {Object<string,string>}
 */
function mergedModelAccess(roleOrRoles) {
  const byModel = {};
  for (const r of toRoles(roleOrRoles)) {
    for (const [model, perms] of Object.entries(roleModelAccess[r] || {})) {
      const ops = byModel[model] || (byModel[model] = new Map());
      for (const { op, scope } of parsePerms(perms)) {
        if (!ops.has(op) || scope !== 'own') ops.set(op, scope);
      }
    }
  }
  return Object.fromEntries(Object.entries(byModel).map(([model, ops]) => [
    model,
    [...ops].map(([op, scope]) => (scope ? `${op}:${scope}` : op)).join(','),
  ]));
}

/** Normalise a role-or-roles argument to an array. */
function toRoles(roleOrRoles) {
  if (Array.isArray(roleOrRoles)) return roleOrRoles.filter(Boolean);
  return roleOrRoles ? [roleOrRoles] : [];
}

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
  const roles = toRoles(role);
  const base = roles.length === 1
    ? (roleDepartments[roles[0]] || [])
    : [...new Set(roles.flatMap((r) => roleDepartments[r] || []))];
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
  const roles = toRoles(role);
  if (roles.includes('admin')) return { allowed: true, ownOnly: false };

  // 1) Role-level access, across every role held. Any unscoped grant wins;
  //    otherwise remember the first role that grants it own-scoped, so the
  //    caller can build that role's ownership filter, and whether any role
  //    grants it project-scoped (the user's sites; dataScopingService).
  let ownRole = null;
  let projectScoped = false;
  for (const r of roles) {
    const perms = roleModelAccess[r] && roleModelAccess[r][model];
    if (!perms) continue;
    for (const { op, scope } of parsePerms(perms)) {
      if (op !== operation) continue;
      if (!scope) return { allowed: true, ownOnly: false };
      if (scope === 'project') projectScoped = true;
      else if (!ownRole) ownRole = r;
    }
  }
  // A scoped role grant is returned before custom grants are looked at, as
  // it always has been. `ownOnly` means "limited", own records and/or sites.
  if (ownRole || projectScoped) {
    const out = { allowed: true, ownOnly: true };
    if (ownRole) out.ownRole = ownRole;
    if (projectScoped) out.projectScoped = true;
    return out;
  }

  // 2) Check user-level custom permissions (always additive)
  if (customPerms?.models) {
    const customModelPerms = customPerms.models instanceof Map
      ? customPerms.models.get(model)
      : customPerms.models[model];
    if (customModelPerms) {
      for (const { op } of parsePerms(customModelPerms)) {
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
  if (Array.isArray(role)) {
    for (const r of role) {
      const found = getOwnershipConfig(r, model);
      if (found) return found;
    }
    return null;
  }
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
  const roles = toRoles(role);
  if (roles.includes('admin')) return true;
  const allowed = routeAccess[routePattern];
  if (allowed === '*') return true;
  if (Array.isArray(allowed) && roles.some((r) => allowed.includes(r))) return true;
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
  const roles = toRoles(role);
  if (roles.includes('admin')) return true;
  if (roles.some((r) => (roleDepartments[r] || []).includes(department))) return true;
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
  const roles = toRoles(role);
  if (roles.includes('admin')) return [{ model: '_wildcard', ownOnly: false }];

  const result = [];
  const seen = new Set();

  // Role-level, across every role held
  for (const r of roles) {
    for (const model of Object.keys(roleModelAccess[r] || {})) {
      if (seen.has(model)) continue;
      const { allowed, ownOnly } = canAccess(roles, model, 'l');
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

export default {
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
  rolesOf,
  jobRolesOf,
  canSeeValues,
  hasGroup,
  mergedModelAccess,
  JOB_ROLES,
};

export { roleDepartments, roleModelAccess, ownershipFields, routeAccess, getDepartmentsForRole, canAccess, canAccessRoute, matchRoutePattern, getOwnershipConfig, getAllowedRolesForRoute, canAccessDepartment, getListableModels, rolesOf, jobRolesOf, canSeeValues, hasGroup, mergedModelAccess, JOB_ROLES };
