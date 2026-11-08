// Health & Safety records (phase 5). Training & cards: who holds what, and
// what has run out or is about to. Expiry reminders come from
// healthSafetyComplianceService; these figures show the same rows.
const employeeCol = { field: 'employeeId', label: 'Employee', ref: { model: 'employee', field: 'name' } };
const subCol = { field: 'subcontractorId', label: 'Subcontractor', ref: { model: 'supplier', field: 'Name' } };

export default [
  {
    id: 'trainingRecord',
    model: 'trainingRecord',
    label: { one: 'Training record', many: 'Training & cards' },
    icon: 'bi-person-vcard',
    description: 'Site cards, plant tickets, first aid and courses, with their expiry dates.',
    parents: ['healthSafety'],
    overviewPath: '/overview/trainingRecord',
    listPath: '/trainingRecords',
    list: {
      columns: [
        { field: 'type', label: 'Type' },
        { field: 'title', label: 'Detail' },
        { field: 'employeeId', label: 'Employee' },
        { field: 'subcontractorId', label: 'Subcontractor' },
        { field: 'personName', label: 'Operative' },
        { field: 'cardNumber', label: 'Card no.' },
        { field: 'expiryDate', label: 'Expires' },
        { field: 'checkedDate', label: 'Checked' },
      ],
    },
    actions: [{ label: 'Add training or a card', href: '/trainingRecord/create', op: 'c' }],
    figures: {
      all: { label: 'Training records', where: {} },
      expired: { label: 'Expired', severity: 'critical', where: { expiryDate: { $beforeNow: true } } },
      dueSoon: { label: 'Expiring in 30 days', severity: 'warning', where: { expiryDate: { $withinNextDays: 30 } } },
      unchecked: { label: 'Card not checked', severity: 'warning', where: { checkedDate: { $set: false } } },
      employees: { label: 'Held by employees', where: { employeeId: { $set: true } } },
      subcontractors: { label: 'Held by subcontractors', where: { subcontractorId: { $set: true } } },
    },
    summary: ['expired', 'dueSoon', 'unchecked'],
    overview: {
      figures: ['all', 'expired', 'dueSoon', 'unchecked', 'employees', 'subcontractors'],
      breakdowns: [{ label: 'By type', by: 'type' }],
      lists: [
        { figure: 'expired', sort: { expiryDate: 1 }, limit: 10,
          columns: [{ field: 'expiryDate', label: 'Expired', format: 'date' }, { field: 'type', label: 'Type' }, employeeCol, subCol, { field: 'personName', label: 'Operative' }] },
        { figure: 'dueSoon', sort: { expiryDate: 1 }, limit: 10,
          columns: [{ field: 'expiryDate', label: 'Expires', format: 'date' }, { field: 'type', label: 'Type' }, employeeCol, subCol, { field: 'personName', label: 'Operative' }] },
      ],
    },
  },
];
