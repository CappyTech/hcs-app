const express = require('express');
const request = require('supertest');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();

let userStub = null;

const stubs = {
  '../../services/sequelizeDatabaseService': {
    Users: {
      findByPk: async () => userStub,
    },
  },
  '../../services/authService': {
    ensureRole: () => (req, res, next) => next(),
  },
  '../../services/loggerService': { error: () => {}, info: () => {} },
  '../../models/sequelize/user': { rolePermissions: {} },
};

const router = proxyquire('../controllers/forms/user.js', stubs);

function createApp() {
  const app = express();
  app.use((req, res, next) => {
    req.flash = () => {};
    res.render = (view, options = {}) => {
      res.json({ view, ...options });
    };
    next();
  });
  app.use(router);
  app.use((err, req, res, next) => {
    res.status(500).send(err.message);
  });
  return app;
}

describe('user controller', () => {
  it('renders update form when user exists', async () => {
    userStub = { id: 'abc', permissions: '{}' };
    const res = await request(createApp()).get('/update/abc').expect(200);
    expect(res.body.view).to.include('updateUser');
    expect(res.body.user.id).to.equal('abc');
  });

  it('redirects to /users when user missing', async () => {
    userStub = null;
    const res = await request(createApp()).get('/update/missing').expect(302);
    expect(res.headers.location).to.equal('/users');
  });
});
