import logger from './loggerService.js';
const { sanitize } = logger;
import path from 'path';
import __maintenanceService from './maintenanceService.js';

function truncate(value, max = 180) {
  const text = String(value || "");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function getSafeRequestMeta(req) {
  const headers = req?.headers || {};
  return {
    method: req?.method || "-",
    url: req?.originalUrl || req?.url || "-",
    ip: req?.ip || req?.socket?.remoteAddress || "-",
    userAgent: truncate(headers["user-agent"] || "-"),
    host: headers.host || "-",
    xForwardedProto: headers["x-forwarded-proto"] || "-",
    xForwardedHost: headers["x-forwarded-host"] || "-",
    contentType: headers["content-type"] || "-",
    contentLength: headers["content-length"] || "-",
    origin: headers.origin || "-",
    referer: headers.referer || headers.referrer || "-",
  };
}

const errorHandlerService = (error, req, res, next) => {
  // Map transient infra errors (e.g., during Docker recreate) to 503 Service Unavailable
  const isTransientInfraError = (err) => {
    if (!err) return false;
    const code = err.code || "";
    const name = err.name || "";
    const msg = (err.message || "").toLowerCase();
    return (
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      name === "MongoNetworkError" ||
      name === "MongoServerSelectionError" ||
      msg.includes("pool is closed") ||
      msg.includes("failed to connect") ||
      msg.includes("connection timed out") ||
      msg.includes("socket hang up")
    );
  };

  // Determine the status code, title, and message
  const statusCode = isTransientInfraError(error)
    ? 503
    : error.statusCode || 500;
  const title = `${statusCode} - ${error.name || "Error"}`;
  const message = isTransientInfraError(error)
    ? "Service is temporarily unavailable while the system restarts. Please retry in a few seconds."
    : error.message || "Something went wrong.";
  const stack = error.stack;

  // Log the error details — 404s are external noise, not application errors
  const logFn = statusCode === 404 ? logger.warn.bind(logger) : logger.error.bind(logger);
  logFn(`[errorHandler] Error Details:
        Status: ${statusCode}
        Title: ${title}
        Message: ${message}
        Stack: ${stack ? stack.split("\n")[0] : "No stack trace"} 
        URL: ${sanitize(req.originalUrl)}
        Method: ${sanitize(req.method)}`);

  logger.info(
    `[errorHandler] Request Context: ${JSON.stringify(getSafeRequestMeta(req))}`,
  );

  // Render the error page
  res.status(statusCode);
  try {
    // ✅ Patch locals if missing
    res.locals.isAuthenticated ??= false;
    res.locals.isAdmin ??= false;
    res.locals.firstName ??= null;
    res.locals.successMessage ??= null;
    res.locals.errorMessage ??= null;
    res.locals.flash ??= {};
    res.locals.session ??= req.session || {};
    if (statusCode === 503) {
      // Render the maintenance page in place — preserves the requested URL
      // (auto-refresh recovers the user) and returns a true 503 with Retry-After
      return __maintenanceService.renderUnavailable(req, res, "unavailable");
    }
    res.render(path.join("tailwindcss", "error"), {
      title,
      error: {
        title,
        message,
        stack,
      },
    });
  } catch (renderError) {
    // Fallback if res.render fails
    logger.error("Error rendering error page: " + renderError.message);
    res.type("text/plain").send(`${title}: ${message}`);
  }
};

export default errorHandlerService;
