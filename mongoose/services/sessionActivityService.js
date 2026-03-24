const mdb = require('./mongooseDatabaseService');
const logger = require('../../services/loggerService');

const listConfig = require('../config/listControllerConfig');

// Pages to skip when tracking visit history
const SKIP_PREFIXES = ['/resources/', '/favicon.', '/healthz', '/i-am-stuck', '/__debug'];
const MAX_FREQUENT_PAGES = 10;

// Map a path to a human-readable label
function labelForPath(p) {
  // Department dashboards
  const deptLabels = {
    '/admin': 'Admin', '/attendance': 'Attendance', '/management': 'Management',
    '/maintenance': 'Maintenance', '/payroll': 'Payroll', '/human-resources': 'Human Resources',
    '/kashflow': 'KashFlow', '/paperless': 'Documents', '/finance': 'Finance',
    '/construction-industry-scheme': 'CIS', '/create': 'Create', '/user': 'User',
  };
  if (deptLabels[p]) return deptLabels[p];

  // List pages: /customers → "Customers"
  const listMatch = p.match(/^\/(\w+)s$/);
  if (listMatch) {
    const model = listMatch[1];
    const cfg = listConfig[model];
    if (cfg) return cfg.title || model.charAt(0).toUpperCase() + model.slice(1) + 's';
  }

  // CRUD read/update: /customer/read/<uuid> → "Customer Detail"
  const crudMatch = p.match(/^\/(\w+)\/(read|update)\/[\w-]+$/);
  if (crudMatch) {
    const model = crudMatch[1];
    const cfg = listConfig[model];
    const name = cfg?.title || model.charAt(0).toUpperCase() + model.slice(1);
    return `${name} Detail`;
  }

  // Create form: /customer/create → "Create Customer"
  const createMatch = p.match(/^\/(\w+)\/create$/);
  if (createMatch) {
    const model = createMatch[1];
    const cfg = listConfig[model];
    const name = cfg?.title || model.charAt(0).toUpperCase() + model.slice(1);
    return `Create ${name}`;
  }

  // CIS routes
  if (p.startsWith('/CIS')) return 'CIS Dashboard';

  return p;
}

// Middleware: track page visits in session for "frequently visited" feature
module.exports.trackPageVisit = function trackPageVisit(req, res, next) {
  if (req.method !== 'GET' || !req.session?.user) return next();
  const p = req.path || '';
  if (SKIP_PREFIXES.some(pre => p.startsWith(pre))) return next();
  // Only track meaningful page routes (not API/POST endpoints)
  if (p === '/') return next(); // home page is always accessible, no need to track

  if (!req.session._pageVisits) req.session._pageVisits = {};
  const visits = req.session._pageVisits;
  visits[p] = (visits[p] || 0) + 1;

  next();
};

// Get the top N most-visited pages for a session, with labels
module.exports.getFrequentPages = function getFrequentPages(session, limit = MAX_FREQUENT_PAGES) {
  const visits = session?._pageVisits || {};
  return Object.entries(visits)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([path, count]) => ({ path, label: labelForPath(path), count }));
};

// Middleware: update lastActivity for current session (throttled)
module.exports.touchSessionActivity = async function touchSessionActivity(req, res, next) {
  if (!req.sessionID || !req.session?.user) return next();
  try {
    const now = new Date();
    // Only update if >60s since last update to reduce writes
    if (!req.session._lastActivityTouch || (now - req.session._lastActivityTouch) > 60000) {
      req.session._lastActivityTouch = now;
  mdb.INTERNAL.session.updateOne({ _id: req.sessionID }, { $set: { lastActivity: now } }).catch(()=>{});
    }
  } catch (e) {
    logger.warn('Session activity touch failed: ' + e.message);
  } finally {
    next();
  }
};
