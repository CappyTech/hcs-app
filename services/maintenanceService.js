import logger from './loggerService.js';
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import configService from './configService.js';
import path from 'path';

/**
 * Maintenance/availability middleware.
 * - If MAINTENANCE=true, respond 503 with the maintenance page (admins bypass).
 * - If any Mongo connection is unavailable, respond 503 to reduce noisy 500s
 *   while containers start or restart.
 * - Responses are rendered in place (no redirect) so the requested URL is
 *   preserved and the page auto-refreshes back into the app once it recovers.
 * - Sends Retry-After and a JSON body for API/XHR clients.
 */

const REASONS = {
  maintenance: {
    retryAfter: 60,
    title: "Scheduled Maintenance",
    heading: "Scheduled maintenance in progress",
    message:
      "We are carrying out planned maintenance. The application will be back online shortly.",
  },
  starting: {
    retryAfter: 10,
    title: "Service Starting",
    heading: "The application is starting",
    message:
      "The service is initialising and will be available in a few moments.",
  },
  unavailable: {
    retryAfter: 10,
    title: "Service Unavailable",
    heading: "Service temporarily unavailable",
    message:
      "We are experiencing a temporary issue. This usually resolves within a few seconds.",
  },
};

// Paths that must always pass through (probes, static assets, the page itself)
const PASS_PATHS = ["/healthz", "/service-unavailable", "/i-am-stuck", "/favicon.ico", "/robots.txt"];
const PASS_PREFIXES = ["/resources/"];

// Throttle the "DB unavailable" warning so a restart doesn't flood the logs
let lastDownWarnAt = 0;
const DOWN_WARN_INTERVAL_MS = 30000;

function wantsJson(req) {
  if (req.xhr) return true;
  if ((req.path || "").startsWith("/api/")) return true;
  // Browsers send Accept: text/html...; API clients typically application/json
  return req.accepts(["html", "json"]) === "json";
}

function dbState() {
  // Connections are created on mdb.connect(); absent connections mean the
  // app is still in its startup phase rather than having lost the database.
  const conns = [mdb.REST, mdb.INTERNAL, mdb.PAPERLESS];
  if (conns.some((c) => !c || !c.connection)) return "starting";
  const allReady = conns.every((c) => c.connection.readyState === 1);
  return allReady ? "ready" : "unavailable";
}

/**
 * Render the 503 service-unavailable response in place.
 * Usable as a route handler or called directly from error handlers.
 */
function renderUnavailable(req, res, reasonKey = "unavailable") {
  const reason = REASONS[reasonKey] || REASONS.unavailable;
  res.status(503);
  res.set("Retry-After", String(reason.retryAfter));
  res.set("Cache-Control", "no-store");

  if (wantsJson(req)) {
    return res.json({
      ok: false,
      error: "service_unavailable",
      reason: reasonKey,
      message: reason.message,
      retryAfter: reason.retryAfter,
    });
  }

  return res.render(
    path.join("tailwindcss", "maintenance"),
    {
      layout: false,
      title: reason.title,
      heading: reason.heading,
      message: reason.message,
      refreshSeconds: reason.retryAfter,
    },
    (err, html) => {
      if (err) {
        logger.error("[maintenance] Failed to render maintenance page: " + err.message);
        return res.type("text/plain").send("503 Service Unavailable — " + reason.message);
      }
      res.send(html);
    }
  );
}

/** Planned-maintenance flag — runtime-toggleable via /admin/maintenance. */
function isMaintenanceOn() {
  return String(configService.get("MAINTENANCE", "false")) === "true";
}

/** Current availability reason, or null when the app is fully available. */
function currentReason() {
  if (isMaintenanceOn()) return "maintenance";
  const state = dbState();
  return state === "ready" ? null : state;
}

function maintenanceService(req, res, next) {
  try {
    const p = req.path || "";
    if (PASS_PATHS.includes(p) || PASS_PREFIXES.some((pre) => p.startsWith(pre))) {
      return next();
    }

    // Planned maintenance (env var or runtime toggle) — admins may continue working
    if (isMaintenanceOn()) {
      if (req.user && req.user.role === "admin") return next();
      return renderUnavailable(req, res, "maintenance");
    }

    // Availability: if any required DB is down, show the unavailable page
    const state = dbState();
    if (state !== "ready") {
      const now = Date.now();
      if (now - lastDownWarnAt > DOWN_WARN_INTERVAL_MS) {
        lastDownWarnAt = now;
        logger.warn("[maintenance] One or more DB connections unavailable", {
          state,
          restReady: mdb.REST?.connection?.readyState === 1,
          internalReady: mdb.INTERNAL?.connection?.readyState === 1,
          paperlessReady: mdb.PAPERLESS?.connection?.readyState === 1,
        });
      }
      return renderUnavailable(req, res, state);
    }

    return next();
  } catch (err) {
    // If the maintenance check itself fails, be permissive and let the request
    // continue; the error handler will catch problems downstream
    logger.warn("[maintenance] check error: " + err.message);
    return next();
  }
};

// CJS attached these as properties of the middleware; keep that shape for
// consumers that access them via the default export (e.g. app.js).
maintenanceService.renderUnavailable = renderUnavailable;
maintenanceService.currentReason = currentReason;
maintenanceService.isMaintenanceOn = isMaintenanceOn;

export default maintenanceService;
export { renderUnavailable };
export { currentReason };
export { isMaintenanceOn };
