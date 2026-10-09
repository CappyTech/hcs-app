// Payroll: runs and HMRC submissions. Their lists are custom pages guarded by
// routes (admin and accountant), so access follows `listRoute`, figures open the
// list page itself, and the overview's own lists show the matching rows.
const THIS_YEAR = { taxYear: { $currentTaxYear: true } };
const COUNTED = { ...THIS_YEAR, status: { $ne: 'draft' } }; // year-to-date totals leave drafts out
const runCols = [
  { field: 'paymentDate', label: 'Paid on', format: 'date' },
  { field: 'taxMonth', label: 'Tax month' },
  { field: 'frequency', label: 'Frequency' },
  { field: 'status', label: 'Status' },
  { field: 'totals.grossPay', label: 'Gross', format: 'money' },
];

export default [
  {
    id: 'payrollRun',
    model: 'payrollRun',
    label: { one: 'Payroll run', many: 'Payroll runs' },
    icon: 'bi-cash-stack',
    description: 'Pay runs this tax year: drafts, locked runs waiting to go to HMRC, and year-to-date totals.',
    parents: ['payroll'],
    overviewPath: '/overview/payrollRun',
    listPath: '/payroll/runs',
    listRoute: '/payroll/runs',
    readPath: '/payroll/run/:uuid',
    figures: {
      runs: { label: 'Runs this tax year', where: THIS_YEAR },
      drafts: { label: 'Draft runs', hint: 'Not yet locked', severity: 'warning', where: { ...THIS_YEAR, status: 'draft' } },
      locked: { label: 'Locked, not yet submitted', severity: 'warning', where: { ...THIS_YEAR, status: 'locked' } },
      gross: { label: 'Gross pay, year to date', sum: 'totals.grossPay', format: 'money', where: COUNTED },
      tax: { label: 'Tax deducted, year to date', sum: 'totals.taxDeducted', format: 'money', where: COUNTED },
      employeeNI: { label: 'Employee NI, year to date', sum: 'totals.employeeNI', format: 'money', where: COUNTED },
      employerNI: { label: 'Employer NI, year to date', sum: 'totals.employerNI', format: 'money', where: COUNTED },
      net: { label: 'Net pay, year to date', sum: 'totals.netPay', format: 'money', where: COUNTED },
    },
    summary: ['runs', 'locked', 'gross'],
    overview: {
      figures: ['runs', 'drafts', 'locked', 'gross', 'tax', 'employeeNI', 'employerNI', 'net'],
      breakdowns: [{ label: 'This tax year by status', by: 'status', where: THIS_YEAR,
        labels: { draft: 'Draft', locked: 'Locked', submitted: 'Submitted' } }],
      lists: [
        { figure: 'locked', sort: { paymentDate: 1 }, limit: 10, columns: runCols },
        { figure: 'drafts', sort: { paymentDate: 1 }, limit: 10, columns: runCols },
        { figure: 'runs', title: 'Latest runs this tax year', sort: { paymentDate: -1 }, limit: 5, columns: runCols },
      ],
      panels: ['payrollMonthly'],
      related: ['employee.pensionEnrolled', 'payrollSubmission.rejected'],
    },
  },
  {
    id: 'payrollSubmission',
    model: 'payrollSubmission',
    label: { one: 'HMRC submission', many: 'HMRC submissions' },
    icon: 'bi-send-check',
    description: 'FPS and EPS returns sent to HMRC this tax year, and any HMRC turned down.',
    parents: ['payroll'],
    overviewPath: '/overview/payrollSubmission',
    listPath: '/payroll/submissions',
    listRoute: '/payroll/submissions',
    readPath: false, // submissions are shown on their list page; there's no detail page
    figures: {
      thisYear: { label: 'Submissions this tax year', where: THIS_YEAR },
      generated: { label: 'Generated, not yet sent', severity: 'warning', where: { ...THIS_YEAR, status: 'generated' } },
      rejected: { label: 'Rejected by HMRC', severity: 'critical', where: { ...THIS_YEAR, status: 'rejected' } },
      accepted: { label: 'Accepted by HMRC', where: { ...THIS_YEAR, status: 'accepted' } },
    },
    summary: ['thisYear', 'generated', 'rejected'],
    overview: {
      figures: ['thisYear', 'generated', 'rejected', 'accepted'],
      breakdowns: [{ label: 'This tax year by type', by: 'type', where: THIS_YEAR }],
      lists: [
        { figure: 'rejected', sort: { createdAt: -1 }, limit: 10,
          columns: [{ field: 'type', label: 'Type' }, { field: 'taxMonth', label: 'Tax month' }, { field: 'createdAt', label: 'Created', format: 'date' }] },
        { figure: 'generated', sort: { createdAt: -1 }, limit: 10,
          columns: [{ field: 'type', label: 'Type' }, { field: 'taxMonth', label: 'Tax month' }, { field: 'createdAt', label: 'Created', format: 'date' }] },
        { figure: 'thisYear', title: 'Latest submissions', sort: { createdAt: -1 }, limit: 8,
          columns: [{ field: 'type', label: 'Type' }, { field: 'taxMonth', label: 'Tax month' }, { field: 'status', label: 'Status' }, { field: 'submittedAt', label: 'Sent', format: 'date' }] },
      ],
    },
  },
];
