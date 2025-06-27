const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();

let findOneStub;
let decryptStub;
let verifyStub;

const controller = proxyquire('../mongoose/controllers/twoFAController', {
  '../services/mongooseDatabaseService': { user: { findOne: (...args) => findOneStub(...args) } },
  '../../services/encryptionService': { decrypt: (...args) => decryptStub(...args) },
  'speakeasy': { totp: { verify: (...args) => verifyStub(...args) } },
  '../../services/loggerService': { error: () => {} }
});

describe('twoFAController.verify2FA', () => {
  function makeRes() {
    return {
      url: null,
      flashCalled: false,
      redirect(url){ this.url = url; },
      flash(){ this.flashCalled = true; }
    };
  }

  it('logs user in with valid code', async () => {
    findOneStub = async () => ({
      _id: { toString: () => 'id1' },
      uuid: 'abc',
      username: 'name',
      email: 'e@e.com',
      role: 'admin',
      permissions: {},
      totpSecret: 'enc'
    });
    decryptStub = () => 'secret';
    verifyStub = () => true;

    const req = {
      body: { totpToken: '123' },
      session: { userPending2FA: { uuid: 'abc', username: 'name', role: 'admin', permissions: {} } },
      useragent: {},
      ip: '1.2.3.4'
    };
    req.flash = () => {};
    req.session.save = cb => cb();

    const res = makeRes();

    await controller.verify2FA(req, res);
    expect(req.session.user).to.include({ uuid: 'abc', username: 'name' });
    expect(req.session.userPending2FA).to.be.undefined;
    expect(res.url).to.equal('/');
  });

  it('rejects invalid code', async () => {
    findOneStub = async () => ({
      _id: { toString: () => 'id1' },
      uuid: 'abc',
      username: 'name',
      email: 'e@e.com',
      role: 'admin',
      permissions: {},
      totpSecret: 'enc'
    });
    decryptStub = () => 'secret';
    verifyStub = () => false;

    const req = { body: { totpToken: '000' }, session: { userPending2FA: { uuid: 'abc' } } };
    req.flash = () => {};
    const res = makeRes();

    await controller.verify2FA(req, res);
    expect(res.url).to.equal('/user/2fa');
  });

  it('redirects to login when session missing', async () => {
    const req = { body: {}, session: {} };
    req.flash = () => {};
    const res = makeRes();

    await controller.verify2FA(req, res);
    expect(res.url).to.equal('/user/login');
  });
});
