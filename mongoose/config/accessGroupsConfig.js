/**
 * Permission groups and job roles.
 *
 * See docs/PERMISSION-GROUPS.md for the design. In short:
 *
 *  - A GROUP is a bundle of access to one area of the business: the
 *    department dashboards it opens, the models it touches and the controlled
 *    routes (rolePermissionsConfig.routeAccess) it reaches.
 *  - A group is granted at a LEVEL — view < edit < approve < manage — and
 *    each level includes everything below it.
 *  - A JOB ROLE is a named set of group grants. A user holds one primary
 *    `role` (the legacy single value) plus any number of job roles in
 *    `roles[]`; their access is the union of all of them.
 *
 * rolePermissionsConfig.js compiles every job role here into the same
 * roleDepartments / roleModelAccess / routeAccess tables the hand-written
 * roles use, so every existing check reads them without knowing groups exist.
 *
 * Keep this file dependency-free: rolePermissionsConfig imports it, and
 * everything else imports rolePermissionsConfig.
 */

// ── Levels ───────────────────────────────────────────────────────────
// Order matters: a grant at one level includes every level before it.
export const LEVELS = ['view', 'edit', 'approve', 'manage'];

// CRUD operations each level allows on a group's models. 'approve' adds no
// model operations over 'edit' — approval is a workflow action, reached
// through the group's `routes.approve` list.
export const LEVEL_OPS = {
  view:    ['r', 'l'],
  edit:    ['c', 'r', 'u', 'l'],
  approve: ['c', 'r', 'u', 'l'],
  manage:  ['c', 'r', 'u', 'd', 'l'],
};

// Scopes a grant can carry.
//   all     — every record
//   project — only records on projects the user is assigned to. NOT YET
//             ENFORCED (phase 3): a grant with this scope compiles to nothing,
//             and a job role that relies on one is marked unavailable.
export const SCOPES = ['all', 'project'];

// Models no group may write through the generic CRUD routes, whatever the
// level: the REST namespace is written by the sync adapter alone, and the
// bank records are created through /bank's own validated flow.
export const READ_ONLY_MODELS = new Set([
  'invoice', 'purchase', 'supplier', 'customer', 'project', 'quote', 'nominal',
  'note', 'vatrate', 'journal', 'vatReturn', 'accountingPeriod', 'country',
  'currency', 'quoteCategory', 'purchaseOrderCategory',
  'bankAccount', 'bankTransaction', 'bankReconciliation', 'bankMatch',
  'bankSignOff', 'bankRule', 'statementImport', 'statementLine',
]);

