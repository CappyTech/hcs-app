const path = require('path');
const listConfig = require('../config/listControllerConfig');
const taskService = require('../services/taskServiceMongoose');
const {
  endOfToday,
  endOfWeek,
  endOfMonth
} = require('date-fns');
const holidayService = require('../services/holidayServiceMongoose')

const denyGuard = (config, op) => Array.isArray(config.deny) && config.deny.includes(op);

// Helper to get all visible listable models for a department
const getDashboardModels = (department) => {
  return Object.entries(listConfig)
    .filter(([_, config]) =>
      config.department?.includes(department) &&
      !denyGuard(config, 'l')
    )
    .map(([model, config]) => ({
      model,
      title: config.title || model.charAt(0).toUpperCase() + model.slice(1),
      description: config.description || `Manage ${model}s.`,
      link: config.listPath || `/${model}s`
    }));
};

// Helper to get all creatable models
const getCreateModels = () => {
  return Object.entries(listConfig)
    .filter(([_, config]) => !denyGuard(config, 'c'))
    .map(([model, config]) => ({
      model,
      title: config.title || model.charAt(0).toUpperCase() + model.slice(1),
      description: config.description || `Create a new ${model}.`,
      link: config.createPath || `/${model}/create`
    }));
};

// Home / Index Page
exports.renderIndex = async (req, res, next) => {
  try {
    const nextHoliday = await holidayService.getNextHoliday();
    let tasks = {
      overdue: [],
      today: [],
      week: [],
      month: [],
      general: [],
      recurring: []
    };

    if (req.user) {
      const allTasks = await taskService.getPendingTasksForUser(req.user._id);
      const now = new Date();
      const todayEnd = endOfToday();
      const weekEnd = endOfWeek(now, { weekStartsOn: 6 }); // Saturday to Friday
      const monthEnd = endOfMonth(now);

      tasks.recurring = allTasks.filter(t => t.recurrence && t.recurrence !== 'none');
      tasks.general = allTasks.filter(t => !t.dueDate);
      tasks.overdue = allTasks.filter(t => t.dueDate && new Date(t.dueDate) < now);
      tasks.today = allTasks.filter(t => t.dueDate && new Date(t.dueDate) <= todayEnd && new Date(t.dueDate) >= new Date(now.setHours(0, 0, 0, 0)));
      tasks.week = allTasks.filter(t => t.dueDate && new Date(t.dueDate) > todayEnd && new Date(t.dueDate) <= weekEnd);
      tasks.month = allTasks.filter(t => t.dueDate && new Date(t.dueDate) > weekEnd && new Date(t.dueDate) <= monthEnd);
    }

    res.render(path.join('tailwindcss', 'index'), {
      title: 'Home',
      tasks,
      isAuthenticated: !!req.user,
      nextHoliday
    });
  } catch (err) {
    next(err);
  }
};
const departments = [
  ['renderConstructionIndustryScheme', 'Construction Industry Scheme', 'construction-industry-scheme'],
  ['renderManagement', 'Management', 'management'],
  ['renderPayroll', 'Payroll', 'payroll'],
  ['renderHumanResources', 'Human Resources','human-resources'],
  ['renderKashflow', 'Kashflow', 'kashflow'],
  ['renderCreate', 'Create', 'create']
];

departments.forEach(([exportName, title, department]) => {
  if (exportName === 'renderCreate') {
    exports[exportName] = (req, res, next) => {
      const createModels = getCreateModels();
      res.render(path.join('tailwindcss', 'partials', 'listModels'), {
        title,
        models: createModels
      });
    };
  } else if (exportName === 'renderConstructionIndustryScheme') {
    exports[exportName] = (req, res, next) => {
      res.render(path.join('tailwindcss', 'header', department), {
        title
      });
    };
  } else {
    exports[exportName] = (req, res, next) => {
      const dashboardModels = getDashboardModels(department);
      res.render(path.join('tailwindcss', 'partials', 'listModels'), {
        title,
        models: dashboardModels
      });
    };
  }
});

