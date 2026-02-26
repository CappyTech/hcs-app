'use strict';

require('dotenv').config();
const express = require('express');
const path = require('path');
const expressLayouts = require('express-ejs-layouts');
const useragent = require('express-useragent');
const cookieParser = require('cookie-parser');
const logger = require('./services/loggerService');
const packageJson = require('./package.json');
const crypto = require('crypto');
const authService = require('./services/authService')

const mdb = require('./mongoose/services/mongooseDatabaseService');

// Process-level diagnostics for transient and unexpected errors
process.on('unhandledRejection', (reason, promise) => {
  try {
    logger.error('[process] Unhandled Promise Rejection', {
      reason: (reason && reason.message) || String(reason),
      stack: reason && reason.stack ? reason.stack.split('\n')[0] : undefined
    });
  } catch (_) {}
});
process.on('uncaughtException', (err) => {
  try {
    logger.error('[process] Uncaught Exception', {
      message: err && err.message,
      stack: err && err.stack ? err.stack.split('\n')[0] : undefined
    });
  } catch (_) {}
});

const main = async () => {
  try {
    await mdb.connect(); // Wait for MongoDB/SSH tunnel

    // One-time migration: mark existing users (without a verification token) as email-verified
    try {
      const result = await mdb.INTERNAL.user.updateMany(
        { emailVerified: { $ne: true }, emailVerificationToken: { $eq: null } },
        { $set: { emailVerified: true } }
      );
      if (result.modifiedCount > 0) {
        logger.info(`[migration] Marked ${result.modifiedCount} existing user(s) as email-verified`);
      }
    } catch (migrationErr) {
      logger.error('[migration] Email verification backfill failed', { error: migrationErr.message });
    }

    const app = express();
    const http = require('http');
    const { initSocket } = require('./services/socketService');

    // Get INTERNAL connection's client for session store
    const internalClient = mdb.INTERNAL.connection.client;
    const createSessionService = require('./mongoose/services/sessionServiceMongoose');
    const sessionService = createSessionService(internalClient);

    // Behind Caddy → FRP (multiple proxy hops): trust loopback and private IPv4 ranges
    // This enables req.secure from X-Forwarded-Proto without permissive trust
    app.set('trust proxy', ['loopback', '127.0.0.1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']);
    app.set('view engine', 'ejs');
    app.set('views', [
      path.join(__dirname, 'mongoose/views')
    ]);
    app.set('layout', path.join('tailwindcss', 'layout'));
    app.use(expressLayouts);
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // Cookie parser and session handling
    app.use(cookieParser());
    app.use(sessionService);
    // CSRF protection (transitional mode). Set STRICT_MODE=true to enforce rejection.
    app.use(require('./services/csrfService'));

    // Static assets
    // Serve compiled Tailwind CSS publicly so the login page can load styles unauthenticated
    app.use('/resources/css', express.static(path.join(__dirname, 'public', 'css')));
    // Other static assets remain protected
    app.use('/resources', authService.ensureAuthenticated, express.static(path.join(__dirname, 'public')));
    ['bootstrap-icons'].forEach(pkg => {
      app.use(`/resources/${pkg}`, authService.ensureAuthenticated, express.static(path.join(__dirname, `node_modules/${pkg}`)));
    });

    // Serve favicon to avoid 404 errors
    app.get('/favicon.ico', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'images', 'favicon.ico'));
    });

    // Serve robots.txt (unauthenticated)
    app.get('/robots.txt', (req, res) => {
      res.type('text/plain');
      res.sendFile(path.join(__dirname, 'public', 'robots.txt'));
    });

    // Early request blocklist for common scanner/probe paths
    app.use(require('./services/requestBlocklistService'));

    // Health check endpoint (unauthenticated, local-only)
    app.get('/healthz', async (req, res) => {
      // Restrict to local connections only (bypass trust proxy)
      const ra = (req.socket && req.socket.remoteAddress) || '';
      const isLocal = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1' || ra.startsWith('127.');
      if (!isLocal) {
        return res.status(403).json({ ok: false, error: 'forbidden' });
      }
      try {
        const restReady = mdb.REST?.connection?.readyState === 1;
        const internalReady = mdb.INTERNAL?.connection?.readyState === 1;
        const paperlessReady = mdb.PAPERLESS?.connection?.readyState === 1;
        const ok = restReady && internalReady && paperlessReady;
        res.status(ok ? 200 : 503).json({
          ok,
          uptime: process.uptime(),
          db: {
            REST: restReady,
            INTERNAL: internalReady,
            PAPERLESS: paperlessReady
          }
        });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    // Core middleware
    app.use(useragent.express());
    app.use(require('./services/securityService'));
    app.use(require('./services/flashService'));
    app.use(authService.ensureAuthenticated);
    app.use(require('./services/logRequestDetailsService'));
    app.use(require('./services/rateLimiterService'));
  // Maintenance/availability guard (friendly 503 when backing services are restarting)
  app.use(require('./services/maintenanceService'));
    // Session activity tracking (after auth)
    app.use(require('./mongoose/services/sessionActivityService').touchSessionActivity);

    // Admin-only debug route to inspect forwarded headers and connection security
    app.get('/__debug/headers', require('./services/authService').ensureRole('admin'), (req, res) => {
      const { getClientIp } = require('./services/ipService');
      res.json({
        secure: req.secure,
        protocol: req.protocol,
        ip: req.ip,
        clientIp: getClientIp(req),
        ips: req.ips,
        headers: {
          host: req.headers['host'],
          'x-forwarded-for': req.headers['x-forwarded-for'] || null,
          'x-forwarded-proto': req.headers['x-forwarded-proto'] || null,
          'x-forwarded-host': req.headers['x-forwarded-host'] || null,
          'x-real-ip': req.headers['x-real-ip'] || null,
          'cf-connecting-ip': req.headers['cf-connecting-ip'] || null,
          'x-csrf-token': req.headers['x-csrf-token'] || null,
          'x-xsrf-token': req.headers['x-xsrf-token'] || null,
        },
      });
    });

    // Attach user info to templates
    const rbac = require('./mongoose/config/rolePermissionsConfig');
    app.use((req, res, next) => {
      const successFlash = req.flash('success');
      const errorFlash = req.flash('error');

      res.locals.successMessage = successFlash.length > 0 ? successFlash : null;
      res.locals.errorMessage = errorFlash.length > 0 ? errorFlash : null;
      res.locals.isAuthenticated = !!req.user;
      res.locals.role = req.user && req.user.role || null;
      res.locals.isAdmin = req.user && req.user.role === 'admin';

      // RBAC: expose departments the user's role can access
      res.locals.userDepartments = req.user
        ? rbac.getDepartmentsForRole(req.user.role)
        : [];
      // Helper: check if user can access a department (usable in templates)
      res.locals.canDept = (dept) => req.user ? rbac.canAccessDepartment(req.user.role, dept) : false;
      // Helper: check CRUD access on a model
      res.locals.canModel = (model, op) => req.user ? rbac.canAccess(req.user.role, model, op).allowed : false;
      // Expose role flags for template convenience
      res.locals.isEmployee = req.user && req.user.role === 'employee';
      res.locals.isSubcontractor = req.user && req.user.role === 'subcontractor';
      res.locals.isAccountant = req.user && req.user.role === 'accountant';
      res.locals.isClient = req.user && req.user.role === 'client';
      res.locals.emailVerified = req.user ? req.user.emailVerified : false;

      res.locals.firstName = req.user && req.user.username
        ? req.user.username.split('.')[0].replace(/^\w/, c => c.toUpperCase())
        : null;
      res.locals.package = packageJson.version;
      res.locals.slimDateTime = require('./services/dateService').slimDateTime;
      res.locals.formatCurrency = require('./services/currencyService').formatCurrency;
      res.locals.rounding = require('./services/currencyService').rounding;
      if (!res.locals.csrfToken && req.session?.csrfToken) {
        res.locals.csrfToken = req.session.csrfToken;
      }
      res.locals.contactEmail = process.env.SUPPORTEMAIL;
      res.locals.lastfetched = null;
      res.locals.session = null;
      res.locals.copyrightyearstart = process.env.INCORPORATION_YEAR;
      res.locals.copyrightyear = new Date().getFullYear();
      next();
    });

    // App-wide meta info (Mongo)
    app.use(async (req, res, next) => {
      try {
        res.locals.lastfetched = await mdb.INTERNAL.meta.findOne().sort({ lastFetchedAt: -1 }) || null;
      } catch (err) {
        logger.error('Error fetching meta: ' + err.message);
      }
      next();
    });

    // Cache control
    app.disable('x-powered-by');
    app.use((req, res, next) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      next();
    });

    // Holiday block page
    const holidayController = require('./mongoose/controllers/holidayController')
    app.use(holidayController.checkHoliday);

    // Encryption key dev hint
    if (process.env.NODE_ENV === 'development' && !process.env.ENCRYPTION_KEY) {
      const newKey = crypto.randomBytes(32).toString('hex');
      const hex = Buffer.from(newKey, 'hex');
      console.log('Generated ENCRYPTION_KEY (hex):', hex);
    }

    //app.use(require ('./mongoose/services/uuidCheckServiceMongoose').ensureUUIDs);

    app.use('/', require('./mongoose/routes/userRoutes'));
    // Routes
    app.use('/', require('./mongoose/routes/attendanceRoutes'));
    app.use('/', require('./mongoose/routes/cisRoutes'));
    app.use('/', require('./mongoose/routes/CRUDRoutes'));
    app.use('/', require('./mongoose/routes/indexRoutes'));
    app.use('/', require('./mongoose/routes/listRoutes'));
    app.use('/', require('./mongoose/routes/loggerRoutes'));
    app.use('/', require('./mongoose/routes/returnsRoutes'));
    app.use('/', require('./mongoose/routes/settingsRoutes'));
    app.use('/', require('./mongoose/routes/twoFARoutes'));
    app.use('/', require('./mongoose/routes/subcontractorRoutes'));
    app.use('/', require('./mongoose/routes/submissionRoutes'));
    app.use('/', require('./mongoose/routes/holidayRoutes'));
    app.use('/', require('./mongoose/routes/fileRoutes'));
    app.use('/', require('./mongoose/routes/paperlessRoutes'));
    app.use('/', require('./mongoose/routes/fleetRoutes'));
    app.use('/', require('./mongoose/routes/ssoRoutes'));

    // Catch-all 404
    app.use((req, res, next) => {
      const error = new Error(`Route not found: ${req.method} ${req.originalUrl}`);
      error.statusCode = 404;
      next(error);
    });

    // Global error handler
    app.use(require('./services/errorHandlerService'));

    // Create HTTP server from Express app
    const server = http.createServer(app);

    // Choose port/host (container-friendly defaults)
    const port = Number(process.env.PORT) || 3000;
    const host = process.env.HOST || '0.0.0.0';

    // Start server
    server.listen(port, host, () => {
      logger.info(`🚀 Server running in ${process.env.NODE_ENV} on ${host}:${port}`);
    });

    const io = initSocket(server);

    // Setup WebSocket with working sessionService
    const { setupWebSocket } = require('./mongoose/services/webSocketServiceMongoose');
    setupWebSocket(io, sessionService);

    // Start periodic session cleanup
    try { require('./mongoose/services/sessionCleanupService').start(); } catch (e) { logger.warn('Session cleanup start failed: ' + e.message); }

    // Start periodic vehicle compliance checks (MOT, insurance, road tax)
    try { require('./mongoose/services/vehicleComplianceService').start(); } catch (e) { logger.warn('Vehicle compliance service start failed: ' + e.message); }

  } catch (err) {
    logger.error('❌ Failed to start application: ' + err + err.stack);
  }
};

main();