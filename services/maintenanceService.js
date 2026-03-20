const path = require("path");
const logger = require("./loggerService");
const mdb = require("../mongoose/services/mongooseDatabaseService");

/**
 * Maintenance/availability middleware.
 * - If MAINTENANCE=true, respond 503 with a friendly page.
 * - If any Mongo connections are disconnected, respond 503 to reduce noisy 500s while containers restart.
 * - Skip healthz endpoint; allow it to report status to the orchestrator.
 */
module.exports = async function maintenanceService(req, res, next) {
  try {
    // Allow health probes and static assets through
    const p = req.path || "";
    if (
      p === "/healthz" ||
      p === "/favicon.ico" ||
      p.startsWith("/resources/") ||
      p.startsWith("/robots.txt")
    )
      return next();

    // Explicit maintenance flag via env
    if (process.env.MAINTENANCE === "true") {
      return renderMaintenance(res);
    }

    // Check Mongo connections; if any required DB is down, show maintenance
    const restReady = mdb.REST?.connection?.readyState === 1;
    const internalReady = mdb.INTERNAL?.connection?.readyState === 1;
    const paperlessReady = mdb.PAPERLESS?.connection?.readyState === 1;

    const ok = restReady && internalReady && paperlessReady;
    if (!ok) {
      logger.warn("[maintenance] One or more DB connections unavailable", {
        restReady,
        internalReady,
        paperlessReady,
      });
      return renderMaintenance(res);
    }

    return next();
  } catch (err) {
    // If the maintenance check itself fails, be permissive and let request continue; error handler will catch downstream
    logger.warn("[maintenance] check error: " + err.message);
    return next();
  }
};

function renderMaintenance(res) {
  // Ensure locals minimal defaults
  res.locals.isAuthenticated ??= false;
  res.locals.isAdmin ??= false;
  res.locals.firstName ??= null;
  res.locals.successMessage ??= null;
  res.locals.errorMessage ??= null;
  res.locals.flash ??= {};
  res.locals.session ??= {};
  res.status(503);
  try {
    res.render(path.join("tailwindcss", "maintenance"), {
      title: "Service Unavailable",
      message: "The service is restarting. Please retry in a few seconds.",
    });
  } catch (e) {
    res
      .type("text/plain")
      .send(
        "503 - Service Unavailable: The service is restarting. Please retry in a few seconds.",
      );
  }
}
