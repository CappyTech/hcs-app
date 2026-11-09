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
//   project — only records on the user's sites: contracts that name them in
//             `siteManagers` and aren't Completed (projectScopeService).
export const SCOPES = ['all', 'project'];

// How each model is limited to a user's sites. `set` names a list that
// projectScopeService.resolve() builds. A model not listed here can't be
// granted at project scope: the grant gives nothing for it.
export const PROJECT_SCOPE_FIELDS = {
  contract:          { field: '_id', set: 'contractIds' },
  project:           { field: '_id', set: 'projectIds' },
  assignment:        { field: 'contractId', set: 'contractIds' },
  attendance:        [{ field: 'contractId', set: 'contractIds' }, { field: 'projectId', set: 'projectIds' }],
  vehicleDeployment: { field: 'contractId', set: 'contractIds' },
  location:          { field: '_id', set: 'locationIds' },
  quote:             { field: '_id', set: 'quoteIds' },
  purchase:          { field: 'ProjectNumber', set: 'projectNumbers' },
  // Training is about a person, not a site: a site role sees the records
  // of whoever is assigned to their sites (projectScopeService.sitePeople).
  trainingRecord:    [{ field: 'employeeId', set: 'employeeIds' }, { field: 'subcontractorId', set: 'subcontractorIds' }],
  induction:         { field: 'contractId', set: 'contractIds' },
  rams:              { field: 'contractId', set: 'contractIds' },
  ramsBriefing:      { field: 'contractId', set: 'contractIds' },
};

// Model operations a project-scoped grant gives through the generic CRUD
// routes: read and list only, whatever its level, because the generic
// update/delete routes don't check a record's scope. Writes on site go
// through routes that check each record themselves (phase 3b: recording on
// /daily, inline attendance, and the approval routes), which ask
// hasGroup(..., { project: true }) at the grant's full level.
export const PROJECT_SCOPE_MAX_LEVEL = 'view';

