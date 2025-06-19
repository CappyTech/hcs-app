const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function createApp(router) {
  const app = express();
  // minimal flash stub so controllers can call req.flash without error
  app.use((req, res, next) => {
    req.flash = () => {};
    next();
  });
  app.use(express.urlencoded({ extended: false }));
  app.use(router);
  return app;
}

describe('Error handling and edge cases', function () {
  const ensureRoleStub = { ensureRole: () => (req, res, next) => next() };

  it('GET /mdb/CIS/2020/13 should return 400 for invalid month', function (done) {
    const cisRouter = proxyquire('../mongoose/routes/cis', {
      '../controllers/cisController': require('../mongoose/controllers/cisController'),
      '../../services/authService': ensureRoleStub,
    });

    const app = createApp(cisRouter);
    request(app)
      .get('/mdb/CIS/2020/13')
      .expect(400, done);
  });

  it('POST /user/login without token should redirect with 302', function (done) {
    const loginRouter = proxyquire('../mongoose/routes/login', {
      '../controllers/loginController': require('../mongoose/controllers/loginController'),
      '../../services/authService': ensureRoleStub,
    });

    const app = createApp(loginRouter);
    request(app)
      .post('/user/login')
      .send({ usernameOrEmail: 'user', password: 'pass' })
      .expect('Location', '/user/login')
      .expect(302, done);
  });
});
