/**
 * Overview hierarchy — areas (depth 1).
 *
 * An area groups the nodes (models or model groups) beneath it. Its page is
 * generated from each child's `summary` figures; nothing here is page code.
 * Access to an area is the route rule for its `path` in rolePermissionsConfig.
 *
 * The home page's Overviews grid is this list, in this order, filtered by the
 * same route rule. Holiday isn't here: it's reached through Human Resources.
 * Areas marked `bespoke: true` still have a hand-built page (their own route);
 * they're listed so home has one source while they wait to be converted.
 * An area with `opens: '<nodeId>'` is a home tile for that node's generated
 * overview (its `path` is the node's overviewPath); it has no page of its own.
 *
 * The navigation is this list too (services/navigationService): every area the
 * person can open, clustered by `group` (people | money | work | system; an
 * area without one, e.g. one added from the database, goes under Work). An
 * area with `nav: false` is left out of the navigation and stays on home.
 *
 * See docs/OVERVIEW-HIERARCHY.md for the design.
 */
export default [
  {
    id: 'human', group: 'people', navLabel: 'HR',
    path: '/overview/human',
    label: 'Human Resources',
    icon: 'bi-people',
    description: 'People, holiday, attendance and tasks.',
    children: ['employee', 'leave', 'attendance', 'weekly', 'task'],
  },
  {
    id: 'fleet', group: 'work',
    path: '/overview/fleet',
    label: 'Fleet',
    icon: 'bi-truck',
    description: 'Vehicles, servicing, fuel and mileage.',
    children: ['vehicle', 'vehicleService', 'vehicleFuelLog', 'vehicleMileageLog'],
  },
  {
    id: 'finance', group: 'money',
    path: '/overview/finance',
    label: 'Finance',
    icon: 'bi-wallet2',
    description: 'Invoices, purchases, customers, suppliers and quotes.',
    children: ['invoice', 'purchase', 'customer', 'supplier', 'subcontractor', 'quote'],
  },
  {
    id: 'projects', group: 'work',
    path: '/overview/projects',
    label: 'Projects',
    icon: 'bi-clipboard-check',
    description: 'Contracts, weekly assignments and KashFlow projects.',
    children: ['contract', 'assignment', 'weekly', 'project'],
    // Shown only to those who can open the route (rolePermissionsConfig)
    actions: [
      { label: 'Weekly sheet', href: '/weekly-sheet', route: '/weekly-sheet', icon: 'bi-table' },
      { label: 'Do weekly attendance', href: '/weekly-flow', route: '/weekly-flow', icon: 'bi-calendar-check' },
      { label: 'Job Register', href: '/job-register', route: '/job-register', icon: 'bi-journal-text' },
    ],
  },
  {
    // A home tile only: the nav reaches this week through Projects and HR
    id: 'weeklyAttendance', group: 'people', nav: false, path: '/overview/weekly', bespoke: true, opens: 'weekly',
    label: 'Weekly attendance', icon: 'bi-calendar-check',
    description: 'This payroll week: contracts, assignments, days worked and approval.',
  },
  {
    // The CIS overview. Its id and path are still 'subcontractors' (database
    // changes and links are keyed on them); it stands in for the CIS
    // department in the navigation (departmentsConfig navArea).
    id: 'subcontractors', group: 'money', navLabel: 'CIS',
    path: '/overview/subcontractors',
    label: 'Construction Industry Scheme',
    icon: 'bi-building',
    description: 'Subcontractors, their HMRC verification and deduction rates, and the monthly CIS returns.',
    children: ['subcontractor', 'cisReturn'],
    // Shown only to those who can open the route (rolePermissionsConfig)
    actions: [
      { label: 'CIS dashboard', href: '/CIS/Dashboard/', route: '/CIS/Dashboard', icon: 'bi-speedometer2' },
      { label: 'Returns reports', href: '/CIS/returns/form', route: '/CIS/returns', icon: 'bi-file-earmark-text' },
      { label: 'Edit CIS details', href: '/subcontractor/assign', route: '/subcontractor/assign', icon: 'bi-pencil-square' },
    ],
  },
  {
    id: 'payroll', group: 'money',
    path: '/overview/payroll',
    label: 'Payroll',
    icon: 'bi-cash-coin',
    description: 'Pay runs, year-to-date totals and HMRC submissions.',
    children: ['payrollRun', 'payrollSubmission'],
    // Shown only to those who can open the route (rolePermissionsConfig)
    actions: [
      { label: 'Staffology pay vs attendance', href: '/payroll/staffology', route: '/payroll/staffology', icon: 'bi-clipboard-check' },
      { label: 'Staffology employees', href: '/payroll/staffology/employees', route: '/payroll/staffology/employees', icon: 'bi-people' },
    ],
  },
  {
    id: 'documents', group: 'work', path: '/overview/documents', bespoke: true,
    label: 'Documents', icon: 'bi-file-earmark-text', description: 'Paperless documents, queues and data entry.',
  },
  {
    id: 'policies', group: 'work',
    path: '/overview/policies',
    label: 'Policies',
    icon: 'bi-journal-text',
    description: 'Company policies and their review dates.',
    children: ['policyDocument'],
  },
  {
    id: 'healthSafety', group: 'work',
    path: '/overview/healthSafety',
    label: 'Health & Safety',
    icon: 'bi-cone-striped',
    description: 'Training and cards, site inductions, RAMS and their briefings, and the accident book.',
    children: ['trainingRecord', 'induction', 'rams', 'ramsBriefing', 'accidentReport'],
    // Shown only to those who can open the route (rolePermissionsConfig)
    actions: [
      { label: 'Record an induction', href: '/inductions/record', route: '/inductions/record', icon: 'bi-person-check' },
      { label: 'Record a RAMS briefing', href: '/rams/brief', route: '/rams/brief', icon: 'bi-clipboard2-check' },
      { label: 'Report an accident', href: '/accident-report', icon: 'bi-bandaid' },
    ],
  },
  {
    id: 'admin', group: 'system',
    path: '/overview/admin',
    label: 'Admin',
    icon: 'bi-shield-check',
    description: 'Users, security, background jobs, the outbox, the audit log and GDPR requests.',
    children: ['user', 'securityEvent', 'jobState', 'notification', 'auditLog', 'gdprRequest'],
    // The cards carry the tools; the header keeps the dashboard and settings. Shown only to those who can open the route (rolePermissionsConfig)
    actions: [
      { label: 'Admin dashboard', href: '/admin', route: '/admin', icon: 'bi-shield-lock' },
      { label: 'Configuration', href: '/admin/config', route: '/admin/config', icon: 'bi-sliders' },
    ],
  },
];
