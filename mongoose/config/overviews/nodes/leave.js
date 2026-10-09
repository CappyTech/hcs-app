// Holiday: a group node with its own generated overview (/overview/holiday),
// built from the holiday-request figures plus two custom panels (balances,
// upcoming holidays) that need arithmetic or merge two models. The models
// beneath it are list-only nodes so breadcrumbs and pre-filtered links work.
// The group id is 'leave' because 'holiday' is the bank-holidays model.
const requestCols = [
  { field: 'employeeId', label: 'Employee', ref: { model: 'employee', field: 'name' } },
  { field: 'startDate', label: 'From', format: 'date' },
  { field: 'endDate', label: 'To', format: 'date' },
  { field: 'daysRequested', label: 'Days' },
  { field: 'leaveType', label: 'Type' },
];

export default [
  {
    id: 'leave',
    label: { one: 'Holiday', many: 'Holiday' },
    icon: 'bi-calendar-check',
    description: 'Entitlement, requests and approvals.',
    parents: ['human'],
    overviewPath: '/overview/holiday',
    actions: [{ label: 'New holiday record', href: '/employeeHoliday/create', op: 'c', model: 'employeeHoliday' }],
    summary: ['holidayRequest.pending', 'holidayRequest.onLeaveToday', 'holidayRequest.upcoming'],
    overview: {
      figures: ['holidayRequest.pending', 'holidayRequest.onLeaveToday', 'holidayRequest.upcoming', 'holidayRequest.decided30'],
      lists: [
        { figure: 'holidayRequest.pending', sort: { startDate: 1 }, limit: 15, columns: requestCols },
        { figure: 'holidayRequest.onLeaveToday', sort: { endDate: 1 }, limit: 15, columns: requestCols },
        { figure: 'holidayRequest.upcoming', sort: { startDate: 1 }, limit: 15, columns: requestCols },
      ],
      panels: ['holidayBalances', 'upcomingHolidays'],
      related: ['attendance.pending'],
    },
  },
  {
    id: 'holidayRequest',
    model: 'holidayRequest',
    label: { one: 'Holiday request', many: 'Holiday requests' },
    parents: ['leave'],
    listPath: '/holidayRequests',
    figures: {
      pending: { label: 'Holiday requests to approve', severity: 'warning', where: { status: 'pending' } },
      upcoming: { label: 'Approved holiday starting in 30 days', where: { status: 'approved', startDate: { $withinNextDays: 30 } } },
      onLeaveToday: { label: 'On holiday today', where: { status: 'approved', startDate: { $beforeNow: true }, endDate: { $afterNow: true } } },
      decided30: { label: 'Approved or turned down, last 30 days', where: { status: { $in: ['approved', 'rejected'] }, reviewedAt: { $withinPastDays: 30 } } },
    },
  },
  { id: 'employeeHoliday', model: 'employeeHoliday', label: { one: 'Holiday record', many: 'Holiday records' }, parents: ['leave'], listPath: '/employeeHolidays' },
  { id: 'holiday', model: 'holiday', label: { one: 'Bank holiday', many: 'Bank holidays' }, parents: ['leave'], listPath: '/holidays' },
  { id: 'holidayCustom', model: 'holidayCustom', label: { one: 'Company holiday', many: 'Company holidays' }, parents: ['leave'], listPath: '/holidayCustoms' },
];
