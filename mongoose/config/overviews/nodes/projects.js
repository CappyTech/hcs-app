// Projects area: hcs-app contracts and their weekly assignments, and the
// KashFlow projects they're billed against (REST, written by hcs-sync).
const OPEN_CONTRACT = { status: { $ne: 'Completed' } };
const ACTIVE_PROJECT = { Status: { $nin: ['Completed', 'Archived'] } };
// Same test as kashflowProjectService.computeFinancials: income recorded but below target
const BELOW_TARGET = { $expr: { $and: [{ $gt: ['$ActualSalesAmount', 0] }, { $lt: ['$ActualSalesAmount', '$TargetSalesAmount'] }] } };
const MET_TARGET = { $expr: { $and: [{ $gt: ['$TargetSalesAmount', 0] }, { $gt: ['$ActualSalesAmount', 0] }, { $gte: ['$ActualSalesAmount', '$TargetSalesAmount'] }] } };
const contractCol = { field: 'contractId', label: 'Contract', ref: { model: 'contract', field: 'title' } };

export default [
  {
    id: 'contract',
    model: 'contract',
    label: { one: 'Contract', many: 'Contracts' },
    icon: 'bi-file-earmark-text',
    description: 'Jobs on the go: what is running, starting, overdue or about to end.',
    parents: ['projects'],
    overviewPath: '/overview/contract',
    listPath: '/contracts',
    actions: [{ label: 'New contract', href: '/contract/create', op: 'c' }],
    figures: {
      inProgress: { label: 'In progress', where: { status: 'In Progress' } },
      planned: { label: 'Planned', where: { status: 'Planned' } },
      overdue: { label: 'Past their end date', hint: 'Not completed, end date passed', severity: 'critical', where: { ...OPEN_CONTRACT, endDate: { $beforeNow: true } } },
      endingSoon: { label: 'Ending in 30 days', severity: 'warning', where: { ...OPEN_CONTRACT, endDate: { $withinNextDays: 30 } } },
      startingSoon: { label: 'Starting in 30 days', where: { status: 'Planned', startDate: { $withinNextDays: 30 } } },
      completedYear: { label: 'Completed in the last year', where: { status: 'Completed', endDate: { $withinPastDays: 365 } } },
    },
    summary: ['inProgress', 'overdue', 'endingSoon'],
    overview: {
      figures: ['inProgress', 'planned', 'overdue', 'endingSoon', 'startingSoon', 'completedYear'],
      breakdowns: [{ label: 'By status', by: 'status' }],
      lists: [
        { figure: 'overdue', sort: { endDate: 1 }, limit: 10,
          columns: [{ field: 'title', label: 'Contract' }, { field: 'endDate', label: 'Was due', format: 'date' }, { field: 'status', label: 'Status' }] },
        { figure: 'endingSoon', sort: { endDate: 1 }, limit: 10,
          columns: [{ field: 'title', label: 'Contract' }, { field: 'endDate', label: 'Ends', format: 'date' }] },
        { figure: 'startingSoon', sort: { startDate: 1 }, limit: 10,
          columns: [{ field: 'title', label: 'Contract' }, { field: 'startDate', label: 'Starts', format: 'date' }] },
      ],
      panels: ['contractsWithoutAssignments'],
      related: ['assignment.thisWeek', 'assignment.unstaffed'],
    },
  },
  {
    id: 'assignment',
    model: 'assignment',
    label: { one: 'Assignment', many: 'Assignments' },
    icon: 'bi-calendar-week',
    description: 'Who is on which contract, week by week.',
    parents: ['projects'],
    overviewPath: '/overview/assignment',
    listPath: '/assignments',
    actions: [{ label: 'New assignment', href: '/assignment/create', op: 'c' }],
    figures: {
      thisWeek: { label: 'Assignments this week', where: { weekStart: { $withinPastDays: 7 } } },
      upcoming: { label: 'Booked for the next 4 weeks', where: { weekStart: { $withinNextDays: 28 } } },
      unstaffed: {
        label: 'Not done and nobody assigned',
        severity: 'warning',
        where: { status: { $ne: 'Done' }, assignedEmployees: { $size: 0 }, assignedSubcontractors: { $size: 0 } },
      },
      inProgress: { label: 'In progress', where: { status: 'In Progress' } },
    },
    summary: ['thisWeek', 'unstaffed'],
    overview: {
      figures: ['thisWeek', 'upcoming', 'inProgress', 'unstaffed'],
      breakdowns: [{ label: 'Not done, by status', by: 'status', where: { status: { $ne: 'Done' } } }],
      lists: [
        { figure: 'thisWeek', sort: { weekStart: 1 }, limit: 15,
          columns: [{ field: 'title', label: 'Assignment' }, contractCol, { field: 'weekStart', label: 'Week of', format: 'date' }, { field: 'status', label: 'Status' }] },
        { figure: 'unstaffed', sort: { weekStart: 1 }, limit: 10,
          columns: [{ field: 'title', label: 'Assignment' }, contractCol, { field: 'weekStart', label: 'Week of', format: 'date' }] },
      ],
      related: ['contract.overdue'],
    },
  },
  {
    id: 'project',
    model: 'project',
    label: { one: 'KashFlow project', many: 'KashFlow projects' },
    icon: 'bi-kanban',
    description: 'Projects in KashFlow: income against target, and which can be closed.',
    parents: ['projects'],
    overviewPath: '/overview/project',
    listPath: '/projects',
    figures: {
      active: { label: 'Active projects', where: ACTIVE_PROJECT },
      belowTarget: { label: 'Income below target', hint: 'Income recorded, but less than the target', severity: 'critical', where: { ...ACTIVE_PROJECT, ...BELOW_TARGET } },
      metTarget: { label: 'Met target, ready to close', severity: 'warning', where: { ...ACTIVE_PROJECT, ...MET_TARGET } },
      wip: { label: 'Work in progress (value)', sum: 'WorkInProgressAmount', format: 'money', where: ACTIVE_PROJECT },
    },
    summary: ['active', 'belowTarget', 'metTarget'],
    overview: {
      figures: ['active', 'belowTarget', 'metTarget', 'wip'],
      breakdowns: [{ label: 'By status', by: 'Status' }],
      panels: ['projectFinancials'],
    },
  },
];
