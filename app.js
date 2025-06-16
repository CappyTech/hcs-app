const express = require('express');
const path = require('path');
const expressLayouts = require('express-ejs-layouts');
const flash = require('express-flash');
const useragent = require('express-useragent');
const logger = require('./services/loggerService');
require('dotenv').config();
const packageJson = require('./package.json');
const moment = require('moment');
const app = express();
const authService = require('./services/mongoose/authServiceMongoose');
const swaggerUi = require('swagger-ui-express');
const fs = require('fs');

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('layout', 'layout');
app.use(expressLayouts);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve everything from /public under /resources/
app.use('/resources', express.static(path.join(__dirname, 'public')));

// Dynamically serve specific node_modules packages under /resources/
const vendorPackages = ['bootstrap', 'bootstrap-icons', '@popperjs/core'];
vendorPackages.forEach(pkg => {
    app.use(`/resources/${pkg}`, express.static(path.join(__dirname, `node_modules/${pkg}`)));
});

app.use(useragent.express());

app.use(require('./services/securityService'));
app.use(require('./services/mongoose/sessionServiceMongoose'));
app.use(flash());
app.use(require('./services/logRequestDetailsService'));
app.use(require('./services/rateLimiterService'));
app.use(require('./services/mongoose/cronServiceMongoose'));

const databaseUsed = process.env.DATABASE_TYPE || 'mdb';

//const db = require('./services/sequelizeDatabaseService');
//const kf = require('./services/kashflowDatabaseService');
const mdb = require('./services/mongoose/mongooseDatabaseService');

app.use(async (req, res, next) => {
    res.locals.session = req.session;
    res.locals.isAuthenticated = false;
    res.locals.isAdmin = false;
    res.locals.firstName = null;
    res.locals.permissions = {};
    res.locals.role = null;
    //logger.debug(JSON.stringify(res.locals.session, null, 2))
    if (databaseUsed === "db") {
        logger.info('Using Sequelize database');
         try {
            const user = req.session.user;
            if (user && user.id) {
                const User = await db.Users.findByPk(user.id);
                if (User) {
                    res.locals.isAuthenticated = true;
                    res.locals.isAdmin = User.role === 'admin';
                    res.locals.firstName = User.username.split('.')[0].charAt(0).toUpperCase() + User.username.split('.')[0].slice(1);
                    res.locals.permissions = User.permissions || {};
                    res.locals.role = User.role;
                }
            }
        } catch (error) {
            logger.error(`Error validating user: ${error.message}`);
        }
    } else if (databaseUsed === "mdb") {
        //logger.info('Using Mongoose database');
        try {
            const user = req.session.user;
            if (user && user._id) {
                const User = await mdb.user.findById(user._id);
                if (User) {
                    res.locals.isAuthenticated = true;
                    res.locals.isAdmin = User.role === 'admin';
                    res.locals.firstName = User.username.split('.')[0].charAt(0).toUpperCase() + User.username.split('.')[0].slice(1);
                    res.locals.permissions = User.permissions || {};
                    res.locals.role = User.role;
                }
            }
        } catch (error) {
            logger.error(`Error validating user: ${error.message}`);
        }
    }


    const username = req.session.user ? req.session.user.username : 'unknown user';
    const logMessage = `${username} accessed path ${req.method} ${req.path}`;
    if (req.path.includes('/update/')) {
        logger.warn(`-------- Warn: ${logMessage}`);
    } else if (req.path.includes('/delete/')) {
        logger.error(`------- Danger: ${logMessage}`);
    } else {
        logger.info(`${logMessage}`);
    }

    next();
});

app.use(async (req, res, next) => {
    if (databaseUsed === "db") {
        logger.info('Using Sequelize database for meta data');
        try {
            const lastfetched = await kf.KF_Meta.findOne({
                order: [['lastFetchedAt', 'DESC']]
            });
            res.locals.lastfetched = lastfetched || null;
            res.locals.contactEmail = process.env.SUPPORTEMAIL;
        } catch (error) {
            logger.error('Error fetching invoices: ' + error);
        }
    } else if (databaseUsed === "mdb") {
        //logger.info('Using Mongoose database for meta data');
        try {
            const lastfetched = await mdb.meta.findOne().sort({ lastFetchedAt: -1 });
            res.locals.lastfetched = lastfetched || null;
            res.locals.contactEmail = process.env.SUPPORTEMAIL;
            next();
        } catch (error) {
            logger.error('Error fetching invoices: ' + error);
            next();
        }
    }
});