// Routes a project-scoped grant reaches, at whatever level it holds. Only
// routes that check scope per record: /daily filters its records and its
// record form takes only the viewer's contracts; bulk approve moves only
// what attendanceApprovalService lets the viewer move. The weekly views,
// overviews and department dashboards show whole-set figures, so they're
// left out. (/attendance/:uuid/approve, /reject, /inline and PATCH match no
// routeAccess key, so their ensureGroup guard decides alone.)
// /inductions/record and /rams/brief offer and accept only the viewer's
// contracts.
export const PROJECT_SCOPE_ROUTES = new Set(['/daily', '/attendance/bulk-approve', '/inductions/record', '/rams/brief']);

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
      edit:    ['/weekly-flow'],
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
      // Bank reconciliation and bulk payments write real payments to
      // KashFlow. Director holds manage, under separation of duties
      // (separationOfDutiesService; docs/PERMISSION-GROUPS.md, decision 3).
      manage: ['/bank', '/payments', '/receipts/change-submission', '/purchase/change'],
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
    // Phase 5 adds the records one at a time: training & cards (5a), then
    // inductions, RAMS and the accident book.
    description: 'Training & cards, site inductions, RAMS with their briefings, and the accident book.',
    departments: [],
    // No accidentReport: injury details are health data, so the accident
    // book isn't readable at view. It is reached only through its own routes,
    // at approve (/accidents); reporting (/accident-report) is open to anyone
    // on site.
    models: ['trainingRecord', 'induction', 'rams', 'ramsBriefing'],
    routes: {
      view: ['/overview/healthSafety', '/overview/trainingRecord', '/overview/induction', '/overview/rams', '/overview/ramsBriefing'],
      edit: ['/inductions/record', '/rams/brief'],
      approve: ['/accidents', '/overview/accidentReport'],
    },
  },
  documents: {
    label: 'Documents',
    description: 'Document queues and data entry, letterhead and policies.',
    departments: ['documents'],
    models: ['OcrDocumentIngest'],
    // routeAccess is the coarse layer: every /paperless and /company-docs
    // page at view. Each route's ensureGroup guard then asks for the level
    // that action needs (paperlessRoutes, companyDocsRoutes).
    routes: {
      view: ['/overview/policies', '/overview/policyDocument', '/overview/documents', '/paperless*', '/company-docs*'],
    },
  },
  website: {
    label: 'Website',
    description: 'Content for the public website.',
    departments: ['website'],
    models: [],
    // Each /website route's ensureGroup guard asks for edit, approve or manage.
    routes: { view: ['/website'] },
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
//
// These are the shipped DEFAULTS. A company changes them, adds its own job
// roles or turns one off on /admin/job-roles (phase 4); jobRoleConfigService
// stores those changes and applyJobRoleOverrides() rebuilds `jobRoles` in
// place, then rolePermissionsConfig.recompileJobRoles() rebuilds the tables.
// disabled: true — the role stays defined (users keep it in roles[]) but
// grants nothing and can't be assigned.
const DEFAULT_JOB_ROLES = {
  director: {
    label: 'Director',
    description: 'Runs the business. Approves across every business area, and can send money and submissions out of the app (always with a second person); sees but does not administer the system.',
    values: 'always',
    // Manage on the money groups (decision 3): bank, payments, HMRC and
    // pension submissions, sending to KashFlow. separationOfDutiesService
    // stops a Director sending out what they entered, locked or confirmed.
    grants: [
      { group: 'siteOps', level: 'approve' },
      { group: 'commercial', level: 'approve' },
      { group: 'finance', level: 'manage' },
      { group: 'cis', level: 'manage' },
      { group: 'payroll', level: 'manage' },
      { group: 'hr', level: 'approve' },
      { group: 'fleet', level: 'approve' },
      { group: 'healthSafety', level: 'approve' },
      { group: 'documents', level: 'manage' },
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
    description: 'Runs the sites they are assigned to day to day: the contracts that name them as a site manager.',
    values: 'flag',
    grants: [
      { group: 'siteOps', level: 'approve', scope: 'project' },
      // Projects, quotes and purchases carry the job's money.
      { group: 'commercial', level: 'view', scope: 'project', values: true },
      { group: 'fleet', level: 'view', scope: 'project' },
      // Records inductions on their sites (/inductions/record).
      { group: 'healthSafety', level: 'edit', scope: 'project' },
    ],
  },
  supervisor: {
    label: 'Supervisor / Foreman',
    description: 'Runs a gang on site: the contracts that name them as a site manager or supervisor.',
    values: 'flag',
    grants: [
      { group: 'siteOps', level: 'edit', scope: 'project' },
      { group: 'commercial', level: 'view', scope: 'project', values: true },
      { group: 'healthSafety', level: 'edit', scope: 'project' },
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
      // approve: reads and investigates the accident book.
      { group: 'healthSafety', level: 'approve' },
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

const clone = (v) => JSON.parse(JSON.stringify(v));
const deepFreeze = (o) => { Object.values(o).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); };

/** The shipped definitions, read-only. */
export const defaultJobRoles = deepFreeze(clone(DEFAULT_JOB_ROLES));

// The live definitions. Mutated in place (never reassigned), so every module
// that imported them sees a company's changes.
export const jobRoles = clone(DEFAULT_JOB_ROLES);
export const JOB_ROLE_SLUGS = Object.keys(jobRoles);

// Names a job role can never take: the legacy primary roles and the
// pseudo-roles routeAccess and departmentsConfig use.
export const RESERVED_ROLE_SLUGS = ['admin', 'accountant', 'employee', 'subcontractor', 'client', 'hmrc', 'auditor', 'none', 'public'];

/**
 * Rebuild `jobRoles` and `JOB_ROLE_SLUGS` from the defaults plus a company's
 * stored changes. Each override is a complete definition
 * ({ slug, custom, label, description, values, grants, disabled }), already
 * validated by jobRoleConfigService. Built-in roles keep their code order;
 * added ones follow in the order given.
 * @param {Object[]} overrides
 */
export function applyJobRoleOverrides(overrides = []) {
  const bySlug = new Map(overrides.map((o) => [o.slug, o]));
  const next = {};
  for (const [slug, def] of Object.entries(DEFAULT_JOB_ROLES)) {
    const o = bySlug.get(slug);
    next[slug] = o && !o.custom ? pick(o) : clone(def);
  }
  for (const o of overrides) {
    if (o.custom && !DEFAULT_JOB_ROLES[o.slug]) next[o.slug] = { ...pick(o), custom: true };
  }
  for (const k of Object.keys(jobRoles)) delete jobRoles[k];
  Object.assign(jobRoles, next);
  JOB_ROLE_SLUGS.splice(0, JOB_ROLE_SLUGS.length, ...Object.keys(jobRoles));
}

function pick(o) {
  const def = {
    label: o.label,
    description: o.description || '',
    values: o.values,
    grants: clone(o.grants || []),
  };
  if (o.disabled) def.disabled = true;
  return def;
}

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
 * uses a scope that is enforced. Both are, since phase 3a.
 */
export function isJobRoleAvailable(slug) {
  const def = jobRoles[slug];
  if (!def || def.disabled) return false;
  return def.grants.every((g) => SCOPES.includes(g.scope || 'all'));
}

export default {
  LEVELS, LEVEL_OPS, SCOPES, PROJECT_SCOPE_FIELDS, PROJECT_SCOPE_MAX_LEVEL, PROJECT_SCOPE_ROUTES,
  READ_ONLY_MODELS, groups, jobRoles, defaultJobRoles, JOB_ROLE_SLUGS, RESERVED_ROLE_SLUGS, VALUES_SUFFIX,
  baseRole, levelsUpTo, isJobRoleAvailable, applyJobRoleOverrides,
};
