const express = require('express');
const request = require('supertest');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();

let userStub = null;

const controller = proxyquire('../mongoose/controllers/userCRUDController', {
  '../services/mongooseDatabaseService': { user: { findOne: async () => userStub } },
});

function createRouter() {
  const router = express.Router();
  router.get('/user/update/:uuid', controller.renderUpdateUserForm);
  return router;
}

function createApp() {
  const app = express();
  app.use((req, res, next) => {
    req.flash = () => {};
    res.render = (view, options = {}) => {
      res.json({ view, ...options });
    };
    next();
  });
  app.use(createRouter());
  app.use((err, req, res, next) => {
    res.status(500).send(err.message);
  });
  return app;
}

describe('user controller', () => {
  it('renders update form when user exists', async () => {
    userStub = { uuid: 'abc', permissions: '{}' };
    const res = await request(createApp()).get('/user/update/abc').expect(200);
    expect(res.body.view).to.include('updateUser');
    expect(res.body.user.uuid).to.equal('abc');
  });

  it('redirects to /users when user missing', async () => {
    userStub = null;
    const res = await request(createApp()).get('/user/update/missing').expect(302);
    expect(res.headers.location).to.equal('/dashboard/user');
  });
});
