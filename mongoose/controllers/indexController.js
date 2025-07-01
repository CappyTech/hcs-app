const path = require('path');
const listConfig = require('../config/listControllerConfig');
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

const taskService = require('../services/taskServiceMongoose');
const {
  endOfToday,
  endOfWeek,
  endOfMonth
} = require('date-fns');

exports.renderIndex = async (req, res, next) => {
  try {
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

    res.render('mongoose/index', {
      title: 'Home',
      tasks,
      isAuthenticated: !!req.user
    });
  } catch (err) {
    next(err);
  }
};

exports.renderConstructionIndustryScheme = (req, res, next) => {
  res.render(path.join('mongoose', 'header', 'construction-industry-scheme'), {
    title: 'Construction Industry Scheme',
  });
};

exports.renderManagement = (req, res, next) => {
  const dashboardModels = getDashboardModels('management');
  res.render(path.join('mongoose', 'header', 'management'), {
    title: 'Management',
    dashboardModels
  });
};

exports.renderPayroll = (req, res, next) => {
  const dashboardModels = getDashboardModels('payroll');
  res.render(path.join('mongoose', 'header', 'payroll'), {
    title: 'Payroll',
    dashboardModels
  });
};

exports.renderHumanResources = (req, res, next) => {
  const dashboardModels = getDashboardModels('human-resources');
  res.render(path.join('mongoose', 'header', 'human-resources'), {
    title: 'Human Resources',
    dashboardModels
  });
};

exports.renderKashflow = (req, res, next) => {
  const dashboardModels = getDashboardModels('kashflow');
  res.render(path.join('mongoose', 'header', 'kashflow'), {
    title: 'Kashflow',
    dashboardModels
  });
};

exports.renderCreate = (req, res, next) => {
  const createModels = Object.entries(listConfig)
    .filter(([_, config]) => !Array.isArray(config.deny) || !config.deny.includes('c'))
    .map(([model, config]) => ({
      model,
      title: config.title || model.charAt(0).toUpperCase() + model.slice(1),
      description: config.description || `Create a new ${model}.`,
      link: config.createPath || `/${model}/create`
    }));

  res.render(path.join('mongoose', 'header', 'create'), {
    title: 'Create',
    createModels
  });
};

