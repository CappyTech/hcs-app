const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();
const { expect } = require('chai');

function createApp(router) {
  const app = express();
  app.use(router);
  return app;
}

describe('Authentication and Authorization', function () {
  describe('authService.ensureRoles', function () {
    const authService = require('../services/authService');

    it('returns 401 when no user is present', function (done) {
      const req = {};
      const res = {
        statusCode: 0,
        status(code) { this.statusCode = code; return this; },
        sendCalled: false,
        send(msg) { this.sendCalled = true; this.msg = msg; }
      };
      let nextCalled = false;
      authService.ensureRoles('admin')(req, res, () => { nextCalled = true; });
      expect(res.statusCode).to.equal(401);
      expect(res.msg).to.equal('Unauthorized');
      expect(nextCalled).to.be.false;
      done();
    });

    it('returns 403 when user lacks role', function (done) {
      const req = { user: { role: 'user' } };
      const res = {
        statusCode: 0,
        status(code) { this.statusCode = code; return this; },
        send(msg) { this.msg = msg; }
      };
      let nextCalled = false;
      authService.ensureRoles('admin')(req, res, () => { nextCalled = true; });
      expect(res.statusCode).to.equal(403);
      expect(res.msg).to.equal('Forbidden: Requires one of [admin]');
      expect(nextCalled).to.be.false;
      done();
    });

    it('calls next when role matches', function (done) {
      const req = { user: { role: 'admin' } };
      const res = {};
      let nextCalled = false;
      authService.ensureRoles('admin')(req, res, () => { nextCalled = true; });
      expect(nextCalled).to.be.true;
      done();
    });
  });

  describe('indexRoutes token validation', function () {
    before(function () {
      process.env.FETCH_API_TOKEN = 'token123';
    });

    const router = proxyquire('../mongoose/routes/indexRoutes', {
      '../controllers/indexController': {
        renderIndex: (req, res) => res.send('ok'),
        renderConstructionIndustryScheme: (req, res) => res.send('ok'),
        renderManagement: (req, res) => res.send('ok'),
        renderPayroll: (req, res) => res.send('ok'),
        renderHumanResources: (req, res) => res.send('ok'),
        renderKashflow: (req, res) => res.send('ok'),
        renderCreate: (req, res) => res.send('ok'),
      },
      '../kf/fetchKashFlowDataMongoose': { fetchKashFlowDataMongoose: async () => {} },
      '../../services/loggerService': { error: () => {} },
      '../../services/authService': { ensureRole: () => (req, res, next) => next() },
    });
    const app = createApp(router);

    it('rejects requests without token', function (done) {
      request(app)
        .get('/fetch-kashflow-data-mongoose')
        .expect(403, done);
    });

    it('rejects requests with invalid token', function (done) {
      request(app)
        .get('/fetch-kashflow-data-mongoose?token=wrong')
        .expect(403, done);
    });
  });
});
