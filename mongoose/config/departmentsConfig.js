/**
 * Canonical department registry.
 *
 * Single source of truth for every department dashboard: slug, titles,
 * nav appearance, dashboard route, and which roles may open it.
 *
 * Consumed by:
 *  - rolePermissionsConfig.js  → derives roleDepartments + dashboard routeAccess
 *  - indexController.js        → generic renderDepartment(slug)
 *  - indexRoutes.js            → generates one GET route per department
 *  - layout.ejs (via app.js res.locals.departmentsConfig) → top nav
 *
 * Fields:
 *  - title       dashboard page heading
 *  - navLabel    short label in the top nav
 *  - icon        Bootstrap Icons class for the nav
 *  - roles       roles that may open the dashboard; ['public'] = any
 *                authenticated user (passthrough guard)
 *  - path        route override (default '/<slug>')
 *  - hasDashboard  false = nav link only, page served elsewhere
 *  - special     'create' = tiles come from getCreateModels, not departments
 *
 * Object order defines nav + route order. Keep this file dependency-free
 * (it is required by rolePermissionsConfig, which everything else imports).
 */
module.exports = {
  admin: {
    title: 'Admin',
    navLabel: 'Admin',
    icon: 'bi-shield-lock',
    roles: ['admin'],
  },
  'construction-industry-scheme': {
    title: 'Construction Industry Scheme',
    navLabel: 'CIS',
    icon: 'bi-building',
    roles: ['admin', 'accountant', 'hmrc', 'subcontractor'],
  },
  management: {
    title: 'Management',
    navLabel: 'Management',
    icon: 'bi-folder2-open',
    roles: ['admin'],
  },
  maintenance: {
    title: 'Maintenance',
    navLabel: 'Maintenance',
    icon: 'bi-tools',
    roles: ['admin'],
  },
  payroll: {
    title: 'Payroll',
    navLabel: 'Payroll',
    icon: 'bi-cash-coin',
    // union of the old roleDepartments (accountant had 'payroll') and the
    // old admin-only route guard — accountant already saw the nav link,
    // and /payroll/dashboard already allowed accountant
    roles: ['admin', 'accountant'],
  },
  'human-resources': {
    title: 'Human Resources',
    navLabel: 'HR',
    icon: 'bi-people',
    roles: ['admin'],
  },
  documents: {
    // merger of the old 'paperless' dashboard and the 'company-docs' nav
    // link — Paperless OCR tiles plus a Letterhead & Policies tile
    title: 'Documents',
    navLabel: 'Documents',
    icon: 'bi-file-earmark-text',
    roles: ['admin'],
  },
  finance: {
    // absorbed the old 'kashflow' department — all KF_* tiles and
    // KashFlow-synced models now live here
    title: 'Finance',
    navLabel: 'Finance',
    icon: 'bi-wallet2',
    roles: ['admin', 'accountant'],
  },
  attendance: {
    title: 'Attendance',
    navLabel: 'Attendance',
    icon: 'bi-calendar-check',
    roles: ['admin', 'employee', 'subcontractor'],
  },
  create: {
    title: 'Create',
    navLabel: 'Create',
    icon: 'bi-plus-circle',
    roles: ['admin'],
    special: 'create',
  },
  user: {
    title: 'User',
    navLabel: 'User',
    icon: 'bi-person-circle',
    roles: ['public'],
  },
};