app.use((req, res, next) => {
    res.locals.successMessage = req.flash('success');
    res.locals.errorMessage = req.flash('error');
    next();
});

const { slimDateTime } = require('./services/dateService');
const { formatCurrency, rounding } = require('./services/currencyService');

app.use((req, res, next) => {
    res.locals.session = req.session;
    res.locals.package = packageJson.version;
    res.locals.copyrightyearstart = 2023;
    res.locals.copyrightyear = moment().year();
    res.locals.slimDateTime = slimDateTime;
    res.locals.formatCurrency = formatCurrency;
    res.locals.rounding = rounding;
    next();
});

app.disable('x-powered-by');
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});

const holidayService = require('./services/mongoose/holidayServiceMongoose');

app.use(async (req, res, next) => {
    try {
        // Check if today is a holiday
        const holidayDetails = await holidayService.isDateHoliday();

        if (holidayDetails?.isHoliday) {
            logger.info(`Holiday detected: ${holidayDetails.reason} (${holidayDetails.startDate} to ${holidayDetails.endDate})`);

            // Render the holiday notice page if today is a holiday
            return res.render('holiday', {
                title: 'Holiday Notice',
                reason: holidayDetails.reason,
                startDate: holidayDetails.startDate,
                endDate: holidayDetails.endDate
            });
        }

        // If not a holiday, proceed to the next middleware
        next();
    } catch (error) {
        logger.error('Error checking holiday status:', error.message);
        next(error); // Pass the error to the error-handling middleware
    }
});

const crypto = require('crypto');
if (process.env.NODE_ENV === 'development') {
    if (!process.env.ENCRYPTION_KEY) {
        // Generate a 32-byte random key for AES-256
        const encryptionKey = crypto.randomBytes(32).toString('hex');
        //logger.info('Your Encryption Key:', encryptionKey);
        //logger.info('ENCRYPTION_KEY length:', encryptionKey.length);
        const encryptionKeyHEX = Buffer.from(encryptionKey, 'hex');
        //logger.info('Your Encryption Key:', encryptionKeyHEX);
        //logger.info('ENCRYPTION_KEY length:', encryptionKeyHEX.length);
    } else {
        //logger.info('Encryption Key:', process.env.ENCRYPTION_KEY);
        //logger.info('ENCRYPTION_KEY length:', process.env.ENCRYPTION_KEY.length);
        const encryptionKeyHEX = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
        //logger.info('Encryption Key:', encryptionKeyHEX);
        //logger.info('ENCRYPTION_KEY length:', encryptionKeyHEX.length);
    }
}

const index = require('./controllers/renderIndex');

//const formsUser = require('./controllers/forms/user');
//const formsSubcontractor = require('./controllers/forms/subcontractor');
//const formsInvoice = require('./controllers/forms/invoice');
//const formsQuote = require('./controllers/forms/quote');
//const formsClient = require('./controllers/forms/client');
//const formsContact = require('./controllers/forms/contact');
//const formsJob = require('./controllers/forms/job');
//const formsLocation = require('./controllers/forms/location');
//const formsAttendance = require('./controllers/forms/attendance');
//const formsEmployee = require('./controllers/forms/employee');

//const renderDashboard = require('./controllers/renderDashboards');

//const userLogin = require('./controllers/user/login');
//const userRegister = require('./controllers/user/register');
//const userSettings = require('./controllers/user/settings');
//const user2FA = require('./controllers/user/2fa');

//const userCRUD = require('./controllers/CRUD/userCRUD');
//const subcontractorCRUD = require('./controllers/CRUD/subcontractorCRUD');
//const invoiceCRUD = require('./controllers/CRUD/invoiceCRUD');
//const quoteCRUD = require('./controllers/CRUD/quoteCRUD');
//const clientCRUD = require('./controllers/CRUD/clientCRUD');
//const contactCRUD = require('./controllers/CRUD/contactCRUD');
//const jobCRUD = require('./controllers/CRUD/jobCRUD');
//const locationCRUD = require('./controllers/CRUD/locationCRUD');
//const attendanceCRUD = require('./controllers/CRUD/attendanceCRUD');
//const employeeCRUD = require('./controllers/CRUD/employeeCRUD');

//const monthlyReturns = require('./controllers/monthlyReturns');
//const yearlyReturns = require('./controllers/yearlyReturns');

//const dailyAttendance = require('./controllers/dailyAttendance');
//const weeklyAttendance = require('./controllers/weeklyAttendance');

