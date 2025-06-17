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
const authService = require('./services/authService');
const swaggerUi = require('swagger-ui-express');
const fs = require('fs');

app.set('trust proxy', true);
app.set('view engine', 'ejs');
app.set('views', [
  path.join(__dirname, 'views'),
  path.join(__dirname, 'mongoose/views')
]);
app.set('layout', 'layout');
app.use(expressLayouts);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Dynamically serve specific node_modules packages under /resources/
const vendorPackages = ['bootstrap', 'bootstrap-icons', '@popperjs/core'];
vendorPackages.forEach(pkg => {
    app.use(`/resources/${pkg}`, express.static(path.join(__dirname, `node_modules/${pkg}`)));
});

app.use(useragent.express());
app.use(require('./services/securityService'));
app.use(require('./services/sessionService'));
app.use(flash());
app.use(require('./services/logRequestDetailsService'));
app.use(require('./services/cronService'));

const db = require('./services/sequelizeDatabaseService');
const kf = require('./services/kashflowDatabaseService');
// Initialize MongoDB connection and models
require('./services/mongooseDatabaseService');

const { slimDateTime } = require('./services/dateService');
const { formatCurrency, rounding } = require('./services/currencyService');

app.use(async (req, res, next) => {
    res.locals.session = req.session;
    res.locals.isAuthenticated = false;
    res.locals.isAdmin = false;
    res.locals.firstName = null;
    res.locals.permissions = {};
    res.locals.role = null;

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
        next();
    }

    try {
        if (res.locals.isAuthenticated) {
            res.locals.unpaidInvoices = {};
            res.locals.unsubmittedInvoices = {};
            res.locals.totalNotifications = 0;
            if (res.locals.permissions.unpaidInvoices) {
                const unpaidInvoices = await db.Invoices.findAll({
                    where: { remittanceDate: null },
                    attributes: ['id', 'kashflowNumber'],
                    order: [['kashflowNumber', 'ASC']]
                });
                res.locals.unpaidInvoices = unpaidInvoices;
                res.locals.totalNotifications += res.locals.unpaidInvoices;
            }
            if (res.locals.permissions.unsubmittedInvoices) {
                const unsubmittedInvoices = await db.Invoices.findAll({
                    where: { submissionDate: null },
                    attributes: ['id', 'kashflowNumber'],
                    order: [['kashflowNumber', 'ASC']]
                });
                res.locals.unsubmittedInvoices = unsubmittedInvoices;
                res.locals.totalNotifications += res.locals.unsubmittedInvoices;
            }
            const lastfetched = await kf.KF_Meta.findOne({
                order: [['lastFetchedAt', 'DESC']]
            })
            res.locals.lastfetched = lastfetched || null;
            res.locals.contactEmail = process.env.SUPPORTEMAIL;
            next();
        } else {
            res.locals.unpaidInvoices = {};
            res.locals.unsubmittedInvoices = {};
            res.locals.totalNotifications = 0;
            res.locals.lastfetched = null;
            next();
        }
    } catch (error) {
        logger.error('Error fetching invoices: ' + error);
        next();
    }

    res.locals.session = req.session;
    res.locals.package = packageJson.version;
    res.locals.copyrightyearstart = 2023;
    res.locals.copyrightyear = moment().year();
    res.locals.slimDateTime = slimDateTime;
    res.locals.formatCurrency = formatCurrency;
    res.locals.rounding = rounding;

});

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

/*
const holidayService = require('./services/holidayService');

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
                endDate: holidayDetails.endDate,
                errorMessages : req.flash('error'),
                successMessage : req.flash('success'),
            });
        }
        
        // If not a holiday, proceed to the next middleware
        next();
    } catch (error) {
        logger.error({
            event: 'holiday_error',
            message: error.message,
            stack: error.stack,
        });
        next(error); // Pass the error to the error-handling middleware
    }
});

const crypto = require('crypto');
if (process.env.NODE_ENV === 'development') {
    if (process.env.ENCRYPTION_KEY === '') {
        // Generate a 32-byte random key for AES-256
        const encryptionKey = crypto.randomBytes(32).toString('hex');
        //console.log('Your Encryption Key:', encryptionKey);
        //console.log('ENCRYPTION_KEY length:', encryptionKey.length);
        const encryptionKeyHEX = Buffer.from(encryptionKey, 'hex');
        //console.log('Your Encryption Key:', encryptionKeyHEX);
        //console.log('ENCRYPTION_KEY length:', encryptionKeyHEX.length);
    } else {
        //console.log('Encryption Key:', process.env.ENCRYPTION_KEY);
        //console.log('ENCRYPTION_KEY length:', process.env.ENCRYPTION_KEY.length);
        const encryptionKeyHEX = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
        //console.log('Encryption Key:', encryptionKeyHEX);
        //console.log('ENCRYPTION_KEY length:', encryptionKeyHEX.length);
    }
}
*/
const index = require('./controllers/renderIndex');

