import path from 'path';
import listConfig from '../config/listControllerConfig.js';
import customTiles from '../config/dashboardTilesConfig.js';
import taskService from '../services/taskService.js';
import holidayService from '../services/holidayService.js';
import { getFrequentPages } from '../services/sessionActivityService.js';
import rbac from '../config/rolePermissionsConfig.js';
import departments from '../config/departmentsConfig.js';
import tileMeta from '../config/dashboardTileMetaConfig.js';
import dashboardCountService from '../services/dashboardCountService.js';
import { endOfToday, endOfWeek, endOfMonth } from 'date-fns';

const denyGuard = (config, op) =>
  Array.isArray(config.deny) && config.deny.includes(op);

/**
 * May this role actually use the page a custom tile points at?
 *
 * Model tiles have always been role-filtered; custom tiles were filtered by
 * department alone, so any department wider than the routes inside it
 * advertised links that answer 403. That was live in two places: a
 * subcontractor saw the CIS Dashboard and Assign Subcontractors tiles (both
 * narrower than the CIS department), and an admin saw Submit Attendance, which
 * only employees and subcontractors may open.
 *
 * The answer is derived from routeAccess rather than declared per tile, so it
 * cannot drift out of step with the guard it describes. Two deliberate
 * fallbacks to department membership, both meaning "routeAccess has no opinion":
 * external links (nothing to match), and internal paths with no entry.
 */
const canUseTile = (tile, userRole) => {
  if (userRole === 'admin') return true;
  const link = String(tile?.link || '');
  if (!link.startsWith('/')) return true; // external link

  const pattern = rbac.matchRoutePattern(link);
  if (!pattern) return true; // not a controlled route

  return rbac.canAccessRoute(userRole, pattern);
};

// Helper: get all visible listable models for a department, filtered by role.
// Async because tiles are decorated with best-effort counts (see
// dashboardCountService — cached and time-boxed, so this stays fast).
const getDashboardModels = async (department, userRole) => {
  const standardModels = Object.entries(listConfig)
    .filter(
      ([model, config]) =>
        config?.department?.includes(department) &&
        !denyGuard(config, "l") &&
        // .allowed, not the bare return value: canAccess returns
        // { allowed, ownOnly }, and an object is always truthy — so this
        // filter passed for every role and every model, showing a
        // department's whole tile list to anyone who could open it.
        (userRole === "admin" || rbac.canAccess(userRole, model, "l").allowed),
    )
    .map(([model, config]) => {
      const desc =
        typeof config.description === "object"
          ? config.description.manage
          : typeof config.description === "string"
            ? config.description
            : null;

      return {
        tileKey: model,
        model,
        title: config.title || model.charAt(0).toUpperCase() + model.slice(1),
        description: desc || `View all ${config.title || model} records in a table.`,
        link: config.listPath || `/${model}s`,
      };
    });

  const extraTiles = Object.entries(customTiles)
    .filter(([, tile]) => tile.department?.includes(department) && canUseTile(tile, userRole))
    .map(([key, tile]) => ({ tileKey: key, ...tile }));

  // Dedupe by destination. A model-driven tile and a custom tile can point at the
  // same route (e.g. holidayRequest's list at /holidayrequests and a curated
  // /holidayRequests tile), which rendered the same entry twice on one page.
  // Links are normalised (lowercased, trailing slash stripped) because those two
  // differ only by case and Express routing is case-insensitive. Model tiles come
  // first, so on a collision the generic CRUD tile wins and the custom copy drops.
  const normaliseLink = (l) => String(l || "").replace(/\/+$/, "").toLowerCase();
  const seen = new Set();
  const tiles = [...standardModels, ...extraTiles].filter((tile) => {
    const key = normaliseLink(tile.link);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Decorate: icon, group, external flag, and best-effort count.
  const counts = await dashboardCountService.getCountsFor(
    tiles.map((t) => ({ tileKey: t.tileKey, model: t.model })),
  );
  for (const tile of tiles) {
    tile.icon = tile.icon || tileMeta.iconFor(tile.tileKey);
    tile.group = tileMeta.groupFor(department, tile.tileKey);
    tile.external = typeof tile.link === "string" && !tile.link.startsWith("/");
    const c = counts.get(tile.tileKey);
    if (c) tile.count = c;
  }
  return tiles;
};

// Helper: get all creatable models, filtered by role
const getCreateModels = (userRole) => {
  return Object.entries(listConfig)
    .filter(
      ([model, config]) =>
        !denyGuard(config, "c") &&
        // Same bug as getDashboardModels above. Currently masked because the
        // 'create' department is admin-only and admin short-circuits, but it
        // would open the moment that department is opened up.
        (userRole === "admin" || rbac.canAccess(userRole, model, "c").allowed),
    )
    .map(([model, config]) => {
      const title = config.title || model.charAt(0).toUpperCase() + model.slice(1);
      return {
        model,
        title,
        description: config.description?.create || `Create a new ${model}.`,
        link: config.createPath || `/${model}/create`,
        // These tiles link to a create form, not a list — the CTA must say so.
        cta: `New ${title}`,
        icon: "bi-plus-circle",
      };
    });
};

// Home / Index Page
export const renderIndex = async (req, res, next) => {
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
    });
  } catch (err) {
    next(err);
  }
};

// Quick-add task from home page
export const quickAddTask = async (req, res, next) => {
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
export const completeTask = async (req, res, next) => {
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

// Generic department dashboard renderer — one route per departmentsConfig
// entry is wired up in indexRoutes.js.
export const renderDepartment = (slug) => {
  const dept = departments[slug];
  return async (req, res, next) => {
    try {
      const userRole = req.user?.role || "subcontractor";
      const models =
        dept.special === "create"
          ? getCreateModels(userRole)
          : await getDashboardModels(slug, userRole);
      res.render(path.join("tailwindcss", "partials", "listModels"), {
        title: dept.title,
        models,
      });
    } catch (err) {
      next(err);
    }
  };
};

export default { renderIndex, quickAddTask, completeTask, renderDepartment };
