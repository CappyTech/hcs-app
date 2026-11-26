import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import passkeys, { cleanName, takeChallenge, relyingParty, hasPasskeys, CHALLENGE_TTL_MS } from '../services/passkeyService.js';

// ── A tiny software authenticator (ES256, "none" attestation) ────────────────
// Enough CBOR to build an attestation object and a COSE public key.

function cborBytes(buf) {
  const b = Buffer.from(buf);
  if (b.length < 24) return Buffer.concat([Buffer.from([0x40 + b.length]), b]);
  if (b.length < 256) return Buffer.concat([Buffer.from([0x58, b.length]), b]);
  return Buffer.concat([Buffer.from([0x59, b.length >> 8, b.length & 0xff]), b]);
}
function cborText(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from([0x60 + b.length]), b]);
}
function cborInt(n) {
  return Buffer.from([n >= 0 ? n : 0x20 + (-1 - n)]);
}

function makeAuthenticator(rpID) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = crypto.randomBytes(16);
  const rpIdHash = crypto.createHash('sha256').update(rpID).digest();
  let counter = 0;

  const coseKey = Buffer.concat([
    Buffer.from([0xa5]),
    cborInt(1), cborInt(2), // kty: EC2
    cborInt(3), cborInt(-7), // alg: ES256
    cborInt(-1), cborInt(1), // crv: P-256
    cborInt(-2), cborBytes(Buffer.from(jwk.x, 'base64url')),
    cborInt(-3), cborBytes(Buffer.from(jwk.y, 'base64url')),
  ]);

  function counterBytes() {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter);
    return c;
  }

  function clientData(type, challenge, origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  return {
    id: credId.toString('base64url'),
    register(options, origin) {
      const authData = Buffer.concat([
        rpIdHash,
        Buffer.from([0x45]), // UP | UV | AT
        counterBytes(),
        Buffer.alloc(16), // AAGUID
        Buffer.from([0, credId.length]),
        credId,
        coseKey,
      ]);
      const attObj = Buffer.concat([
        Buffer.from([0xa3]),
        cborText('fmt'), cborText('none'),
        cborText('attStmt'), Buffer.from([0xa0]),
        cborText('authData'), cborBytes(authData),
      ]);
      return {
        id: credId.toString('base64url'),
        rawId: credId.toString('base64url'),
        type: 'public-key',
        response: {
          clientDataJSON: clientData('webauthn.create', options.challenge, origin).toString('base64url'),
          attestationObject: attObj.toString('base64url'),
          transports: ['internal'],
        },
        clientExtensionResults: {},
      };
    },
    assert(options, origin, { flags = 0x05 } = {}) {
      counter += 1;
      const authData = Buffer.concat([rpIdHash, Buffer.from([flags]), counterBytes()]);
      const cdj = clientData('webauthn.get', options.challenge, origin);
      const sig = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(cdj).digest()]), privateKey);
      return {
        id: credId.toString('base64url'),
        rawId: credId.toString('base64url'),
        type: 'public-key',
        response: {
          clientDataJSON: cdj.toString('base64url'),
          authenticatorData: authData.toString('base64url'),
          signature: sig.toString('base64url'),
        },
        clientExtensionResults: {},
      };
    },
  };
}

function fakeReq({ host = 'app.example.test', protocol = 'https' } = {}) {
  return {
    hostname: host.split(':')[0],
    protocol,
    session: {},
    get: (h) => (h.toLowerCase() === 'host' ? host : undefined),
  };
}

function fakeUser() {
  return { _id: 'u1', uuid: '11111111-2222-3333-4444-555555555555', username: 'tester', email: 't@example.test', passkeys: [] };
}

