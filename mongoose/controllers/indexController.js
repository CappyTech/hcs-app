const path = require("path");
const listConfig = require("../config/listControllerConfig");
const customTiles = require("../config/dashboardTilesConfig");
const taskService = require("../services/taskService");
const holidayService = require("../services/holidayService");
const { getFrequentPages } = require("../services/sessionActivityService");
const rbac = require("../config/rolePermissionsConfig");
const { endOfToday, endOfWeek, endOfMonth } = require("date-fns");
const moment = require("moment-timezone");

const denyGuard = (config, op) =>
  Array.isArray(config.deny) && config.deny.includes(op);

// Helper: get all visible listable models for a department, filtered by role
const getDashboardModels = (department, userRole) => {
  const standardModels = Object.entries(listConfig)
    .filter(
      ([model, config]) =>
        config?.department?.includes(department) &&
        !denyGuard(config, "l") &&
        (userRole === "admin" || rbac.canAccess(userRole, model, "l")),
    )
    .map(([model, config]) => {
      const desc =
        typeof config.description === "object"
          ? config.description.manage
          : typeof config.description === "string"
            ? config.description
            : null;

      return {
        model,
        title: config.title || model.charAt(0).toUpperCase() + model.slice(1),
        description: desc || `View all ${config.title || model} records in a table.`,
        link: config.listPath || `/${model}s`,
      };
    });

  const extraTiles = Object.values(customTiles).filter((tile) =>
    tile.department?.includes(department),
  );

  return [...standardModels, ...extraTiles];
};

// Helper: get all creatable models, filtered by role
const getCreateModels = (userRole) => {
  return Object.entries(listConfig)
    .filter(
      ([model, config]) =>
        !denyGuard(config, "c") &&
        (userRole === "admin" || rbac.canAccess(userRole, model, "c")),
    )
    .map(([model, config]) => ({
      model,
      title: config.title || model.charAt(0).toUpperCase() + model.slice(1),
      description: config.description?.create || `Create a new ${model}.`,
      link: config.createPath || `/${model}/create`,
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
      recurring: [],
    };

    if (req.user) {
      const allTasks = await taskService.getPendingTasksForUser(req.user._id);
      const now = new Date();
      const todayEnd = endOfToday();
      const weekEnd = endOfWeek(now, { weekStartsOn: 6 });
      const monthEnd = endOfMonth(now);

      tasks.recurring = allTasks.filter(
        (t) => t.recurrence && t.recurrence !== "none",
      );
      tasks.general = allTasks.filter((t) => !t.dueDate);
      tasks.overdue = allTasks.filter(
        (t) => t.dueDate && new Date(t.dueDate) < now,
      );
      tasks.today = allTasks.filter(
        (t) =>
          t.dueDate &&
          new Date(t.dueDate) <= todayEnd &&
          new Date(t.dueDate) >= new Date(now.setHours(0, 0, 0, 0)),
      );
      tasks.week = allTasks.filter(
        (t) =>
          t.dueDate &&
          new Date(t.dueDate) > todayEnd &&
          new Date(t.dueDate) <= weekEnd,
      );
      tasks.month = allTasks.filter(
        (t) =>
          t.dueDate &&
          new Date(t.dueDate) > weekEnd &&
          new Date(t.dueDate) <= monthEnd,
      );
    }

    // Frequent pages (session-based)
    const frequentPages = req.user ? getFrequentPages(req.session) : [];

    // Task counts for summary badges
    const taskCounts = req.user
      ? await taskService.getTaskCountsForUser(req.user._id)
      : { total: 0, overdue: 0 };

    res.render(path.join("tailwindcss", "index"), {
      title: "Home",
      tasks,
      taskCounts,
      frequentPages,
      isAuthenticated: !!req.user,
      nextHoliday,
      moment,
    });
  } catch (err) {
    next(err);
  }
};

// Quick-add task from home page
exports.quickAddTask = async (req, res, next) => {
  try {
    const title = (req.body.title || "").trim();
    if (!title) {
      req.flash("error", "Task title is required.");
      return res.redirect("/");
    }
    const data = {
      title,
      userId: req.user._id,
    };
    if (req.body.dueDate) {
      data.dueDate = new Date(req.body.dueDate);
    }
    await taskService.createTask(data);
    req.flash("success", "Task added.");
    res.redirect("/");
  } catch (err) {
    next(err);
  }
};

// Complete a task from home page
exports.completeTask = async (req, res, next) => {
  try {
    const result = await taskService.completeTask(
      req.params.uuid,
      req.user._id,
    );
    if (result) {
      req.flash("success", "Task completed.");
    } else {
      req.flash("error", "Task not found.");
    }
    res.redirect("/");
  } catch (err) {
    next(err);
  }
};

const departments = [
  ["renderAdmin", "Admin", "admin"],
  ["renderAttendance", "Attendance", "attendance"],
  [
    "renderConstructionIndustryScheme",
    "Construction Industry Scheme",
    "construction-industry-scheme",
  ],
  ["renderManagement", "Management", "management"],
  ["renderMaintenance", "Maintenance", "maintenance"],
  ["renderPayroll", "Payroll", "payroll"],
  ["renderHumanResources", "Human Resources", "human-resources"],
  ["renderKashflow", "Kashflow", "kashflow"],
  ["renderCreate", "Create", "create"],
  ["renderPaperless", "Paperless OCR Documents", "paperless"],
  ["renderFinance", "Finance", "finance"],
  ["renderUser", "User", "user"],
];

departments.forEach(([exportName, title, department]) => {
  if (exportName === "renderCreate") {
    exports[exportName] = (req, res, next) => {
      const userRole = req.user?.role || "subcontractor";
      const createModels = getCreateModels(userRole);
      res.render(path.join("tailwindcss", "partials", "listModels"), {
        title,
        models: createModels,
      });
    };
  } else {
    exports[exportName] = (req, res, next) => {
      const userRole = req.user?.role || "subcontractor";
      const dashboardModels = getDashboardModels(department, userRole);
      res.render(path.join("tailwindcss", "partials", "listModels"), {
        title,
        models: dashboardModels,
      });
    };
  }
});
