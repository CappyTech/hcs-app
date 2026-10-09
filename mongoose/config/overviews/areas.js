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
 *
 * See docs/OVERVIEW-HIERARCHY.md for the design.
 */
export default [
  {
    id: 'human',
    path: '/overview/human',
    label: 'Human Resources',
    icon: 'bi-people',
    description: 'People, holiday, attendance and tasks.',
    children: ['employee', 'leave', 'attendance', 'task'],
  },
  {
    id: 'fleet',
    path: '/overview/fleet',
    label: 'Fleet',
    icon: 'bi-truck',
    description: 'Vehicles, servicing, fuel and mileage.',
    children: ['vehicle', 'vehicleService', 'vehicleFuelLog', 'vehicleMileageLog'],
  },
  {
    id: 'finance',
    path: '/overview/finance',
    label: 'Finance',
    icon: 'bi-wallet2',
    description: 'Invoices, purchases, customers, suppliers and quotes.',
    children: ['invoice', 'purchase', 'customer', 'supplier', 'subcontractor', 'quote'],
  },
  {
    id: 'projects',
    path: '/overview/projects',
    label: 'Projects',
    icon: 'bi-clipboard-check',
    description: 'Contracts, weekly assignments and KashFlow projects.',
    children: ['contract', 'assignment', 'project'],
  },
  {
    id: 'subcontractors',
    path: '/overview/subcontractors',
    label: 'Subcontractors',
    icon: 'bi-person-gear',
    description: 'Construction Industry Scheme subcontractors and their verification.',
    children: ['subcontractor'],
  },
  {
    id: 'payroll',
    path: '/overview/payroll',
    label: 'Payroll',
    icon: 'bi-cash-coin',
    description: 'Pay runs, year-to-date totals and HMRC submissions.',
    children: ['payrollRun', 'payrollSubmission'],
  },
  {
    id: 'documents', path: '/overview/documents', bespoke: true,
    label: 'Documents', icon: 'bi-file-earmark-text', description: 'Paperless documents, queues and data entry.',
  },
  {
    id: 'policies',
    path: '/overview/policies',
    label: 'Policies',
    icon: 'bi-journal-text',
    description: 'Company policies and their review dates.',
    children: ['policyDocument'],
  },
  {
    id: 'admin',
    path: '/overview/admin',
    label: 'Admin',
    icon: 'bi-shield-check',
    description: 'Users, roles and two-factor sign-in.',
    children: ['user'],
  },
];
