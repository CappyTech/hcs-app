// Fleet records: services, fuel and mileage. Each is its own model with an
// overview; totals (spend, litres, miles) are sum figures over the same rows
// the figure's link opens.
const vehicleCol = { field: 'vehicleId', label: 'Vehicle', ref: { model: 'vehicle', field: 'registrationNumber' } };

export default [
  {
    id: 'vehicleService',
    model: 'vehicleService',
    label: { one: 'Service', many: 'Services' },
    icon: 'bi-wrench-adjustable',
    description: 'Servicing, repairs and MOTs, booked and done.',
    parents: ['fleet'],
    overviewPath: '/overview/vehicleService',
    listPath: '/vehicleServices',
    actions: [{ label: 'Log a service', href: '/vehicleService/create', op: 'c' }],
    figures: {
      scheduled: { label: 'Services booked', where: { status: 'Scheduled' } },
      inProgress: { label: 'In progress', where: { status: 'In Progress' } },
      dueSoon: { label: 'Next service due in 30 days', severity: 'warning', where: { nextServiceDueDate: { $withinNextDays: 30 } } },
      motFails: { label: 'MOT fails in the last year', severity: 'warning', where: { serviceType: 'MOT', passed: false, date: { $withinPastDays: 365 } } },
      spend30: { label: 'Spent in the last 30 days', sum: 'totalCost', format: 'money', where: { status: 'Completed', date: { $withinPastDays: 30 } } },
      spendYear: { label: 'Spent in the last year', sum: 'totalCost', format: 'money', where: { status: 'Completed', date: { $withinPastDays: 365 } } },
    },
    summary: ['scheduled', 'dueSoon', 'spend30'],
    overview: {
      figures: ['scheduled', 'inProgress', 'dueSoon', 'motFails', 'spend30', 'spendYear'],
      breakdowns: [{ label: 'Last year by type', by: 'serviceType', where: { date: { $withinPastDays: 365 } } }],
      lists: [
        { figure: 'scheduled', sort: { date: 1 }, limit: 10,
          columns: [{ field: 'date', label: 'Date', format: 'date' }, vehicleCol, { field: 'serviceType', label: 'Type' }, { field: 'provider', label: 'Garage' }] },
        { figure: 'dueSoon', sort: { nextServiceDueDate: 1 }, limit: 10,
          columns: [{ field: 'nextServiceDueDate', label: 'Due', format: 'date' }, vehicleCol, { field: 'serviceType', label: 'Last service' }] },
        { figure: 'spend30', sort: { date: -1 }, limit: 10,
          columns: [{ field: 'date', label: 'Date', format: 'date' }, vehicleCol, { field: 'serviceType', label: 'Type' }, { field: 'totalCost', label: 'Cost', format: 'money' }] },
      ],
    },
  },
  {
    id: 'vehicleFuelLog',
    model: 'vehicleFuelLog',
    label: { one: 'Fuel record', many: 'Fuel' },
    icon: 'bi-fuel-pump',
    description: 'Fill-ups: what was spent, by whom, and how it was paid.',
    parents: ['fleet'],
    overviewPath: '/overview/vehicleFuelLog',
    listPath: '/vehicleFuelLogs',
    actions: [{ label: 'Log fuel', href: '/vehicleFuelLog/create', op: 'c' }],
    figures: {
      spend30: { label: 'Fuel spend, last 30 days', sum: 'totalCost', format: 'money', where: { date: { $withinPastDays: 30 } } },
      litres30: { label: 'Litres, last 30 days', sum: 'litres', unit: 'L', where: { date: { $withinPastDays: 30 } } },
      fills30: { label: 'Fill-ups, last 30 days', where: { date: { $withinPastDays: 30 } } },
      personal30: { label: 'Paid personally (to reimburse), last 30 days', sum: 'totalCost', format: 'money', where: { paymentMethod: 'Personal (Expense)', date: { $withinPastDays: 30 } } },
    },
    summary: ['spend30', 'fills30'],
    overview: {
      figures: ['spend30', 'litres30', 'fills30', 'personal30'],
      breakdowns: [
        { label: 'Last 30 days by fuel', by: 'fuelType', where: { date: { $withinPastDays: 30 } } },
        { label: 'Last 30 days by payment', by: 'paymentMethod', where: { date: { $withinPastDays: 30 } } },
      ],
      lists: [
        { figure: 'fills30', sort: { date: -1 }, limit: 10,
          columns: [
            { field: 'date', label: 'Date', format: 'date' }, vehicleCol,
            { field: 'employeeId', label: 'Driver', ref: { model: 'employee', field: 'name' } },
            { field: 'totalCost', label: 'Cost', format: 'money' },
          ] },
      ],
    },
  },
  {
    id: 'vehicleMileageLog',
    model: 'vehicleMileageLog',
    label: { one: 'Mileage record', many: 'Mileage' },
    icon: 'bi-speedometer',
    description: 'Journeys: distance, purpose and what can be claimed.',
    parents: ['fleet'],
    overviewPath: '/overview/vehicleMileageLog',
    listPath: '/vehicleMileageLogs',
    actions: [{ label: 'Log a journey', href: '/vehicleMileageLog/create', op: 'c' }],
    figures: {
      trips30: { label: 'Journeys, last 30 days', where: { date: { $withinPastDays: 30 } } },
      miles30: { label: 'Miles, last 30 days', sum: 'distance', unit: 'mi', where: { date: { $withinPastDays: 30 } } },
      claimable30: { label: 'Claimable miles, last 30 days', sum: 'distance', unit: 'mi', where: { claimable: true, date: { $withinPastDays: 30 } } },
    },
    summary: ['trips30', 'miles30'],
    overview: {
      figures: ['trips30', 'miles30', 'claimable30'],
      breakdowns: [{ label: 'Last 30 days by purpose', by: 'tripPurpose', where: { date: { $withinPastDays: 30 } } }],
      lists: [
        { figure: 'trips30', sort: { date: -1 }, limit: 10,
          columns: [
            { field: 'date', label: 'Date', format: 'date' }, vehicleCol,
            { field: 'employeeId', label: 'Driver', ref: { model: 'employee', field: 'name' } },
            { field: 'tripPurpose', label: 'Purpose' },
            { field: 'distance', label: 'Miles' },
          ] },
      ],
    },
  },
];