const formsUser = require('./controllers/forms/user');
const formsSubcontractor = require('./controllers/forms/subcontractor');
const formsInvoice = require('./controllers/forms/invoice');
const formsQuote = require('./controllers/forms/quote');
const formsClient = require('./controllers/forms/client');
const formsContact = require('./controllers/forms/contact');
const formsJob = require('./controllers/forms/job');
const formsLocation = require('./controllers/forms/location');
const formsAttendance = require('./controllers/forms/attendance');
const formsEmployee = require('./controllers/forms/employee');

const renderDashboard = require('./controllers/renderDashboards');

const userLogin = require('./controllers/user/login');
const userRegister = require('./controllers/user/register');
const userSettings = require('./controllers/user/settings');

const userCRUD = require('./controllers/CRUD/userCRUD');
const subcontractorCRUD = require('./controllers/CRUD/subcontractorCRUD');
const invoiceCRUD = require('./controllers/CRUD/invoiceCRUD');
const quoteCRUD = require('./controllers/CRUD/quoteCRUD');
const clientCRUD = require('./controllers/CRUD/clientCRUD');
const contactCRUD = require('./controllers/CRUD/contactCRUD');
const attendanceCRUD = require('./controllers/CRUD/attendanceCRUD');
const employeeCRUD = require('./controllers/CRUD/employeeCRUD');
const jobCRUD = require('./controllers/CRUD/jobCRUD');
const locationCRUD = require('./controllers/CRUD/locationCRUD');

const monthlyReturns = require('./controllers/monthlyReturns');
const yearlyReturns = require('./controllers/yearlyReturns');

const dailyAttendance = require('./controllers/dailyAttendance');
const weeklyAttendance = require('./controllers/weeklyAttendance');

const kashflowRoutes = require('./kf/routes')
const mongooseRoutes = require('./mongoose/routes');

const verificationRoutes = require('./controllers/renderVerification');

const kashflowCustomer = require('./controllers/CRUD/kashflow/customer');
const kashflowInvoice = require('./controllers/CRUD/kashflow/invoice');
const kashflowProject = require('./controllers/CRUD/kashflow/project');
const kashflowQuote = require('./controllers/CRUD/kashflow/quote');
const kashflowReceipt = require('./controllers/CRUD/kashflow/receipt');
const kashflowSupplier = require('./controllers/CRUD/kashflow/supplier');

const fileSystemProjects = require('./controllers/fileSystemProjects');

const kashflowMonthlyReturns = require('./controllers/kashflowMonthlyReturns');
const kashflowYearlyReturns = require('./controllers/kashflowYearlyReturns');

app.use('/', index);
app.use('/', mongooseRoutes);

app.use('/client', formsClient);
app.use('/contact', formsContact);
app.use('/invoice', formsInvoice);
app.use('/quote', formsQuote);
app.use('/subcontractor', formsSubcontractor);
app.use('/user', formsUser);
app.use('/job', formsJob);
app.use('/location', formsLocation);
app.use('/attendance', formsAttendance);
app.use('/employee', formsEmployee);

app.use('/dashboard', renderDashboard);

app.use('/user', userLogin);
app.use('/user', userRegister);
app.use('/user', userSettings);

app.use('/user', userCRUD);
app.use('/subcontractor', subcontractorCRUD);
app.use('/invoice', invoiceCRUD);
app.use('/quote', quoteCRUD);
app.use('/client', clientCRUD);
app.use('/contact', contactCRUD);
app.use('/attendance', attendanceCRUD);
app.use('/employee', employeeCRUD);
app.use('/job', jobCRUD);
app.use('/location', locationCRUD);

app.use('/monthly', monthlyReturns);
app.use('/yearly', yearlyReturns);

app.use('/attendance', dailyAttendance);
app.use('/attendance', weeklyAttendance);

app.use('/', kashflowRoutes);

app.use('/verify', verificationRoutes);

app.use('/kashflow', kashflowCustomer);
app.use('/kashflow', kashflowInvoice);
app.use('/kashflow', kashflowProject);
app.use('/kashflow', kashflowQuote);
app.use('/kashflow', kashflowReceipt);
app.use('/kashflow', kashflowSupplier);

app.use('/', fileSystemProjects);

app.use('/kashflow/monthly', kashflowMonthlyReturns);
app.use('/kashflow/yearly', kashflowYearlyReturns);

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

if (process.env.NODE_ENV === 'development') {
    app.listen(80, '127.0.0.1', () => {
        logger.info(`Server is running development`);
    });
} else {
    app.listen(443, '0.0.0.0', () => {
        logger.info(`Server is running production`);
    });
}

module.exports = app;