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
const configService = require('./services/configService');

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
  // ── Phase 1: Start HTTP server immediately ──────────────────────────
  // The server must accept connections ASAP so Docker health checks pass
  // and users see a friendly 503 maintenance page instead of Caddy's
  // "Internal Server Error" while MongoDB is still coming up.

  const app = express();
  const http = require('http');

  app.set('trust proxy', ['loopback', '127.0.0.1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']);
  app.set('view engine', 'ejs');
  app.set('views', [path.join(__dirname, 'mongoose/views')]);
  app.set('layout', path.join('tailwindcss', 'layout'));
  app.disable('x-powered-by');

  // Static assets (no DB required)
  app.use('/resources/css', express.static(path.join(__dirname, 'public', 'css')));
  app.get('/favicon.ico', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'images', 'favicon.ico'));
  });
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.sendFile(path.join(__dirname, 'public', 'robots.txt'));
  });

  // Health check (no DB required — reports actual readiness)
  app.get('/healthz', async (req, res) => {
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
        db: { REST: restReady, INTERNAL: internalReady, PAPERLESS: paperlessReady },
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // "I am stuck" — always shows the maintenance page (the upside-down heron)
  app.get('/i-am-stuck', (req, res) => {
    res.status(503);
    try {
      res.render(path.join('tailwindcss', 'maintenance'), {
        layout: false,
        title: 'I Am Stuck!',
        message: 'You asked to see me stuck. Here I am, upside down!',
      });
    } catch (e) {
      res.type('text/plain').send('503 - I am stuck!');
    }
  });

  // Early request blocklist for common scanner/probe paths
  app.use(require('./services/requestBlocklistService'));

  // ── First-run setup wizard ──────────────────────────────────────────────────
  // Only active when neither env vars nor app-config.json supply the minimum
  // required config (MONGO_URI/MONGO_HOST, SESSION_SECRET, ENCRYPTION_KEY).
  // Existing deployments with env vars set skip this entirely.
  if (!configService.isConfigured()) {
    logger.warn('[startup] Application is not configured — mounting setup wizard at /setup');
    const cookieParser = require('cookie-parser');
    const session = require('express-session');
    // Minimal in-memory session for wizard state (never persisted)
    app.use(cookieParser());
    app.use(session({
      secret: 'setup-wizard-temporary-secret',
      resave: false,
      saveUninitialized: true,
      cookie: { httpOnly: true, sameSite: 'lax' },
    }));
    app.use('/setup', require('./mongoose/routes/setupRoutes'));
    app.get('/', (req, res) => res.redirect('/setup'));
    app.use((req, res) => res.redirect('/setup'));
    // Start the HTTP server so the process stays alive to serve the wizard
    const server = http.createServer(app);
    const port = Number(process.env.PORT) || 3000;
    const host = process.env.HOST || '0.0.0.0';
    server.listen(port, host, () => {
      logger.info(`🚀 Setup wizard listening on ${host}:${port} — visit /setup to configure`);
    });
    // Do not proceed to Phase 2 — wizard completion restarts the process
    return;
  }

  // ── App router: empty until Phase 2 populates it ───────────────────
  // All real middleware and routes are mounted here once MongoDB is ready.
  // Before that, every request falls through to the maintenance guard below.
  const appRouter = express.Router();
  app.use(appRouter);

  // Maintenance/availability guard — catches all requests that fall through
  // the (initially empty) appRouter. Once Phase 2 mounts routes, only
  // requests that genuinely have no matching route will reach this, and
  // maintenanceService will pass them through to the 404 handler.
  app.use(require('./services/maintenanceService'));

  // Minimal error handler for the pre-DB phase
  app.use((err, req, res, _next) => {
    logger.error('[startup] Error before DB ready: ' + (err.message || err));
    return res.redirect(302, '/i-am-stuck');
  });

  // Start listening immediately
  const server = http.createServer(app);
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';

  server.listen(port, host, () => {
    logger.info(`🚀 Server listening on ${host}:${port} (waiting for MongoDB…)`);
  });

  // ── Phase 2: Connect to MongoDB and mount full app ──────────────────
  try {
    await mdb.connect();
    logger.info('[startup] MongoDB connected — mounting full application');

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

    // Bootstrap: create first admin from setup wizard credentials (app-config.json only)
    try {
      const bootstrap = configService.get('_bootstrapAdmin');
      if (bootstrap) {
        const parsed = typeof bootstrap === 'string' ? JSON.parse(bootstrap) : bootstrap;
        const existingCount = await mdb.INTERNAL.user.countDocuments();
        if (existingCount === 0 && parsed.username && parsed.password) {
          const bcrypt = require('bcrypt');
          const { v4: uuidv4 } = require('uuid');
          const hashedPassword = await bcrypt.hash(parsed.password, 10);
          await mdb.INTERNAL.user.create({
            uuid: uuidv4(),
            username: parsed.username,
            email: parsed.email || '',
            password: hashedPassword,
            role: 'admin',
            emailVerified: true,
          });
          logger.info(`[bootstrap] Created first admin user: ${parsed.username}`);
        }
        // Clear bootstrap credentials from the file regardless
        configService.remove(['_bootstrapAdmin']);
      }
    } catch (bootstrapErr) {
      logger.error('[bootstrap] Failed to create admin user: ' + bootstrapErr.message);
    }

    // Load CIS nominal code mappings from the database
    try {
      const cisMappings = require('./mongoose/config/cisMappings');
      await cisMappings.loadFromDb(mdb.REST.nominal);
      logger.info(`[cis] Loaded nominal codes — materials: [${cisMappings.materialsNominalCodes}], labour: [${cisMappings.labourNominalCodes}], cisDeduction: [${cisMappings.cisDeductionNominalCodes}]`);
    } catch (cisErr) {
      logger.error('[cis] Failed to load nominal codes from DB, using defaults', { error: cisErr.message });
    }

    const { initSocket } = require('./services/socketService');

    // Session store (requires INTERNAL connection)
    const internalClient = mdb.INTERNAL.connection.client;
    const createSessionService = require('./mongoose/services/sessionService');
    const sessionService = createSessionService(internalClient);

    // Mount the full middleware + routes into appRouter
    appRouter.use(expressLayouts);
    appRouter.use(express.json());
    appRouter.use(express.urlencoded({ extended: true }));
    appRouter.use(cookieParser());
    appRouter.use(sessionService);
    appRouter.use(require('./services/csrfService'));

    // Protected static assets
    appRouter.use('/resources', authService.ensureAuthenticated, express.static(path.join(__dirname, 'public')));

    // Core middleware
    appRouter.use(useragent.express());
    appRouter.use(require('./services/securityService'));
    appRouter.use(require('./services/flashService'));
    appRouter.use(authService.ensureAuthenticated);
    appRouter.use(authService.ensureRouteAccess);
    appRouter.use(require('./services/logRequestDetailsService'));
    appRouter.use(require('./services/rateLimiterService'));
    // Maintenance/availability guard (friendly 503 when backing services restart mid-operation)
    appRouter.use(require('./services/maintenanceService'));
    // Session activity tracking (after auth)
    appRouter.use(require('./mongoose/services/sessionActivityService').touchSessionActivity);
    appRouter.use(require('./mongoose/services/sessionActivityService').trackPageVisit);

    // Admin-only debug route to inspect forwarded headers and connection security
    appRouter.get('/__debug/headers', require('./services/authService').ensureRole('admin'), (req, res) => {
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
    appRouter.use((req, res, next) => {
      res.locals.isAuthenticated = !!req.user;
      res.locals.role = req.user && req.user.role || null;
      res.locals.isAdmin = req.user && req.user.role === 'admin';

      // RBAC: expose departments the user's role can access
      const _customPerms = req.user?.customPermissions || {};
      res.locals.userDepartments = req.user
        ? rbac.getDepartmentsForRole(req.user.role, _customPerms)
        : [];
      // Helper: check if user can access a department (usable in templates)
      res.locals.canDept = (dept) => req.user ? rbac.canAccessDepartment(req.user.role, dept, _customPerms) : false;
      // Helper: check CRUD access on a model
      res.locals.canModel = (model, op) => req.user ? rbac.canAccess(req.user.role, model, op, _customPerms).allowed : false;
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
      res.locals.contactEmail = configService.get('SUPPORTEMAIL');
      res.locals.companyName = configService.get('COMPANY_NAME', '');
      res.locals.lastfetched = null;
      res.locals.session = null;
      res.locals.copyrightyearstart = configService.get('INCORPORATION_YEAR');
      res.locals.copyrightyear = new Date().getFullYear();
      next();
    });

    // App-wide meta info (Mongo)
    appRouter.use(async (req, res, next) => {
      try {
        res.locals.lastfetched = await mdb.INTERNAL.meta.findOne().sort({ lastFetchedAt: -1 }) || null;
      } catch (err) {
        logger.error('Error fetching meta: ' + err.message);
      }
      next();
    });

    // Cache control
    appRouter.use((req, res, next) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      next();
    });

    // Holiday block page
    const holidayController = require('./mongoose/controllers/holidayController')
    appRouter.use(holidayController.checkHoliday);

    // Encryption key dev hint
    if (process.env.NODE_ENV === 'development' && !process.env.ENCRYPTION_KEY) {
      const newKey = crypto.randomBytes(32).toString('hex');
      const hex = Buffer.from(newKey, 'hex');
      logger.info('Generated ENCRYPTION_KEY (hex): ' + hex.toString('hex'));
    }

    appRouter.use('/', require('./mongoose/routes/userRoutes'));
    // Routes
    appRouter.use('/', require('./mongoose/routes/attendanceRoutes'));
    appRouter.use('/', require('./mongoose/routes/cisRoutes'));
    appRouter.use('/', require('./mongoose/routes/CRUDRoutes'));
    appRouter.use('/', require('./mongoose/routes/indexRoutes'));
    appRouter.use('/', require('./mongoose/routes/listRoutes'));
    appRouter.use('/', require('./mongoose/routes/adminRoutes'));
    appRouter.use('/', require('./mongoose/routes/loggerRoutes'));
    appRouter.use('/', require('./mongoose/routes/returnsRoutes'));
    appRouter.use('/', require('./mongoose/routes/settingsRoutes'));
    appRouter.use('/', require('./mongoose/routes/twoFARoutes'));
    appRouter.use('/', require('./mongoose/routes/subcontractorRoutes'));
    appRouter.use('/', require('./mongoose/routes/submissionRoutes'));
    appRouter.use('/', require('./mongoose/routes/holidayRoutes'));
    appRouter.use('/', require('./mongoose/routes/fileRoutes'));
    appRouter.use('/', require('./mongoose/routes/paperlessRoutes'));
    appRouter.use('/', require('./mongoose/routes/overviewRoutes'));
    appRouter.use('/', require('./mongoose/routes/ssoRoutes'));
    appRouter.use('/', require('./mongoose/routes/helpRoutes'));
    appRouter.use('/', require('./mongoose/routes/payrollRoutes'));

    // Catch-all 404
    appRouter.use((req, res, next) => {
      const error = new Error(`Route not found: ${req.method} ${req.originalUrl}`);
      error.statusCode = 404;
      next(error);
    });

    // Global error handler
    appRouter.use(require('./services/errorHandlerService'));

    // WebSocket
    const io = initSocket(server);
    const { setupWebSocket } = require('./mongoose/services/webSocketService');
    setupWebSocket(io, sessionService);

    // Start periodic background services
    try { require('./mongoose/services/sessionCleanupService').start(); } catch (e) { logger.warn('Session cleanup start failed: ' + e.message); }
    try { require('./mongoose/services/vehicleComplianceService').start(); } catch (e) { logger.warn('Vehicle compliance service start failed: ' + e.message); }
    try { require('./mongoose/services/ocrOrphanService').start(); } catch (e) { logger.warn('OCR orphan service start failed: ' + e.message); }

    logger.info(`🚀 Application fully ready in ${process.env.NODE_ENV} on ${host}:${port}`);

  } catch (err) {
    logger.error('❌ Failed to connect to MongoDB: ' + err.message);
    logger.error('   Server remains running — showing maintenance page to all requests');
    // Server keeps running; maintenanceService will show 503 for every request
    // because mdb connections remain in non-ready state.
  }
};

main();