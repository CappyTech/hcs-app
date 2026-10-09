/**
 * Overview hierarchy — areas (depth 1).
 *
 * An area groups the nodes (models or model groups) beneath it. Its page is
 * generated from each child's `summary` figures; nothing here is page code.
 * Access to an area is the route rule for its `path` in rolePermissionsConfig.
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
];
