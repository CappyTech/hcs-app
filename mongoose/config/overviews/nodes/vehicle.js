// Vehicles: the fleet itself. Compliance dates match vehicleComplianceService
// (MOT, insurance, road tax); disposed vehicles are left out everywhere.
const IN_FLEET = { availabilityStatus: { $ne: 'Disposed' } };

export default {
  id: 'vehicle',
  model: 'vehicle',
  label: { one: 'Vehicle', many: 'Vehicles' },
  icon: 'bi-truck',
  description: 'The fleet: MOT, insurance and road tax, who has each vehicle, and what is off the road.',
  parents: ['fleet'],
  overviewPath: '/overview/vehicle',
  listPath: '/vehicles',
  list: {
    columns: [
      { field: 'registrationNumber', label: 'Reg' },
      { field: 'make', label: 'Make' },
      { field: 'model', label: 'Model' },
      { field: 'year', label: 'Year' },
      { field: 'color', label: 'Color' },
      { field: 'fuelType', label: 'Fuel Type' },
      { field: 'bodyType', label: 'Body Type' },
      { field: 'transmission', label: 'Transmission' },
      { field: 'engineSize', label: 'Engine Size' },
      { field: 'currentMileage', label: 'Mileage' },
      { field: 'availabilityStatus', label: 'Status' },
      { field: 'vehicleUsage', label: 'Usage' },
      { field: 'employeeId', label: 'Assigned Employee' },
      { field: 'subcontractorId', label: 'Assigned Subcontractor' },
      { field: 'projectId', label: 'Project' },
      { field: 'assignedDepartment', label: 'Department' },
      { field: 'ownershipStatus', label: 'Ownership' },
      { field: 'purchaseDate', label: 'Purchase Date' },
      { field: 'leaseExpiryDate', label: 'Lease Expiry Date' },
      { field: 'insuranceProvider', label: 'Insurance Provider' },
      { field: 'insuranceExpiryDate', label: 'Insurance Expiry' },
      { field: 'motExpiryDate', label: 'MOT Expiry' },
      { field: 'roadTaxExpiryDate', label: 'Tax Expiry' },
      { field: 'roadTaxAmount', label: 'Tax Cost' },
      { field: 'lastServiceDate', label: 'Last Service' },
      { field: 'nextServiceDueDate', label: 'Next Service Due' },
    ],
  },
  actions: [{ label: 'Add vehicle', href: '/vehicle/create', op: 'c' }],

  figures: {
    inFleet: { label: 'Vehicles in the fleet', where: IN_FLEET },
    available: { label: 'Available', where: { availabilityStatus: 'Available' } },
    offRoad: {
      label: 'Off the road',
      hint: 'Under maintenance or out of service',
      severity: 'warning',
      where: { availabilityStatus: { $in: ['Under Maintenance', 'Out of Service'] } },
    },
    complianceExpired: {
      label: 'MOT, insurance or tax expired',
      severity: 'critical',
      where: {
        ...IN_FLEET,
        $or: [
          { motExpiryDate: { $beforeNow: true } },
          { insuranceExpiryDate: { $beforeNow: true } },
          { roadTaxExpiryDate: { $beforeNow: true } },
        ],
      },
    },
    complianceDue: {
      label: 'MOT, insurance or tax due in 30 days',
      severity: 'warning',
      where: {
        ...IN_FLEET,
        $or: [
          { motExpiryDate: { $withinNextDays: 30 } },
          { insuranceExpiryDate: { $withinNextDays: 30 } },
          { roadTaxExpiryDate: { $withinNextDays: 30 } },
        ],
      },
    },
    withEmployee: { label: 'Vehicles with an employee', where: { ...IN_FLEET, employeeId: { $set: true } } },
    withSubcontractor: { label: 'Vehicles with a subcontractor', where: { ...IN_FLEET, subcontractorId: { $set: true } } },
    leaseEnding: { label: 'Leases ending in 60 days', severity: 'warning', where: { ...IN_FLEET, leaseExpiryDate: { $withinNextDays: 60 } } },
  },

  summary: ['inFleet', 'complianceExpired', 'complianceDue', 'offRoad'],

  overview: {
    figures: ['inFleet', 'available', 'offRoad', 'complianceExpired', 'complianceDue', 'withEmployee', 'withSubcontractor', 'leaseEnding'],
    breakdowns: [
      { label: 'By status', by: 'availabilityStatus', where: IN_FLEET },
      { label: 'By type', by: 'bodyType', where: IN_FLEET },
      { label: 'By fuel', by: 'fuelType', where: IN_FLEET },
      { label: 'By ownership', by: 'ownershipStatus', where: IN_FLEET },
    ],
    lists: [
      { figure: 'complianceExpired', sort: { motExpiryDate: 1 }, limit: 10,
        columns: [
          { field: 'registrationNumber', label: 'Registration' },
          { field: 'motExpiryDate', label: 'MOT', format: 'date' },
          { field: 'insuranceExpiryDate', label: 'Insurance', format: 'date' },
          { field: 'roadTaxExpiryDate', label: 'Road tax', format: 'date' },
        ] },
      { figure: 'complianceDue', sort: { motExpiryDate: 1 }, limit: 10,
        columns: [
          { field: 'registrationNumber', label: 'Registration' },
          { field: 'motExpiryDate', label: 'MOT', format: 'date' },
          { field: 'insuranceExpiryDate', label: 'Insurance', format: 'date' },
          { field: 'roadTaxExpiryDate', label: 'Road tax', format: 'date' },
        ] },
      { figure: 'offRoad', sort: { registrationNumber: 1 }, limit: 10,
        columns: [
          { field: 'registrationNumber', label: 'Registration' },
          { field: 'make', label: 'Make' },
          { field: 'availabilityStatus', label: 'Status' },
        ] },
      { figure: 'withEmployee', sort: { registrationNumber: 1 }, limit: 10,
        columns: [
          { field: 'registrationNumber', label: 'Registration' },
          { field: 'employeeId', label: 'Employee', ref: { model: 'employee', field: 'name' } },
        ] },
      { figure: 'withSubcontractor', sort: { registrationNumber: 1 }, limit: 10,
        columns: [
          { field: 'registrationNumber', label: 'Registration' },
          { field: 'subcontractorId', label: 'Subcontractor', ref: { model: 'supplier', field: 'Name' } },
        ] },
    ],
    related: ['task.vehicleReminders', 'vehicleService.scheduled'],
  },
};
