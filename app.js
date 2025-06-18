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

const mdb = require('./services/mongoose/mongooseDatabaseService');
const { ensureAuthenticated } = require('./services/authService');

const main = async () => {
  try {
    await mdb.connect(); // Wait for MongoDB/SSH tunnel

    const app = express();

    app.set('trust proxy', 1);
    app.set('view engine', 'ejs');
    app.set('views', [
      path.join(__dirname, 'views'),
      path.join(__dirname, 'mongoose/views')
    ]);
    app.set('layout', 'layout');
    app.use(expressLayouts);
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // Add cookie parser for JWT and pending2FA
    app.use(cookieParser());

    // Static assets
    app.use('/resources', express.static(path.join(__dirname, 'public')));
    ['bootstrap', 'bootstrap-icons', '@popperjs/core'].forEach(pkg => {
      app.use(`/resources/${pkg}`, express.static(path.join(__dirname, `node_modules/${pkg}`)));
    });

    // Core middleware
    app.use(useragent.express());
    app.use(require('./services/securityService'));
    app.use(require('./services/flashService'));
    app.use(ensureAuthenticated);
    app.use(require('./services/logRequestDetailsService'));
    app.use(require('./services/rateLimiterService'));
    app.use(require('./services/mongoose/cronServiceMongoose'));

    // Attach user info to templates
    app.use((req, res, next) => {
      res.locals.successMessage = req.flash('success');
      res.locals.errorMessage = req.flash('error');
      res.locals.isAuthenticated = !!req.user;
      res.locals.role = req.user && req.user.role || null;
      res.locals.isAdmin = req.user && req.user.role === 'admin';
      res.locals.firstName = req.user && req.user.username
        ? req.user.username.split('.')[0].replace(/^\w/, c => c.toUpperCase())
        : null;
      res.locals.permissions = req.user && req.user.permissions || {};
      res.locals.package = packageJson.version;
      res.locals.slimDateTime = require('./services/dateService').slimDateTime;
      res.locals.formatCurrency = require('./services/currencyService').formatCurrency;
      res.locals.rounding = require('./services/currencyService').rounding;
      res.locals.contactEmail = process.env.SUPPORTEMAIL;
      res.locals.lastfetched = null;
      res.locals.session = null;

      const logUser = req.user?.username || 'unknown user';
      const logMsg = `${logUser} accessed ${req.method} ${req.path}`;
      if (req.path.includes('/update/')) logger.warn(`-- WARN: ${logMsg}`);
      else if (req.path.includes('/delete/')) logger.error(`-- DANGER: ${logMsg}`);
      else logger.info(logMsg);
      next();
    });

    // App-wide meta info (Mongo)
    app.use(async (req, res, next) => {
      try {
        res.locals.lastfetched = await mdb.meta.findOne().sort({ lastFetchedAt: -1 }) || null;
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
    const holidayService = require('./services/mongoose/holidayServiceMongoose');
    app.use(async (req, res, next) => {
      try {
        const holidayDetails = await holidayService.isDateHoliday();
        if (holidayDetails?.isHoliday) {
          logger.info(`Holiday: ${holidayDetails.reason} (${holidayDetails.startDate} to ${holidayDetails.endDate})`);
          return res.render('holiday', {
            title: 'Holiday Notice',
            reason: holidayDetails.reason,
            startDate: holidayDetails.startDate,
            endDate: holidayDetails.endDate
          });
        }
        next();
      } catch (err) {
        logger.error('Holiday check error:', err.message);
        next(err);
      }
    });

    // Encryption key dev hint
    if (process.env.NODE_ENV === 'development' && !process.env.ENCRYPTION_KEY) {
      const newKey = crypto.randomBytes(32).toString('hex');
      const hex = Buffer.from(newKey, 'hex');
      console.log('Generated ENCRYPTION_KEY (hex):', hex);
    }

    // Routes
    const adminLogger = require('./controllers/admin/logger');
    const mongooseRoutes = require("./mongoose/routes");
    app.use('/', mongooseRoutes);
    app.use('/', adminLogger);

    // Catch-all 404
    app.use((req, res, next) => {
      const error = new Error(`Route not found: ${req.method} ${req.originalUrl}`);
      error.statusCode = 404;
      next(error);
    });

    // Global error handler
    app.use(require('./services/errorHandlerService'));

    // Server init
    const port = process.env.NODE_ENV === 'server2' ? 3000
              : process.env.NODE_ENV === 'development' ? 80
              : 443;
    const host = process.env.NODE_ENV === 'development' ? '127.0.0.1' : '0.0.0.0';

    app.listen(port, host, () => {
      logger.info(`🚀 Server running in ${process.env.NODE_ENV} on ${host}:${port}`);
    });

  } catch (err) {
    logger.error('❌ Failed to start application: '+ err + err.stack);
  }
};

main();
