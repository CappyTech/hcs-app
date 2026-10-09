// Holiday: a group node. Its overview is still the hand-built /overview/holiday
// page (to be converted later); the models beneath it are list-only nodes so
// breadcrumbs and pre-filtered links work through the whole chain.
// The group id is 'leave' because 'holiday' is the bank-holidays model.
export default [
  {
    id: 'leave',
    label: { one: 'Holiday', many: 'Holiday' },
    icon: 'bi-calendar-check',
    description: 'Entitlement, requests and approvals.',
    parents: ['human'],
    overviewPath: '/overview/holiday',
    summary: ['holidayRequest.pending', 'holidayRequest.upcoming'],
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
    },
  },
  { id: 'employeeHoliday', model: 'employeeHoliday', label: { one: 'Holiday record', many: 'Holiday records' }, parents: ['leave'], listPath: '/employeeHolidays' },
  { id: 'holiday', model: 'holiday', label: { one: 'Bank holiday', many: 'Bank holidays' }, parents: ['leave'], listPath: '/holidays' },
  { id: 'holidayCustom', model: 'holidayCustom', label: { one: 'Company holiday', many: 'Company holidays' }, parents: ['leave'], listPath: '/holidayCustoms' },
];