let savedBaseUrl;
beforeEach(() => { savedBaseUrl = process.env.BASE_URL; delete process.env.BASE_URL; });
afterEach(() => { if (savedBaseUrl === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = savedBaseUrl; });

describe('passkeyService helpers', () => {
  it('cleanName trims, collapses whitespace, strips control characters and bounds length', () => {
    assert.equal(cleanName('  Work\n laptop\t '), 'Work laptop');
    assert.equal(cleanName(''), 'Passkey');
    assert.equal(cleanName(null), 'Passkey');
    assert.equal(cleanName('x'.repeat(200)).length, 60);
  });

  it('hasPasskeys only for a non-empty array', () => {
    assert.equal(hasPasskeys(null), false);
    assert.equal(hasPasskeys({ passkeys: [] }), false);
    assert.equal(hasPasskeys({ passkeys: [{}] }), true);
  });

  it('takeChallenge is one-use and expires', () => {
    const req = { session: { k: { challenge: 'abc', at: 1000 } } };
    assert.equal(takeChallenge(req, 'k', 1000 + CHALLENGE_TTL_MS + 1), null);
    assert.equal(req.session.k, undefined);
    req.session.k = { challenge: 'abc', at: 1000 };
    assert.equal(takeChallenge(req, 'k', 2000).challenge, 'abc');
    assert.equal(takeChallenge(req, 'k', 2000), null);
  });

  it('relyingParty follows BASE_URL, else the request host', () => {
    assert.deepEqual(relyingParty(fakeReq({ host: 'localhost:3000', protocol: 'http' })).origins, ['http://localhost:3000']);
    assert.equal(relyingParty(fakeReq({ host: 'localhost:3000' })).rpID, 'localhost');
    process.env.BASE_URL = 'https://app.example.test';
    const rp = relyingParty(fakeReq({ host: 'evil.example.test' }));
    assert.equal(rp.rpID, 'app.example.test');
    assert.deepEqual(rp.origins, ['https://app.example.test']);
  });
});

describe('passkeyService register → sign in', () => {
  const origin = 'https://app.example.test';

  async function registered() {
    const req = fakeReq();
    const user = fakeUser();
    const auth = makeAuthenticator('app.example.test');
    const opts = await passkeys.registrationOptions(req, user);
    assert.equal(opts.authenticatorSelection.userVerification, 'required');
    const record = await passkeys.verifyRegistration(req, user, auth.register(opts, origin), ' Laptop ');
    user.passkeys.push(record);
    return { req, user, auth, record };
  }

  it('adds a passkey and stores only public data', async () => {
    const { record, auth } = await registered();
    assert.equal(record.credentialId, auth.id);
    assert.equal(record.name, 'Laptop');
    assert.equal(typeof record.publicKey, 'string');
    assert.deepEqual(record.transports, ['internal']);
  });

  it('refuses a registration replay (challenge is one-use)', async () => {
    const req = fakeReq();
    const user = fakeUser();
    const auth = makeAuthenticator('app.example.test');
    const opts = await passkeys.registrationOptions(req, user);
    const response = auth.register(opts, origin);
    await passkeys.verifyRegistration(req, user, response, 'a');
    await assert.rejects(() => passkeys.verifyRegistration(req, user, response, 'a'), /expired/);
  });

  it('refuses a registration from another origin', async () => {
    const req = fakeReq();
    const user = fakeUser();
    const auth = makeAuthenticator('app.example.test');
    const opts = await passkeys.registrationOptions(req, user);
    await assert.rejects(() => passkeys.verifyRegistration(req, user, auth.register(opts, 'https://phish.test'), 'a'));
  });

  it('signs in without a username and moves the counter on', async () => {
    const { req, user, auth } = await registered();
    const opts = await passkeys.authenticationOptions(req, { key: 'passkeyLogin' });
    assert.deepEqual(opts.allowCredentials, []);
    const out = await passkeys.verifyAuthentication(req, {
      key: 'passkeyLogin',
      response: auth.assert(opts, origin),
      findUser: async (id) => (id === auth.id ? user : null),
    });
    assert.equal(out.user, user);
    assert.equal(out.passkey.counter, 1);
    assert.ok(out.passkey.lastUsedAt instanceof Date);
  });

  it('refuses an assertion without user verification', async () => {
    const { req, user, auth } = await registered();
    const opts = await passkeys.authenticationOptions(req, { key: 'passkeyLogin' });
    await assert.rejects(() => passkeys.verifyAuthentication(req, {
      key: 'passkeyLogin',
      response: auth.assert(opts, origin, { flags: 0x01 }),
      findUser: async () => user,
    }));
  });

  it('at the 2FA step, only that account\'s passkey is accepted', async () => {
    const { req, user, auth } = await registered();
    const opts = await passkeys.authenticationOptions(req, { key: 'passkey2FA', user });
    assert.equal(opts.allowCredentials.length, 1);
    const other = { ...fakeUser(), _id: 'u2', passkeys: user.passkeys };
    await assert.rejects(() => passkeys.verifyAuthentication(req, {
      key: 'passkey2FA',
      response: auth.assert(opts, origin),
      findUser: async () => other,
    }), /different account/);
  });

  it('keeps the autofill and button challenges apart', async () => {
    const { req, user, auth } = await registered();
    const autofillOpts = await passkeys.authenticationOptions(req, { key: 'passkeyAutofill' });
    const buttonOpts = await passkeys.authenticationOptions(req, { key: 'passkeyLogin' });
    assert.notEqual(autofillOpts.challenge, buttonOpts.challenge);
    // The autofill answer still verifies after the button asked for its own challenge…
    const out = await passkeys.verifyAuthentication(req, {
      key: 'passkeyAutofill', response: auth.assert(autofillOpts, origin), findUser: async () => user,
    });
    assert.equal(out.user, user);
    // …and an answer to one challenge is refused under the other key.
    await assert.rejects(() => passkeys.verifyAuthentication(req, {
      key: 'passkeyLogin', response: auth.assert(autofillOpts, origin), findUser: async () => user,
    }));
  });

  it('refuses an unknown credential', async () => {
    const { req, auth } = await registered();
    const opts = await passkeys.authenticationOptions(req, { key: 'passkeyLogin' });
    await assert.rejects(() => passkeys.verifyAuthentication(req, {
      key: 'passkeyLogin',
      response: auth.assert(opts, origin),
      findUser: async () => null,
    }), /not registered/);
  });
});
