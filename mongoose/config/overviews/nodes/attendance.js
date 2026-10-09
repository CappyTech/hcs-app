export default {
  id: 'attendance',
  model: 'attendance',
  label: { one: 'Attendance record', many: 'Attendance' },
  icon: 'bi-clock',
  description: 'Days worked, sick, on holiday or off, and what still needs approving.',
  parents: ['human'],
  overviewPath: '/overview/attendance',
  listPath: '/attendances',
  actions: [{ label: 'Log attendance', href: '/attendance/create', op: 'c' }],

  figures: {
    pending: { label: 'Awaiting approval', severity: 'warning', where: { status: 'pending' } },
    lastWeek: { label: 'Records in the last 7 days', where: { date: { $withinPastDays: 7 } } },
    sickMonth: { label: 'Sick days in the last 30 days', where: { type: 'sick', date: { $withinPastDays: 30 } } },
    rejected: { label: 'Rejected in the last 30 days', where: { status: 'rejected', date: { $withinPastDays: 30 } } },
  },

  summary: ['pending', 'lastWeek'],

  overview: {
    figures: ['pending', 'lastWeek', 'sickMonth', 'rejected'],
    breakdowns: [
      { label: 'Last 7 days by type', by: 'type', where: { date: { $withinPastDays: 7 } },
        labels: { work: 'Work', sick: 'Sick', holiday: 'Holiday', training: 'Training', off: 'Off', leave: 'Leave' } },
    ],
    lists: [
      { figure: 'pending', sort: { date: -1 }, limit: 15,
        columns: [
          { field: 'date', label: 'Date', format: 'date' },
          { field: 'employeeId', label: 'Employee', ref: { model: 'employee', field: 'name' } },
          { field: 'subcontractorId', label: 'Subcontractor', ref: { model: 'supplier', field: 'Name' } },
          { field: 'type', label: 'Type' },
        ] },
    ],
  },
};
