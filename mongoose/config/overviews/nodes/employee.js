// Employees — the most-referenced model in INTERNAL (see docs/OVERVIEW-HIERARCHY.md §5).
export default {
  id: 'employee',
  model: 'employee',
  label: { one: 'Employee', many: 'Employees' },
  icon: 'bi-person-badge',
  description: 'Everyone on the books: contracts, right to work, and where they are.',
  parents: ['human'],
  overviewPath: '/overview/employee',
  listPath: '/employees',
  actions: [{ label: 'Add employee', href: '/employee/create', op: 'c' }],
  // The list page's columns (depth 3), in order. Only these show.
  list: {
    columns: [
      { field: 'name', label: 'Name' },
      { field: 'email', label: 'Email' },
      { field: 'phoneNumber', label: 'Number' },
      { field: 'position', label: 'Position' },
      { field: 'status', label: 'Status' },
      { field: 'type', label: 'Type' },
      { field: 'ir35', label: 'IR35' },
      { field: 'definedRate', label: 'Defined Rate' },
      { field: 'dailyRate', label: 'Daily Rate' },
      { field: 'weeklyRate', label: 'Weekly Rate' },
      { field: 'monthlyRate', label: 'Monthly Rate' },
      { field: 'yearlyRate', label: 'Yearly Rate' },
      { field: 'hourlyRate', label: 'Hourly Rate' },
      { field: 'hireDate', label: 'Hire Date' },
      { field: 'managerId', label: 'Manager' },
      { field: 'subcontractorSupplierId', label: 'Linked Supplier' },
    ],
  },

  figures: {
    active: { label: 'Active employees', where: { status: 'active' } },
    inactive: { label: 'Inactive', where: { status: 'inactive' } },
    ir35: { label: 'Inside IR35', where: { status: 'active', ir35: true } },
    contractsExpired: {
      label: 'Fixed-term contracts ended',
      hint: 'Still active, but the contract end date has passed',
      severity: 'critical',
      where: { status: 'active', 'contract.termsType': 'fixed-term', 'contract.endDate': { $beforeNow: true } },
    },
    contractsEndingSoon: {
      label: 'Contracts ending in 60 days',
      severity: 'warning',
      where: { status: 'active', 'contract.termsType': 'fixed-term', 'contract.endDate': { $withinNextDays: 60 } },
    },
    rightToWorkDue: {
      label: 'Right to work due in 90 days',
      hint: 'Includes checks that have already expired',
      severity: 'warning',
      where: { status: 'active', 'rightToWork.expiryDate': { $notAfterDays: 90 } },
    },
    recentHires: { label: 'Hired in the last 30 days', where: { hireDate: { $withinPastDays: 30 } } },
    pensionEnrolled: { label: 'Active employees in the pension', where: { status: 'active', 'payroll.pensionEnrolled': true } },
    ir35Subcontractor: {
      label: 'IR35 workers paid as subcontractors',
      hint: 'Inside IR35 and linked to a supplier record',
      where: { ir35: true, subcontractorSupplierId: { $set: true } },
    },
  },

  // Depth 1: what the HR area shows for employees
  summary: ['active', 'contractsExpired', 'contractsEndingSoon', 'rightToWorkDue'],

  // Depth 2
  overview: {
    figures: ['active', 'inactive', 'ir35', 'recentHires', 'contractsExpired', 'contractsEndingSoon', 'rightToWorkDue'],
    breakdowns: [
      { label: 'By hours', by: 'type', where: { status: 'active' },
        labels: { 'full-time': 'Full-time', 'part-time': 'Part-time' } },
      { label: 'By contract', by: 'contract.termsType', where: { status: 'active' },
        labels: { permanent: 'Permanent', temporary: 'Temporary', 'zero-hours': 'Zero hours', 'fixed-term': 'Fixed term' } },
      { label: 'By department', by: 'department', where: { status: 'active' } },
    ],
    lists: [
      { figure: 'contractsExpired', sort: { 'contract.endDate': 1 }, limit: 10,
        columns: [{ field: 'name', label: 'Name' }, { field: 'position', label: 'Role' }, { field: 'contract.endDate', label: 'Contract ended', format: 'date' }] },
      { figure: 'contractsEndingSoon', sort: { 'contract.endDate': 1 }, limit: 10,
        columns: [{ field: 'name', label: 'Name' }, { field: 'position', label: 'Role' }, { field: 'contract.endDate', label: 'Contract ends', format: 'date' }] },
      { figure: 'rightToWorkDue', sort: { 'rightToWork.expiryDate': 1 }, limit: 10,
        columns: [{ field: 'name', label: 'Name' }, { field: 'rightToWork.documentType', label: 'Document' }, { field: 'rightToWork.expiryDate', label: 'Expires', format: 'date' }] },
      { figure: 'recentHires', sort: { hireDate: -1 }, limit: 5,
        columns: [{ field: 'name', label: 'Name' }, { field: 'position', label: 'Role' }, { field: 'hireDate', label: 'Hired', format: 'date' }] },
    ],
    panels: ['unassignedEmployees'],
    // Figures owned by other models: shown under "Elsewhere", each linking into that model's list
    related: ['holidayRequest.pending', 'attendance.pending', 'vehicle.withEmployee', 'task.employeeReminders'],
  },
};
