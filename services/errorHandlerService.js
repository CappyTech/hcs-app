const logger = require("./loggerService");
const path = require("path");

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

  // Log the error details
  logger.error(`Error Details:
        Status: ${statusCode}
        Title: ${title}
        Message: ${message}
        Stack: ${stack ? stack.split("\n")[0] : "No stack trace"} 
        URL: ${req.originalUrl}
        Method: ${req.method}`);

  logger.info(`Request Headers: ${JSON.stringify(req.headers, null, 2)}`);

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
      // Use branded maintenance page for service unavailability
      return res.render(path.join("tailwindcss", "maintenance"), {
        title: "Service Unavailable",
        message,
      });
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

module.exports = errorHandlerService;