//const kashflowRoutes = require('./kf/routes');
//const kashflowRoutesMongoose = require('./kf/mongoose/routes');

//const verificationRoutes = require('./controllers/renderVerification');

//const kashflowCustomer = require('./controllers/CRUD/kashflow/customer');
//const kashflowInvoice = require('./controllers/CRUD/kashflow/invoice');
//const kashflowProject = require('./controllers/CRUD/kashflow/project');
//const kashflowQuote = require('./controllers/CRUD/kashflow/quote');
//const kashflowReceipt = require('./controllers/CRUD/kashflow/receipt');
//const kashflowSupplier = require('./controllers/CRUD/kashflow/supplier');

//const fileSystemProjects = require('./controllers/fileSystemProjects');

//const kashflowMonthlyReturns = require('./controllers/kashflowMonthlyReturns');
//const kashflowYearlyReturns = require('./controllers/kashflowYearlyReturns');

const adminLogger = require('./controllers/admin/logger');

const testMongoose = require('./controllers/mongoose/receipts');

app.use('/', index);

//app.use('/user', formsUser);
// app.use('/client', formsClient);
// app.use('/contact', formsContact);
// app.use('/invoice', formsInvoice);
// app.use('/quote', formsQuote);
// app.use('/subcontractor', formsSubcontractor);
// app.use('/job', formsJob);
// app.use('/location', formsLocation);
//app.use('/attendance', formsAttendance);
//app.use('/employee', formsEmployee);

//app.use('/dashboard', renderDashboard);

//app.use('/user', userLogin);
//app.use('/user', userRegister);
//app.use('/user', userSettings);
//app.use('/user', user2FA);

//app.use('/user', userCRUD);
// app.use('/subcontractor', subcontractorCRUD);
// app.use('/invoice', invoiceCRUD);
// app.use('/quote', quoteCRUD);
// app.use('/client', clientCRUD);
// app.use('/contact', contactCRUD);
// app.use('/job', jobCRUD);
// app.use('/location', locationCRUD);
//app.use('/attendance', attendanceCRUD);
//app.use('/employee', employeeCRUD);

//app.use('/monthly', monthlyReturns);
//app.use('/yearly', yearlyReturns);

//app.use('/attendance', dailyAttendance);
//app.use('/attendance', weeklyAttendance);

//app.use('/', kashflowRoutes);
//app.use('/', kashflowRoutesMongoose);

//app.use('/verify', verificationRoutes);

//app.use('/kashflow', kashflowCustomer);
//app.use('/kashflow', kashflowInvoice);
//app.use('/kashflow', kashflowProject);
//app.use('/kashflow', kashflowQuote);
//app.use('/kashflow', kashflowReceipt);
//app.use('/kashflow', kashflowSupplier);

//app.use('/', fileSystemProjects);

//app.use('/kashflow/monthly', kashflowMonthlyReturns);
//app.use('/kashflow/yearly', kashflowYearlyReturns);

app.use('/', adminLogger);

app.use('/', testMongoose);

app.use("/api-docs", authService.ensureAuthenticated, authService.ensureRole('admin'), swaggerUi.serve, (req, res, next) => {
    const swaggerDocument = JSON.parse(
        fs.readFileSync(path.join(__dirname, "swagger.json"), "utf8")
    );
    swaggerUi.setup(swaggerDocument)(req, res, next);
});

// Catch undefined routes (404 handler)
app.use((req, res, next) => {
    const error = new Error(`Route not found: ${req.method} ${req.originalUrl}`);
    error.statusCode = 404;
    next(error);
});

// Register the error handler
app.use(require('./services/errorHandlerService'));

/*
const { ensureUUIDs } = require('./services/uuidCheckServiceMongoose');

ensureUUIDs()
  .then(() => {
    console.log('UUID check complete.');
  })
  .catch((err) => {
    console.error('Error running UUID check:', err);
  });
*/

if (process.env.NODE_ENV === 'server2') {
    const port = 3000;
    app.listen(port, () => {
        logger.info(`Server running in ${process.env.NODE_ENV} on port ${port}`);
    });
} else {
    const port = process.env.NODE_ENV === 'development' ? 80 : 443;
    const host = process.env.NODE_ENV === 'development' ? '127.0.0.1' : '0.0.0.0';
    app.listen(port, host, () => {
        logger.info(`Server running in ${process.env.NODE_ENV} on ${host}:${port}`);
    });
}

module.exports = app;