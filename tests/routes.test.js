const path = require('path');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire');

describe('Route tests', function () {
  function createApp(router) {
    const app = express();
    app.use(router);
    return app;
  }

  it('GET / should return 200', function (done) {
    const router = proxyquire('../mongoose/routes/indexRoutes', {
      '../controllers/indexController': {
        renderIndex: (req, res) => res.status(200).send('ok'),
        renderConstructionIndustryScheme: (req, res) => res.status(200).send('ok'),
        renderManagement: (req,res)=>res.status(200).send('ok'),
        renderPayroll: (req,res)=>res.status(200).send('ok'),
        renderHumanResources: (req,res)=>res.status(200).send('ok'),
        renderKashflow: (req,res)=>res.status(200).send('ok'),
        renderCreate: (req,res)=>res.status(200).send('ok'),
      },
      '../../services/authService': { ensureRole: () => (req,res,next)=>next() }
    });
    const app = createApp(router);
    request(app)
      .get('/')
      .expect(200, done);
  });

  it('GET /attendance/daily should return 200', function (done) {
    const router = proxyquire('../mongoose/routes/dailyAttendance', {
      '../controllers/dailyAttendanceController': {
        getDailyAttendance: (req, res) => res.status(200).send('ok')
      },
      '../../services/authService': { ensureRole: () => (req,res,next)=>next() }
    });
    const app = createApp(router);
    request(app)
      .get('/attendance/daily')
      .expect(200, done);
  });
});