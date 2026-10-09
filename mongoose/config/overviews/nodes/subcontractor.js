// Subcontractors: KashFlow suppliers registered under CIS. Same rows as the
// /subcontractors alias list (baseWhere mirrors its baseFilter), so every
// figure opens exactly the subcontractors it counts.
const HMRC_VERIFIED = {
  WithholdingTaxReferences: {
    $elemMatch: { Name: 'Verification Number', Value: { $regex: '^V\\d{7,10}(\\/[A-Z]{1,2})?$' } },
  },
};

export default {
  id: 'subcontractor',
  model: 'supplier',
  listName: 'subcontractor',
  baseWhere: { WithholdingTaxRate: { $gte: 0 } },
  label: { one: 'Subcontractor', many: 'Subcontractors' },
  icon: 'bi-person-gear',
  description: 'CIS-registered suppliers: deduction rates, HMRC verification and what they are owed.',
  parents: ['subcontractors'],
  overviewPath: '/overview/subcontractor',
  listPath: '/subcontractors',
  actions: [{ label: 'Edit CIS details', href: '/subcontractor/assign', route: '/subcontractor/assign', icon: 'bi-pencil-square' }],

  figures: {
    active: { label: 'Active subcontractors', where: { IsArchived: { $ne: true } } },
    verified: { label: 'Verified with HMRC', where: { IsArchived: { $ne: true }, ...HMRC_VERIFIED } },
    unverified: {
      label: 'Not verified with HMRC',
      hint: 'No valid HMRC verification number recorded',
      severity: 'warning',
      where: { IsArchived: { $ne: true }, $nor: [HMRC_VERIFIED] },
    },
    rate30: {
      label: 'Deducted at 30%',
      hint: 'Unmatched with HMRC: the higher rate applies',
      severity: 'warning',
      where: { IsArchived: { $ne: true }, WithholdingTaxRate: 30 },
    },
    owed: { label: 'With a balance outstanding', where: { IsArchived: { $ne: true }, OutstandingBalance: { $gt: 0 } } },
  },

  summary: ['active', 'unverified', 'rate30'],

  overview: {
    figures: ['active', 'verified', 'unverified', 'rate30', 'owed'],
    breakdowns: [
      { label: 'By deduction rate', by: 'WithholdingTaxRate', where: { IsArchived: { $ne: true } },
        labels: { 0: 'Gross (0%)', 20: '20%', 30: '30%' } },
    ],
    lists: [
      { figure: 'unverified', sort: { Name: 1 }, limit: 10,
        columns: [{ field: 'Name', label: 'Name' }, { field: 'Code', label: 'Code' }, { field: 'WithholdingTaxRate', label: 'Rate %' }] },
      { figure: 'owed', sort: { OutstandingBalance: -1 }, limit: 10,
        columns: [{ field: 'Name', label: 'Name' }, { field: 'OutstandingBalance', label: 'Outstanding', format: 'money' }] },
    ],
    panels: ['subcontractorRecentPurchases'],
    related: ['employee.ir35Subcontractor', 'user.subcontractorPortal'],
  },
};