// ── Groups ───────────────────────────────────────────────────────────
// routes: per level, a list of routeAccess keys. A key ending in '*' is a
// prefix and grants every routeAccess key that starts with it, so a group
// keeps up with new '/paperless/…' entries without being edited.
export const groups = {
  siteOps: {
    label: 'Site Ops',
    description: 'Attendance, assignments, locations and vehicle deployment on site.',
    departments: ['attendance', 'management'],
    models: ['attendance', 'assignment', 'location', 'vehicleDeployment'],
    routes: {
      view:    ['/daily', '/weekly', '/overview/attendance', '/overview/assignment'],
      approve: ['/attendance/approve', '/attendance/reject', '/attendance/bulk-approve', '/weekly-management'],
    },
  },
  commercial: {
    label: 'Commercial',
    description: 'Projects, quotes, contracts and the purchases booked against them.',
    departments: ['management'],
    models: ['project', 'quote', 'contract', 'customer', 'supplier', 'purchase'],
    routes: {
      view: [
        '/overview/project', '/overview/projects', '/overview/quote', '/overview/contract',
        '/overview/customer', '/overview/supplier', '/overview/purchase',
      ],
    },
  },
  finance: {
    label: 'Finance',
    description: 'Sales and purchase ledgers, bank reconciliation, payments and KashFlow reference data.',
    departments: ['finance', 'accountant-portal'],
    models: [
      'invoice', 'purchase', 'supplier', 'customer', 'project', 'quote', 'nominal', 'note',
      'journal', 'vatReturn', 'accountingPeriod', 'country', 'currency', 'quoteCategory',
      'purchaseOrderCategory', 'bankAccount', 'bankTransaction', 'bankReconciliation',
      'bankMatch', 'bankSignOff', 'bankRule', 'statementImport', 'statementLine',
    ],
    routes: {
      view: [
        '/accountant', '/kashflow', '/overview/finance', '/overview/invoice',
        '/overview/purchase', '/overview/supplier', '/overview/customer',
      ],
      // Bank reconciliation and bulk payments (which write real payments to
      // KashFlow) stay with admin + accountant: 'manage' is held by no job
      // role. Opening them to a job role waits on the separation-of-duties
      // decision (docs/PERMISSION-GROUPS.md, open decision 3).
      manage: ['/bank', '/payments'],
    },
  },
  cis: {
    label: 'CIS',
    description: 'Subcontractor verification, deduction rates and CIS returns.',
    departments: ['construction-industry-scheme'],
    models: ['subcontractor', 'supplier'],
    // view = is this sub verified, at what rate. The dashboard and returns
    // carry the deductions themselves, so they start at approve.
    routes: {
      view:    ['/overview/subcontractors', '/overview/subcontractor'],
      approve: ['/CIS/Dashboard', '/CIS/returns'],
      manage:  ['/subcontractor/assign', '/supplier/change'],
    },
  },
  payroll: {
    label: 'Payroll',
    description: 'Employee records (pay rates, NI number), pay runs, RTI submissions and the weekly flow that feeds them.',
    departments: ['payroll'],
    models: ['employee', 'employeeHoliday'],
    routes: {
      view: [
        '/payroll/dashboard', '/payroll/runs', '/payroll/submissions', '/overview/payroll',
        '/overview/payrollRun', '/overview/payrollSubmission', '/weekly-flow', '/overview/weekly',
      ],
    },
  },
  hr: {
    label: 'HR',
    // No 'employee' here on purpose: the employee record carries pay rates and
    // the NI number, and there is no field-level split yet, so the whole
    // record sits in Payroll. HR without Payroll manages holidays and tasks.
    description: 'Holidays and their approval, and tasks.',
    departments: ['human-resources'],
    models: ['holiday', 'employeeHoliday', 'holidayRequest', 'holidayDismissal', 'holidayCustom', 'task'],
    routes: {
      view: ['/overview/employee', '/overview/holiday', '/overview/human', '/overview/task'],
    },
  },
  fleet: {
    label: 'Fleet',
    description: 'Vehicles, MOT, insurance and tax dates, servicing, fuel and mileage.',
    departments: ['maintenance'],
    models: ['vehicle', 'vehicleFuelLog', 'vehicleMileageLog', 'vehicleService', 'vehicleDeployment'],
    routes: {
      view: [
        '/overview/fleet', '/overview/vehicle', '/overview/vehicleFuelLog',
        '/overview/vehicleMileageLog', '/overview/vehicleService',
      ],
    },
  },
  healthSafety: {
    label: 'Health & Safety',
    description: 'RAMS, inductions, training records and the accident book. No models yet — a later phase adds them.',
    departments: [],
    models: [],
    routes: {},
  },
  documents: {
    label: 'Documents',
    description: 'Document queues and data entry, letterhead and policies.',
    departments: ['documents'],
    models: ['OcrDocumentIngest'],
    routes: {
      // '/overview/documents' is left out: its route is hand-guarded admin-only.
      view: ['/overview/policies', '/overview/policyDocument'],
      edit: ['/paperless*', '/company-docs*'],
    },
  },
  website: {
    label: 'Website',
    description: 'Content for the public website.',
    departments: ['website'],
    models: [],
    routes: { edit: ['/website'] },
  },
  system: {
    label: 'System',
    description: 'Users, settings, integrations, logs and security. Held in full only by the System Administrator (the admin role).',
    departments: [],
    models: [],
    routes: { view: ['/audit', '/admin/security-events'] },
  },
};

