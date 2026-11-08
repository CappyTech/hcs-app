// Health & Safety records (phase 5). Training & cards: who holds what, and
// what has run out or is about to. Inductions: who was inducted onto which
// site. RAMS: each site's risk assessments and who has been briefed on them.
// Expiry and review reminders come from healthSafetyComplianceService; these
// figures show the same rows.
const employeeCol = { field: 'employeeId', label: 'Employee', ref: { model: 'employee', field: 'name' } };
const subCol = { field: 'subcontractorId', label: 'Subcontractor', ref: { model: 'supplier', field: 'Name' } };
const siteCol = { field: 'contractId', label: 'Site', ref: { model: 'contract', field: 'title' } };

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
  {
    id: 'induction',
    model: 'induction',
    label: { one: 'Induction', many: 'Site inductions' },
    icon: 'bi-person-check',
    description: 'Who has been inducted onto which site, and when they are due again.',
    parents: ['healthSafety'],
    overviewPath: '/overview/induction',
    listPath: '/inductions',
    list: {
      columns: [
        { field: 'date', label: 'Date' },
        { field: 'contractId', label: 'Site' },
        { field: 'employeeId', label: 'Employee' },
        { field: 'subcontractorId', label: 'Subcontractor' },
        { field: 'personName', label: 'Operative' },
        { field: 'acknowledged', label: 'Signed?' },
        { field: 'expiryDate', label: 'Due again' },
      ],
    },
    actions: [{ label: 'Record an induction', href: '/inductions/record', route: '/inductions/record' }],
    figures: {
      all: { label: 'Inductions', where: {} },
      last30: { label: 'Inducted in the last 30 days', where: { date: { $withinPastDays: 30 } } },
      expired: { label: 'Re-induction overdue', severity: 'critical', where: { expiryDate: { $beforeNow: true } } },
      dueSoon: { label: 'Re-induction due in 30 days', severity: 'warning', where: { expiryDate: { $withinNextDays: 30 } } },
      unsigned: { label: 'Not signed', severity: 'warning', where: { acknowledged: false } },
    },
    summary: ['last30', 'expired', 'unsigned'],
    overview: {
      figures: ['all', 'last30', 'expired', 'dueSoon', 'unsigned'],
      lists: [
        { figure: 'last30', sort: { date: -1 }, limit: 10,
          columns: [{ field: 'date', label: 'Date', format: 'date' }, siteCol, employeeCol, subCol, { field: 'personName', label: 'Operative' }] },
        { figure: 'expired', sort: { expiryDate: 1 }, limit: 10,
          columns: [{ field: 'expiryDate', label: 'Was due', format: 'date' }, siteCol, employeeCol, subCol, { field: 'personName', label: 'Operative' }] },
        { figure: 'unsigned', sort: { date: -1 }, limit: 10,
          columns: [{ field: 'date', label: 'Date', format: 'date' }, siteCol, employeeCol, subCol] },
      ],
    },
  },
  {
    id: 'rams',
    model: 'rams',
    label: { one: 'RAMS', many: 'RAMS' },
    icon: 'bi-clipboard2-pulse',
    description: 'Risk assessments and method statements for each site, and when they are due for review.',
    parents: ['healthSafety'],
    overviewPath: '/overview/rams',
    listPath: '/rams',
    list: {
      columns: [
        { field: 'title', label: 'Title' },
        { field: 'reference', label: 'Ref' },
        { field: 'version', label: 'Version' },
        { field: 'contractId', label: 'Site' },
        { field: 'status', label: 'Status' },
        { field: 'approvedDate', label: 'Approved' },
        { field: 'reviewDate', label: 'Review due' },
      ],
    },
    actions: [{ label: 'Write a RAMS', href: '/rams/create', op: 'c' }],
    figures: {
      approved: { label: 'Approved', where: { status: 'Approved' } },
      drafts: { label: 'Drafts', where: { status: 'Draft' } },
      reviewOverdue: { label: 'Past their review date', severity: 'critical', where: { status: 'Approved', reviewDate: { $beforeNow: true } } },
      reviewDue: { label: 'Review due in 30 days', severity: 'warning', where: { status: 'Approved', reviewDate: { $withinNextDays: 30 } } },
      noReview: { label: 'Approved with no review date', severity: 'warning', where: { status: 'Approved', reviewDate: { $set: false } } },
    },
    summary: ['approved', 'drafts', 'reviewOverdue'],
    overview: {
      figures: ['approved', 'drafts', 'reviewOverdue', 'reviewDue', 'noReview'],
      breakdowns: [{ label: 'By status', by: 'status' }],
      lists: [
        { figure: 'drafts', sort: { updatedAt: -1 }, limit: 10,
          columns: [{ field: 'title', label: 'RAMS' }, siteCol, { field: 'version', label: 'Version' }] },
        { figure: 'reviewOverdue', sort: { reviewDate: 1 }, limit: 10,
          columns: [{ field: 'reviewDate', label: 'Review was due', format: 'date' }, { field: 'title', label: 'RAMS' }, siteCol] },
        { figure: 'reviewDue', sort: { reviewDate: 1 }, limit: 10,
          columns: [{ field: 'reviewDate', label: 'Review due', format: 'date' }, { field: 'title', label: 'RAMS' }, siteCol] },
      ],
    },
  },
  {
    id: 'ramsBriefing',
    model: 'ramsBriefing',
    label: { one: 'RAMS briefing', many: 'RAMS briefings' },
    icon: 'bi-clipboard2-check',
    description: 'Who has been briefed on which RAMS.',
    parents: ['healthSafety'],
    overviewPath: '/overview/ramsBriefing',
    listPath: '/ramsbriefings',
    list: {
      columns: [
        { field: 'date', label: 'Date' },
        { field: 'ramsId', label: 'RAMS' },
        { field: 'ramsVersion', label: 'Version' },
        { field: 'contractId', label: 'Site' },
        { field: 'employeeId', label: 'Employee' },
        { field: 'subcontractorId', label: 'Subcontractor' },
      ],
    },
    actions: [{ label: 'Record a RAMS briefing', href: '/rams/brief', route: '/rams/brief' }],
    figures: {
      all: { label: 'Briefings', where: {} },
      last30: { label: 'Briefed in the last 30 days', where: { date: { $withinPastDays: 30 } } },
    },
    summary: ['last30'],
    overview: {
      figures: ['all', 'last30'],
      lists: [
        { figure: 'last30', sort: { date: -1 }, limit: 15,
          columns: [{ field: 'date', label: 'Date', format: 'date' }, { field: 'ramsId', label: 'RAMS', ref: { model: 'rams', field: 'title' } }, siteCol, employeeCol, subCol] },
      ],
    },
  },
];
