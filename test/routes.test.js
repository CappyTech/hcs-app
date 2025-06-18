const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function createApp(router) {
  const app = express();
  app.use(router);
  return app;
}

function ok() {
  return (req, res) => res.status(200).send('ok');
}

describe('Route tests', function () {
  const ensureRoleStub = { ensureRole: () => (req, res, next) => next() };
  before(() => {
    process.env.FETCH_API_TOKEN = 'test';
  });

  const configs = [
    {
      module: '../mongoose/routes/indexRoutes',
      stubs: {
        '../controllers/indexController': {
          renderIndex: ok(),
          renderConstructionIndustryScheme: ok(),
          renderManagement: ok(),
          renderPayroll: ok(),
          renderHumanResources: ok(),
          renderKashflow: ok(),
          renderCreate: ok(),
        },
        '../kf/fetchKashFlowDataMongoose': { fetchKashFlowDataMongoose: async () => {} },
        '../../services/loggerService': { error: () => {} },
        '../../services/authService': ensureRoleStub,
      },
      endpoints: [
        { method: 'get', path: '/' },
        { method: 'get', path: '/construction-industry-scheme' },
        { method: 'get', path: '/management' },
        { method: 'get', path: '/payroll' },
        { method: 'get', path: '/human-resources' },
        { method: 'get', path: '/kashflow' },
        { method: 'get', path: '/create' },
        { method: 'get', path: '/fetch-kashflow-data-mongoose?token=test' },
      ],
    },
    {
      module: '../mongoose/routes/dailyAttendance',
      stubs: {
        '../controllers/dailyAttendanceController': { getDailyAttendance: ok() },
        '../../services/authService': ensureRoleStub,
      },
      endpoints: [
        { method: 'get', path: '/attendance/daily' },
      ],
    },
    {
      module: '../mongoose/routes/attendanceCrud',
      stubs: {
        '../controllers/attendanceCRUDController': {
          createAttendance: ok(),
          readAttendance: ok(),
          updateAttendance: ok(),
          deleteAttendance: ok(),
        },
        '../../services/authService': ensureRoleStub,
      },
      endpoints: [
        { method: 'post', path: '/attendance/create' },
        { method: 'get', path: '/attendance/read/1' },
        { method: 'post', path: '/attendance/update/1' },
        { method: 'post', path: '/attendance/delete/1' },
      ],
    },
    {
      module: '../mongoose/routes/cis',
      stubs: {
        '../controllers/cisController': {
          renderCISDashboardMongo: ok(),
          redirectCIS: ok(),
        },
        '../../services/authService': ensureRoleStub,
      },
      endpoints: [
        { method: 'get', path: '/mdb/CIS/2020/01' },
        { method: 'get', path: '/mdb/CIS' },
      ],
    },
    {
      module: '../mongoose/routes/customers',
      stubs: {
        '../controllers/customersController': {
          listCustomers: ok(),
          viewCustomer: ok(),
        },
        '../../services/authService': ensureRoleStub,
      },
      endpoints: [
        { method: 'get', path: '/customers' },
        { method: 'get', path: '/customer/read/abc' },
      ],
    },
    {
      module: '../mongoose/routes/employeeCrud',
      stubs: {
        '../controllers/employeeCRUDController': {
          createEmployee: ok(),
          readEmployee: ok(),
          updateEmployee: ok(),
          deleteEmployee: ok(),
        },
        '../../services/authService': ensureRoleStub,
      },
      endpoints: [
        { method: 'post', path: '/employee/create' },
        { method: 'get', path: '/employee/read/1' },
        { method: 'post', path: '/employee/update/1' },
        { method: 'post', path: '/employee/delete/1' },
      ],
    },
    {
      module: '../mongoose/routes/invoices',
      stubs: {
        '../controllers/invoicesController': {
          listInvoices: ok(),
          viewInvoice: ok(),
        },
        '../../services/authService': ensureRoleStub,
      },
      endpoints: [
        { method: 'get', path: '/invoices' },
        { method: 'get', path: '/invoice/read/abc' },
      ],
    },
    {
      module: '../mongoose/routes/jobRegistration',
      stubs: {
        '../controllers/jobsController': {
          renderJobForm: ok(),
          registerJob: ok(),
          listJobs: ok(),
        },
        '../../services/authService': ensureRoleStub,
      },
      endpoints: [
        { method: 'get', path: '/job/register' },
        { method: 'post', path: '/job/register' },
        { method: 'get', path: '/jobs' },
      ],
    },
    {
      module: '../mongoose/routes/locationCrud',
      stubs: {
        '../controllers/locationCRUDController': {
          createLocation: ok(),
          readLocation: ok(),
          updateLocation: ok(),
          deleteLocation: ok(),
        },
        '../../services/authService': ensureRoleStub,
      },
      endpoints: [
        { method: 'post', path: '/location/create' },
        { method: 'get', path: '/location/read/abc' },
        { method: 'post', path: '/location/update/abc' },
        { method: 'post', path: '/location/delete/abc' },
      ],
    },
    {
      module: '../mongoose/routes/logger',
      stubs: {
        '../controllers/loggerController': { getLogs: ok() },
        '../../services/authService': ensureRoleStub,
      },
      endpoints: [
        { method: 'get', path: '/logs' },
      ],
    },
    {
      module: '../mongoose/routes/login',
      stubs: {
        '../controllers/loginController': {
          renderLoginForm: ok(),
          loginUser: ok(),
          logoutUser: ok(),
        },
        '../../services/authService': ensureRoleStub,
      },
      endpoints: [
        { method: 'get', path: '/user/login' },
        { method: 'post', path: '/user/login' },
        { method: 'get', path: '/user/logout' },
      ],
    },
    {
      module: '../mongoose/routes/monthlyReturns',
      stubs: {
        '../controllers/monthlyReturnsController': {
          renderMonthlyReturnsForm: ok(),
          renderMonthlyReturns: ok(),
        },
        '../../services/authService': ensureRoleStub,
      },
      endpoints: [
        { method: 'get', path: '/monthly/returns/form' },
        { method: 'get', path: '/monthly/returns/01/2020/abc' },
      ],
    },
    {
      module: '../mongoose/routes/projects',
      stubs: {
        '../controllers/projectsController': {
          listProjects: ok(),
          viewProject: ok(),
        },
        '../../services/authService': ensureRoleStub,
      },
      endpoints: [
        { method: 'get', path: '/projects' },
        { method: 'get', path: '/project/read/abc' },
      ],
    },
    {
      module: '../mongoose/routes/quotes',
      stubs: {
        '../controllers/quotesController': {
          listQuotes: ok(),
          viewQuote: ok(),
        },
        '../../services/authService': ensureRoleStub,
      },
      endpoints: [
        { method: 'get', path: '/quotes' },
        { method: 'get', path: '/quote/read/abc' },
      ],
    },
    {
      module: '../mongoose/routes/receipts',
      stubs: {
        '../controllers/receiptsListController': {
          listReceipts: ok(),
          viewReceipt: ok(),
          changeReceipts: ok(),
        },
        '../../services/authService': ensureRoleStub,
      },
      endpoints: [
        { method: 'get', path: '/receipts' },
        { method: 'get', path: '/receipt/read/abc' },
        { method: 'post', path: '/receipt/change' },
      ],
    },
    {
      module: '../mongoose/routes/register',
      stubs: {
        '../controllers/registerController': {
          renderRegistrationForm: ok(),
          registerUser: ok(),
        },
        '../../services/authService': ensureRoleStub,
      },
      endpoints: [
        { method: 'get', path: '/user/register' },
        { method: 'post', path: '/user/register' },
      ],
    },
    {
      module: '../mongoose/routes/settings',
      stubs: {
        '../controllers/settingsController': {
          getProfilePage: ok(),
          getAccountPage: ok(),
          updateAccountSettings: ok(),
          logoutSession: ok(),
          validateAccountSettings: [(req, res, next) => next()],
        },
        '../../services/authService': ensureRoleStub,
      },
      endpoints: [
        { method: 'get', path: '/user/profile' },
        { method: 'get', path: '/user/account' },
        { method: 'post', path: '/user/account/settings' },
        { method: 'post', path: '/user/account/logout-session' },
      ],
    },
    {
      module: '../mongoose/routes/suppliers',
      stubs: {
        '../controllers/suppliersController': {
          listSuppliers: ok(),
          viewSupplier: ok(),
          renderChangeSupplierForm: ok(),
          changeSupplier: ok(),
        },
        '../../services/authService': ensureRoleStub,
      },
      endpoints: [
        { method: 'get', path: '/suppliers' },
        { method: 'get', path: '/supplier/read/abc' },
        { method: 'get', path: '/supplier/change/abc' },
        { method: 'post', path: '/supplier/change/abc' },
      ],
    },
    {
      module: '../mongoose/routes/tasks',
      stubs: {
        '../controllers/tasksController': {
          renderCreateTaskForm: ok(),
          createTask: ok(),
        },
        '../../services/authService': ensureRoleStub,
      },
      endpoints: [
        { method: 'get', path: '/task/create' },
        { method: 'post', path: '/task/create' },
      ],
    },
    {
      module: '../mongoose/routes/twoFA',
      stubs: {
        '../controllers/twoFAController': {
          render2FAPage: ok(),
          verify2FA: ok(),
        },
        '../../services/authService': ensureRoleStub,
      },
      endpoints: [
        { method: 'get', path: '/user/2fa' },
        { method: 'post', path: '/user/2fa' },
      ],
    },
    {
      module: '../mongoose/routes/userCrud',
      stubs: {
        '../controllers/userCRUDController': {
          createUser: ok(),
          readUser: ok(),
          updateUser: ok(),
          deleteUser: ok(),
        },
        '../../services/authService': ensureRoleStub,
      },
      endpoints: [
        { method: 'post', path: '/user/create' },
        { method: 'get', path: '/user/read/abc' },
        { method: 'post', path: '/user/update/abc' },
        { method: 'post', path: '/user/delete/abc' },
      ],
    },
    {
      module: '../mongoose/routes/weeklyAttendance',
      stubs: {
        '../controllers/weeklyAttendanceController': {
          getWeeklyAttendance: ok(),
        },
        '../../services/taxService': { getCurrentTaxYear: () => '2020' },
        '../../services/authService': ensureRoleStub,
      },
      endpoints: [
        { method: 'get', path: '/attendance/weekly', expected: 302 },
        { method: 'get', path: '/attendance/weekly/2020/1' },
      ],
    },
    {
      module: '../mongoose/routes/yearlyReturns',
      stubs: {
        '../controllers/yearlyReturnsController': { renderYearlyReturns: ok() },
        '../../services/authService': ensureRoleStub,
      },
      endpoints: [
        { method: 'get', path: '/yearly/returns/2020/abc' },
      ],
    },
  ];

  configs.forEach(({ module, stubs, endpoints }) => {
    describe(module, function () {
      const router = proxyquire(module, stubs);
      const app = createApp(router);
      endpoints.forEach(({ method, path, expected = 200 }) => {
        it(`${method.toUpperCase()} ${path} should return ${expected}`, function (done) {
          request(app)[method](path).expect(expected, done);
        });
      });
    });
  });
});
