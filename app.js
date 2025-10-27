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

const main = async () => {
  try {
    await mdb.connect(); // Wait for MongoDB/SSH tunnel

    const app = express();
    const http = require('http');
    const { initSocket } = require('./services/socketService');

    // Get INTERNAL connection's client for session store
    const internalClient = mdb.INTERNAL.connection.client;
    const createSessionService = require('./mongoose/services/sessionServiceMongoose');
    const sessionService = createSessionService(internalClient);

    app.set('trust proxy', 1);
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
    app.use('/resources', authService.ensureAuthenticated, express.static(path.join(__dirname, 'public')));
    ['bootstrap-icons'].forEach(pkg => {
      app.use(`/resources/${pkg}`, authService.ensureAuthenticated, express.static(path.join(__dirname, `node_modules/${pkg}`)));
    });

    // Serve favicon to avoid 404 errors
    app.get('/favicon.ico', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'images', 'favicon.ico'));
    });

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
    // Session activity tracking (after auth)
    app.use(require('./mongoose/services/sessionActivityService').touchSessionActivity);

    // Attach user info to templates
    app.use((req, res, next) => {
      const successFlash = req.flash('success');
      const errorFlash = req.flash('error');

      res.locals.successMessage = successFlash.length > 0 ? successFlash : null;
      res.locals.errorMessage = errorFlash.length > 0 ? errorFlash : null;
      res.locals.isAuthenticated = !!req.user;
      res.locals.role = req.user && req.user.role || null;
      res.locals.isAdmin = req.user && req.user.role === 'admin';
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

  } catch (err) {
    logger.error('❌ Failed to start application: ' + err + err.stack);
  }
};

main();