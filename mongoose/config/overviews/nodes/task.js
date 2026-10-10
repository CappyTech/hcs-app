export default {
  id: 'task',
  model: 'task',
  label: { one: 'Task', many: 'Tasks' },
  icon: 'bi-check2-square',
  description: 'Work assigned to people, and the reminders the compliance checks raise.',
  parents: ['human'],
  overviewPath: '/overview/task',
  listPath: '/tasks',
  // The list page's columns (depth 3), in order. Only these show.
  list: {
    columns: [
      { field: 'title', label: 'Title' },
      { field: 'userId', label: 'Assignee' },
      { field: 'dueDate', label: 'Due Date' },
      { field: 'priority', label: 'Priority' },
      { field: 'source', label: 'Origin' },
      { field: 'recurrence', label: 'Recurrence' },
      { field: 'completed', label: 'Completed' },
      { field: 'completedAt', label: 'Completed At' },
      { field: 'autoResolved', label: 'Auto Resolved' },
      { field: 'contractId', label: 'Contract' },
    ],
  },
  actions: [{ label: 'New task', href: '/task/create', op: 'c' }],

  figures: {
    open: { label: 'Open tasks', where: { completed: false } },
    overdue: { label: 'Overdue', severity: 'critical', where: { completed: false, dueDate: { $beforeNow: true } } },
    dueWeek: { label: 'Due in the next 7 days', where: { completed: false, dueDate: { $withinNextDays: 7 } } },
    systemOpen: { label: 'Open compliance reminders', where: { completed: false, source: 'system' } },
    // Each admin gets their own copy of a compliance reminder, so count the viewer's copies:
    // one per reminder, matching what they can tick off.
    vehicleReminders: { label: 'Your open vehicle compliance reminders', severity: 'warning', where: { completed: false, userId: { $me: true }, systemKey: { $regex: '^vehicle:' } } },
    employeeReminders: { label: 'Your open HR compliance reminders', severity: 'warning', where: { completed: false, userId: { $me: true }, systemKey: { $regex: '^employee:' } } },
    doneMonth: { label: 'Completed in the last 30 days', where: { completed: true, completedAt: { $withinPastDays: 30 } } },
  },

  summary: ['open', 'overdue'],

  overview: {
    figures: ['open', 'overdue', 'dueWeek', 'systemOpen', 'doneMonth'],
    breakdowns: [
      { label: 'Open by priority', by: 'priority', where: { completed: false },
        labels: { high: 'High', normal: 'Normal', low: 'Low' } },
      { label: 'Open by origin', by: 'source', where: { completed: false },
        labels: { manual: 'Manual', system: 'System' } },
    ],
    lists: [
      { figure: 'overdue', sort: { dueDate: 1 }, limit: 10,
        columns: [
          { field: 'title', label: 'Task' },
          { field: 'userId', label: 'Assignee', ref: { model: 'user', field: 'username' } },
          { field: 'dueDate', label: 'Due', format: 'date' },
          { field: 'priority', label: 'Priority' },
        ] },
      { figure: 'dueWeek', sort: { dueDate: 1 }, limit: 10,
        columns: [
          { field: 'title', label: 'Task' },
          { field: 'userId', label: 'Assignee', ref: { model: 'user', field: 'username' } },
          { field: 'dueDate', label: 'Due', format: 'date' },
        ] },
    ],
  },
};
