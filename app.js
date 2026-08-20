__dotenv.config();
// Apply any values saved via the connections settings UI (app-config.json) for
// keys not already set by the OS / docker-compose environment.
__configService.bootstrap();
import express from 'express';
import path from 'path';
import expressLayouts from 'express-ejs-layouts';
import useragent from 'express-useragent';
import cookieParser from 'cookie-parser';
import logger from './services/loggerService.js';
import crypto from 'crypto';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Build/commit identity. In Docker the short SHA is baked in via the GIT_COMMIT
// build arg (see Dockerfile); in local dev we fall back to reading git directly.
// Computed once at startup — never per request.
const gitCommit = (process.env.GIT_COMMIT || (() => {
  try {
    return __child_process
      .execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch (_) { return ''; }
})()).trim() || null;
const gitRepoUrl = (process.env.GIT_REPO_URL || 'https://github.com/CappyTech/hcs-app').replace(/\/+$/, '');
import authService from './services/authService.js';

import mdb from './mongoose/services/mongooseDatabaseService.js';
import configService from './services/configService.js';
import __dotenv from 'dotenv';
import __configService from './services/configService.js';
import __child_process from 'child_process';
import http from 'http';
import maintenance from './services/maintenanceService.js';
import __devDbRoutes from './mongoose/routes/devDbRoutes.js';
import __requestBlocklistService from './services/requestBlocklistService.js';
import __cookie_parser from 'cookie-parser';
import session from 'express-session';
import __setupRoutes from './mongoose/routes/setupRoutes.js';
import bcrypt from 'bcrypt';
import __payrollTaxRatesSeedService from './mongoose/services/payrollTaxRatesSeedService.js';
import __emailTypesSeedService from './mongoose/services/emailTypesSeedService.js';
import __configValidatorService from './mongoose/services/configValidatorService.js';
import cisMappings from './mongoose/config/cisMappings.js';
import __socketService from './services/socketService.js';
import createSessionService from './mongoose/services/sessionService.js';
import __csrfService from './services/csrfService.js';
import __securityService, { trustEdgeTls } from './services/securityService.js';
import __flashService from './services/flashService.js';
import __passwordResetDraft from './services/passwordResetDraft.js';
import __auditContextService from './mongoose/services/auditContextService.js';
import __logRequestDetailsService from './services/logRequestDetailsService.js';
import __rateLimiterService from './services/rateLimiterService.js';
import __sessionActivityService from './mongoose/services/sessionActivityService.js';
import __authService from './services/authService.js';
import __ipService from './services/ipService.js';
import rbac from './mongoose/config/rolePermissionsConfig.js';
import departmentsConfig from './mongoose/config/departmentsConfig.js';
import __dateService from './services/dateService.js';
import __currencyService from './services/currencyService.js';
import holidayController from './mongoose/controllers/holidayController.js';
import __userRoutes from './mongoose/routes/userRoutes.js';
import __attendanceRoutes from './mongoose/routes/attendanceRoutes.js';
import __cisRoutes from './mongoose/routes/cisRoutes.js';
import __indexRoutes from './mongoose/routes/indexRoutes.js';
import __adminRoutes from './mongoose/routes/adminRoutes.js';
import __loggerRoutes from './mongoose/routes/loggerRoutes.js';
import __returnsRoutes from './mongoose/routes/returnsRoutes.js';
import __settingsRoutes from './mongoose/routes/settingsRoutes.js';
import __emailRoutes from './mongoose/routes/emailRoutes.js';
import __twoFARoutes from './mongoose/routes/twoFARoutes.js';
import __subcontractorRoutes from './mongoose/routes/subcontractorRoutes.js';
import __submissionRoutes from './mongoose/routes/submissionRoutes.js';
import __holidayRoutes from './mongoose/routes/holidayRoutes.js';
import __fileRoutes from './mongoose/routes/fileRoutes.js';
import __paperlessTags from './mongoose/config/paperlessTagsConfig.js';
import __paperlessRoutes from './mongoose/routes/paperlessRoutes.js';
import __bankRoutes from './mongoose/routes/bankRoutes.js';
import __accountantRoutes from './mongoose/routes/accountantRoutes.js';
import __overviewRoutes from './mongoose/routes/overviewRoutes.js';
import __ssoRoutes from './mongoose/routes/ssoRoutes.js';
import __helpRoutes from './mongoose/routes/helpRoutes.js';
import __payrollRoutes from './mongoose/routes/payrollRoutes.js';
import __gdprRoutes from './mongoose/routes/gdprRoutes.js';
import __legalRoutes from './mongoose/routes/legalRoutes.js';
import __companyDocsRoutes from './mongoose/routes/companyDocsRoutes.js';
import __auditRoutes from './mongoose/routes/auditRoutes.js';
import __webRoutes from './mongoose/routes/webRoutes.js';
import __webApiRoutes from './mongoose/routes/webApiRoutes.js';
import __errorHandlerService from './services/errorHandlerService.js';
import __webSocketService from './mongoose/services/webSocketService.js';
import __jobRegistry from './mongoose/services/jobRegistry.js';
import { fileURLToPath } from 'node:url';
import { dirname as _esmDirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = _esmDirname(__filename);

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

  // Behind reverse proxies (Caddy/FRP): trust loopback and the Docker bridge
  // range only. Trusting the full private-IP space would let any LAN host spoof
  // X-Forwarded-For (defeating IP-keyed rate limiting). Override with
  // TRUST_PROXY (comma-separated list) if your proxy sits on another range.
  const trustProxy = (process.env.TRUST_PROXY || 'loopback,172.16.0.0/12')
    .split(',').map((s) => s.trim()).filter(Boolean);
  app.set('trust proxy', trustProxy);

  // TLS terminates at the edge, which forwards over plain HTTP and stamps
  // X-Forwarded-Proto: http. With TRUST_EDGE_TLS=true this restores req.secure
  // so the session and CSRF cookies are sent with the Secure attribute. It must
  // run before the session middleware, which reads the scheme when it decides
  // whether to set the cookie at all.
  app.use(trustEdgeTls);
  app.set('view engine', 'ejs');
  app.set('views', [path.join(__dirname, 'mongoose/views')]);
  app.set('layout', path.join('tailwindcss', 'layout'));
  app.disable('x-powered-by');

  // Static assets (no DB required)
  app.use('/resources/css', express.static(path.join(__dirname, 'public', 'css')));
  // Branding images and vendored browser libraries must be public: they are needed by
  // the login and setup pages, and the manifest icons are fetched by the browser while
  // the user is logged out (which is exactly when installability is evaluated).
  app.use('/resources/images', express.static(path.join(__dirname, 'public', 'images')));
  app.use('/resources/vendor', express.static(path.join(__dirname, 'public', 'vendor')));

  // PWA. The service worker's scope is the path it is served from, so it MUST be served
  // from the site root — at /resources/js/service-worker.js its scope was /resources/js/
  // and it could never control a single real page. Both this and the manifest are
  // deliberately outside ensureAuthenticated; neither contains anything sensitive.
  app.get('/service-worker.js', (req, res) => {
    res.type('application/javascript');
    // The worker itself must never be served from cache, or clients can be pinned to a
    // stale worker indefinitely.
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, 'public', 'service-worker.js'));
  });
  app.get('/manifest.json', (req, res) => {
    res.type('application/manifest+json');
    res.sendFile(path.join(__dirname, 'public', 'manifest', 'manifest.json'));
  });
  app.get('/offline.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'offline.html'));
  });
  app.get('/favicon.ico', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'images', 'favicon.ico'));
  });
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.sendFile(path.join(__dirname, 'public', 'robots.txt'));
  });

  // CSP violation reports (report-uri directive in securityService). Browsers
  // POST these automatically with no session/CSRF, so the endpoint must sit
  // outside the authenticated appRouter. Reports are logged for review.
  app.post(
    '/csp-report',
    express.json({
      type: ['application/csp-report', 'application/reports+json', 'application/json'],
      limit: '32kb',
    }),
    (req, res) => {
      try {
        const report = req.body?.['csp-report'] || req.body;
        if (report && Object.keys(report).length > 0) {
          logger.warn('[csp] Violation report: ' + JSON.stringify(report).slice(0, 2000));
        }
      } catch (_) { /* never fail a beacon */ }
      res.status(204).end();
    },
  );

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
      // WEB holds the public website's copy and is reported but deliberately
      // NOT part of `ok`. mdb.connect() awaits all four, so a misconfigured WEB
      // namespace fails loudly at boot; losing it later must not mark the
      // container unhealthy and restart CIS, payroll and attendance over
      // marketing content. Same reasoning in maintenanceService.dbState().
      const webReady = mdb.WEB?.connection?.readyState === 1;
      const ok = restReady && internalReady && paperlessReady;
      res.status(ok ? 200 : 503).json({
        ok,
        uptime: process.uptime(),
        db: { REST: restReady, INTERNAL: internalReady, PAPERLESS: paperlessReady, WEB: webReady },
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Service status page — renders the current availability state in place
  // (503 + Retry-After while degraded, redirect home when healthy).
  // /i-am-stuck is kept as a legacy alias for old bookmarks and monitors.
  app.get('/service-unavailable', (req, res) => {
    const reason = maintenance.currentReason();
    if (!reason) return res.redirect(302, '/');
    return maintenance.renderUnavailable(req, res, reason);
  });
  app.get('/i-am-stuck', (req, res) => res.redirect(301, '/service-unavailable'));

  // ── Dev-only MongoDB inspector ──────────────────────────────────────
  // Mounted BEFORE the scanner blocklist (whose /db\b pattern would 403 it
  // and autoban loopback) and before appRouter so it bypasses session/auth/
  // CSRF. Triple-gated: DEV_DB_ADMIN=true, non-production, and loopback-only
  // (enforced inside the router). Handlers access mdb lazily, so mounting
  // here in Phase 1 is safe — requests simply 404/error until MongoDB connects.
  if (process.env.DEV_DB_ADMIN === 'true' && process.env.NODE_ENV !== 'production') {
    logger.warn('[startup] DEV_DB_ADMIN enabled — mounting unauthenticated /admin/db (loopback only, dev use only)');
    app.use('/admin/db', __devDbRoutes);
  }

  // Early request blocklist for common scanner/probe paths
  app.use(__requestBlocklistService);

  // ── First-run setup wizard ──────────────────────────────────────────────────
  // Only active when neither env vars nor app-config.json supply the minimum
  // required config (MONGO_URI/MONGO_HOST, SESSION_SECRET, ENCRYPTION_KEY).
  // Existing deployments with env vars set skip this entirely.
  if (!configService.isConfigured()) {
    logger.warn('[startup] Application is not configured — mounting setup wizard at /setup');
    const cookieParser = __cookie_parser;
    // Minimal in-memory session for wizard state (never persisted)
    app.use(cookieParser());
    app.use(session({
      secret: 'setup-wizard-temporary-secret',
      resave: false,
      saveUninitialized: true,
      cookie: { httpOnly: true, sameSite: 'lax' },
    }));
    app.use('/setup', __setupRoutes);
    app.get('/', (req, res) => res.redirect('/setup'));
    app.use((req, res) => res.redirect('/setup'));
    // Start the HTTP server so the process stays alive to serve the wizard
    const server = http.createServer(app);
    const port = Number(process.env.PORT) || 3000;
    const host = process.env.HOST || '0.0.0.0';
    server.listen(port, host, () => {
      logger.info(`[startup] Setup wizard listening on ${host}:${port} — visit /setup to configure`);
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
  app.use(maintenance);

  // Minimal error handler for the pre-DB phase
  app.use((err, req, res, _next) => {
    logger.error('[startup] Error before DB ready: ' + (err.message || err));
    return maintenance.renderUnavailable(req, res, 'starting');
  });

  // Start listening immediately
  const server = http.createServer(app);
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';

  server.listen(port, host, () => {
    logger.info(`[startup] Server listening on ${host}:${port} (waiting for MongoDB…)`);
  });

  // ── Phase 2: Connect to MongoDB and mount full app ──────────────────
  try {
    await mdb.connect();
    logger.info('[startup] MongoDB connected — mounting full application');

    // Managed configuration lives in Mongo, so it can only be read now. It is
    // applied to process.env here, before anything that reads configuration is
    // mounted — the ~14 keys read at module import are already past, which is
    // exactly what configRegistry marks `restart: true`.
    {
      const configStore = (await import('./services/configStoreService.js')).default;
      await configStore.load();
      configStore.logMigrationState();
    }

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
          const hashedPassword = await bcrypt.hash(parsed.password, 10);
          await mdb.INTERNAL.user.create({
            uuid: crypto.randomUUID(),
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

    // Seed payroll tax rates for known tax years (insert-only — admin edits
    // in Settings → Payroll → Tax Rates are preserved; known-bad values from
    // pre-6.8.6 seeds are corrected by exact-value match)
    try {
      const { ensureSeeded } = __payrollTaxRatesSeedService;
      const { created, corrected } = await ensureSeeded(mdb.INTERNAL.payrollTaxRates);
      if (created.length > 0) logger.info(`[migration] Seeded payroll tax rates for: ${created.join(', ')}`);
      if (corrected > 0)      logger.info(`[migration] Applied ${corrected} payroll tax rate correction(s)`);
    } catch (seedErr) {
      logger.error('[migration] Payroll tax rate seeding failed', { error: seedErr.message });
    }

    // Seed the core email/notification type catalog (insert-only — admin edits
    // in Settings → Emails are preserved).
    try {
      const { ensureSeeded } = __emailTypesSeedService;
      await ensureSeeded(mdb.INTERNAL.emailType);
    } catch (seedErr) {
      logger.error('[migration] Email type seeding failed', { error: seedErr.message });
    }

    // Validate the metadata-driven list/CRUD config against registered models.
    // Non-fatal: surfaces typo'd option keys and stale model entries that would
    // otherwise fail silently.
    try {
      __configValidatorService.validateAtStartup(mdb);
    } catch (cfgErr) {
      logger.warn('[configValidator] validation error: ' + cfgErr.message);
    }

    // Load CIS nominal code mappings from the database
    try {
      await cisMappings.loadFromDb(mdb.REST.nominal);
      logger.info(`[cis] Loaded nominal codes — materials: [${cisMappings.materialsNominalCodes}], labour: [${cisMappings.labourNominalCodes}], cisDeduction: [${cisMappings.cisDeductionNominalCodes}]`);
    } catch (cisErr) {
      logger.error('[cis] Failed to load nominal codes from DB, using defaults', { error: cisErr.message });
    }

    const { initSocket } = __socketService;

    // Session store (requires INTERNAL connection)
    const internalClient = mdb.INTERNAL.connection.client;
    const sessionService = createSessionService(internalClient);

    // Mount the full middleware + routes into appRouter
    appRouter.use(expressLayouts);
    appRouter.use(express.json());
    appRouter.use(express.urlencoded({ extended: true }));
    appRouter.use(cookieParser());
    appRouter.use(sessionService);
    appRouter.use(__csrfService);

    // Protected static assets
    appRouter.use('/resources', authService.ensureAuthenticated, express.static(path.join(__dirname, 'public')));

    // Core middleware
    appRouter.use(useragent.express());
    appRouter.use(__securityService);
    appRouter.use(__flashService);
    // Drop any carried-over reset password the moment the browser navigates
    // outside the password reset flow. Mounted after the /resources static
    // handler so the reset page's own assets never look like leaving.
    appRouter.use(__passwordResetDraft.dropOnLeave);
    appRouter.use(authService.ensureAuthenticated);
    appRouter.use(authService.ensureRouteAccess);
    // Bind the authenticated actor to async-local storage so the DB audit plugin
    // can attribute writes (must run after auth populates req.session.user).
    appRouter.use(__auditContextService.middleware);
    appRouter.use(__logRequestDetailsService);
    appRouter.use(__rateLimiterService);
    // Maintenance/availability guard (friendly 503 when backing services restart mid-operation)
    appRouter.use(maintenance);
    // Session activity tracking (after auth)
    appRouter.use(__sessionActivityService.touchSessionActivity);
    appRouter.use(__sessionActivityService.trackPageVisit);

    // Admin-only debug route to inspect forwarded headers and connection security
    appRouter.get('/__debug/headers', __authService.ensureRole('admin'), (req, res) => {
      const { getClientIp } = __ipService;
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
    appRouter.use((req, res, next) => {
      res.locals.currentPath = req.path;
      res.locals.navActive = (href) =>
        href === '/' ? req.path === '/' : req.path === href || req.path.startsWith(href + '/');
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
      // Canonical department registry — drives the top nav in layout.ejs
      res.locals.departmentsConfig = departmentsConfig;
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
      res.locals.commit = gitCommit ? gitCommit.slice(0, 7) : null;
      res.locals.commitUrl = gitCommit ? `${gitRepoUrl}/commit/${gitCommit}` : null;
      res.locals.slimDateTime = __dateService.slimDateTime;
      res.locals.fmtDate = __dateService.fmtDate;
      res.locals.formatCurrency = __currencyService.formatCurrency;
      // Lets views ask "does this document carry tag X?" without hardcoding a
      // tag name that a Paperless rename would silently invalidate.
      res.locals.hasTag = __paperlessTags.hasTag;
      res.locals.rounding = __currencyService.rounding;
      if (!res.locals.csrfToken && req.session?.csrfToken) {
        res.locals.csrfToken = req.session.csrfToken;
      }
      res.locals.contactEmail = configService.get('SUPPORTEMAIL');
      res.locals.companyName = configService.get('COMPANY_NAME', '');
      // Maintenance banner: pre-announcement notice + active flag (admins
      // bypass the maintenance page, so remind them it's on)
      res.locals.maintenanceActive = maintenance.isMaintenanceOn();
      res.locals.maintenanceNotice = String(configService.get('MAINTENANCE_NOTICE', '') || '').trim();
      res.locals.icoNumber = configService.get('ICO_NUMBER', '[ICO_NUMBER not set]');
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
    appRouter.use(holidayController.checkHoliday);

    // Encryption key dev hint
    if (process.env.NODE_ENV === 'development' && !process.env.ENCRYPTION_KEY) {
      const newKey = crypto.randomBytes(32).toString('hex');
      const hex = Buffer.from(newKey, 'hex');
      logger.info('Generated ENCRYPTION_KEY (hex): ' + hex.toString('hex'));
    }

    // CRUD/list routes generate handlers by iterating mdb.REST/INTERNAL models,
    // so they must be imported after mdb.connect() — a static top-level import
    // would evaluate them against empty namespaces and register no routes.
    const __CRUDRoutes = (await import('./mongoose/routes/CRUDRoutes.js')).default;
    const __listRoutes = (await import('./mongoose/routes/listRoutes.js')).default;

    appRouter.use('/', __userRoutes);
    // Routes
    appRouter.use('/', __attendanceRoutes);
    appRouter.use('/', __cisRoutes);
    appRouter.use('/', __CRUDRoutes);
    appRouter.use('/', __indexRoutes);
    appRouter.use('/', __listRoutes);
    appRouter.use('/', __adminRoutes);
    appRouter.use('/', __loggerRoutes);
    appRouter.use('/', __returnsRoutes);
    appRouter.use('/', __settingsRoutes);
    appRouter.use('/', __emailRoutes);
    appRouter.use('/', __twoFARoutes);
    appRouter.use('/', __subcontractorRoutes);
    appRouter.use('/', __submissionRoutes);
    appRouter.use('/', __holidayRoutes);
    appRouter.use('/', __fileRoutes);
    appRouter.use('/', __paperlessRoutes);
    appRouter.use('/', __bankRoutes);
    appRouter.use('/', __accountantRoutes);
    appRouter.use('/', __overviewRoutes);
    appRouter.use('/', __ssoRoutes);
    appRouter.use('/', __helpRoutes);
    appRouter.use('/', __payrollRoutes);
    appRouter.use('/', __gdprRoutes);
    appRouter.use('/', __legalRoutes);
    appRouter.use('/', __companyDocsRoutes);
    appRouter.use('/', __auditRoutes);
    appRouter.use('/', __webRoutes);
    // Read-only content API for hcs-web. Inside appRouter so it gets body
    // parsing, request logging and maintenance's JSON 503; exempted from the
    // session guard by the "/api/web/" prefix in authService's PUBLIC_PREFIXES.
    appRouter.use('/', __webApiRoutes);

    // Catch-all 404
    appRouter.use((req, res, next) => {
      const error = new Error(`Route not found: ${req.method} ${req.originalUrl}`);
      error.statusCode = 404;
      next(error);
    });

    // Global error handler
    appRouter.use(__errorHandlerService);

    // WebSocket
    const io = initSocket(server);
    const { setupWebSocket } = __webSocketService;
    setupWebSocket(io, sessionService);

    // Start periodic background services
    // All periodic background work runs through the central job scheduler
    // (status + manual trigger at /admin/jobs)
    try { __jobRegistry.start(); } catch (e) { logger.warn('Job scheduler start failed: ' + e.message); }

    logger.info(`[startup] Application fully ready in ${process.env.NODE_ENV} on ${host}:${port}`);

  } catch (err) {
    logger.error('[startup] Failed to connect to MongoDB: ' + err.message);
    logger.error('   Server remains running — showing maintenance page to all requests');
    // Server keeps running; maintenanceService will show 503 for every request
    // because mdb connections remain in non-ready state.
  }
};

main();
