// Weekly attendance: one payroll week across contracts, assignments and
// attendance. A group (no model of its own): its figures are borrowed and its
// week-by-week state comes from the weeklyAttendance panels (weeklyFlowService).
export default {
  id: 'weekly',
  label: { one: 'Weekly attendance', many: 'Weekly attendance' },
  icon: 'bi-calendar-check',
  description: 'This payroll week, step by step: contracts, assignments, attendance and approval.',
  parents: ['projects', 'human'],
  overviewPath: '/overview/weekly',
  actions: [{ label: 'Do weekly attendance', href: '/weekly-flow', route: '/weekly-flow', icon: 'bi-calendar-check' }],
  summary: ['attendance.pending', 'assignment.thisWeek'],
  overview: {
    figures: ['attendance.pending', 'assignment.thisWeek', 'assignment.unstaffed'],
    panels: ['weeklyAttendanceSteps', 'weeklyAttendanceChecks'],
    related: ['contract.inProgress', 'attendance.lastWeek'],
  },
};