// ── Job roles ────────────────────────────────────────────────────────
// Slugs are camelCase and must not collide with a legacy role.
//
// Two job titles from the design are the legacy roles under a new label and
// are NOT listed here: System Administrator = 'admin', Bookkeeper / Accounts
// = 'accountant'. Employee and Subcontractor stay the legacy roles too.
//
// grants: [{ group, level, scope?, values? }] — scope defaults to 'all'.
//   values: true marks a grant that exposes money (rates, costs, purchase and
//   project values). Whether it applies depends on the role's `values` rule.
// values — may this role see money?
//   'always' — yes; values grants apply.
//   'never'  — no; values grants are dropped.
//   'flag'   — per user: only when that user's `canSeeValues` is ticked
//              (Site Manager, Supervisor).
// Every job role needs 2FA (authService.rolesRequiring2FA).
export const jobRoles = {
  director: {
    label: 'Director',
    description: 'Runs the business. Approves across every business area; sees but does not administer the system.',
    values: 'always',
    grants: [
      { group: 'siteOps', level: 'approve' },
      { group: 'commercial', level: 'approve' },
      { group: 'finance', level: 'approve' },
      { group: 'cis', level: 'approve' },
      { group: 'payroll', level: 'approve' },
      { group: 'hr', level: 'approve' },
      { group: 'fleet', level: 'approve' },
      { group: 'healthSafety', level: 'approve' },
      { group: 'documents', level: 'approve' },
      { group: 'website', level: 'approve' },
      { group: 'system', level: 'view' },
    ],
  },
  contractsManager: {
    label: 'Contracts Manager',
    description: 'Runs several jobs from award to final account: programme, labour, subcontractors, cost.',
    values: 'always',
    grants: [
      { group: 'siteOps', level: 'approve' },
      { group: 'commercial', level: 'approve' },
      { group: 'cis', level: 'view' },
      { group: 'fleet', level: 'view' },
      { group: 'healthSafety', level: 'view' },
    ],
  },
  quantitySurveyor: {
    label: 'Quantity Surveyor / Estimator',
    description: 'Prices tenders and quotes; valuations, variations and final accounts.',
    values: 'always',
    grants: [
      { group: 'commercial', level: 'edit' },
      { group: 'cis', level: 'view' },
    ],
  },
  siteManager: {
    label: 'Site Manager',
    description: 'Runs the sites they are assigned to day to day.',
    values: 'flag',
    grants: [
      { group: 'siteOps', level: 'approve', scope: 'project' },
      // Projects, quotes and purchases carry the job's money.
      { group: 'commercial', level: 'view', scope: 'project', values: true },
      { group: 'fleet', level: 'view', scope: 'project' },
      { group: 'healthSafety', level: 'view', scope: 'project' },
    ],
  },
  supervisor: {
    label: 'Supervisor / Foreman',
    description: 'Runs a gang on site; records and signs off the day.',
    values: 'flag',
    grants: [
      { group: 'siteOps', level: 'edit', scope: 'project' },
      { group: 'commercial', level: 'view', scope: 'project', values: true },
    ],
  },
  officeManager: {
    label: 'Office Manager',
    description: 'Runs the office: documents, HR admin (not pay), fleet paperwork.',
    values: 'never',
    grants: [
      { group: 'documents', level: 'edit' },
      { group: 'hr', level: 'edit' },
      { group: 'fleet', level: 'edit' },
      { group: 'siteOps', level: 'view' },
    ],
  },
  payrollHr: {
    label: 'Payroll / HR Officer',
    description: 'Pay runs, starters and leavers, right-to-work, absence.',
    values: 'always',
    grants: [
      { group: 'payroll', level: 'approve' },
      { group: 'hr', level: 'approve' },
      { group: 'siteOps', level: 'view' },
    ],
  },
  healthSafetyAdvisor: {
    label: 'Health & Safety Advisor',
    description: 'RAMS, inductions, training and audits across every site.',
    values: 'never',
    grants: [
      { group: 'healthSafety', level: 'edit' },
      { group: 'siteOps', level: 'view' },
    ],
  },
  fleetManager: {
    label: 'Fleet / Plant Manager',
    description: 'Vans, plant and tools: MOT, insurance, servicing, fuel.',
    values: 'never',
    grants: [
      { group: 'fleet', level: 'manage' },
    ],
  },
};

export const JOB_ROLE_SLUGS = Object.keys(jobRoles);

// A 'flag' role is compiled twice: `<slug>` without its values grants, and
// `<slug>+values` with them. rolesOf() picks one per user from canSeeValues.
export const VALUES_SUFFIX = '+values';

/** 'siteManager+values' -> 'siteManager'. */
export function baseRole(slug) {
  return typeof slug === 'string' && slug.endsWith(VALUES_SUFFIX)
    ? slug.slice(0, -VALUES_SUFFIX.length)
    : slug;
}

/** Levels at or below `level`, e.g. 'approve' → ['view','edit','approve']. */
export function levelsUpTo(level) {
  const i = LEVELS.indexOf(level);
  return i < 0 ? [] : LEVELS.slice(0, i + 1);
}

/**
 * A job role is available (assignable) only when every grant it relies on
 * can be enforced today. Roles with a 'project'-scoped grant wait for phase 3.
 */
export function isJobRoleAvailable(slug) {
  const def = jobRoles[slug];
  if (!def) return false;
  return def.grants.every((g) => (g.scope || 'all') === 'all');
}

export default { LEVELS, LEVEL_OPS, SCOPES, READ_ONLY_MODELS, groups, jobRoles, JOB_ROLE_SLUGS, VALUES_SUFFIX, baseRole, levelsUpTo, isJobRoleAvailable };
