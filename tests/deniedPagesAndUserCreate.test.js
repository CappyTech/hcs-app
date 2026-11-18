// Found by testing every role against a fresh database:
//  1. A second user without a phone number couldn't be created (E11000 on
//     phoneNumber: null in the sparse unique index).
//  2. A 403 from the global route guard rendered the error page before the
//     template locals were set, so it showed "The application is starting".
//  3. An own-records list for a user linked to no record rendered a missing
//     view (500 instead of 403).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import mongoose from 'mongoose';
// The user model reaches encryptionService, which needs a key at load time
if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = 'test-key-for-denied-pages-unit-tests-32ch';
}
// Dynamic imports so the env assignment above runs first (static imports hoist).
const { default: mdb } = await import('../mongoose/services/mongooseDatabaseService.js');
const { default: userModel, blankToUndefined } = await import('../mongoose/models/mongoose/INTERNAL/user.js');
const { default: phoneCleanup, BLANK_PHONE_FILTER } = await import('../mongoose/services/userPhoneCleanup.js');
const { default: errorHandlerService } = await import('../services/errorHandlerService.js');

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('User phone number', () => {
  const User = mongoose.models.UserPhoneTest || mongoose.model('UserPhoneTest', userModel.schema);

  it('stores a blank number as no field, so the sparse index skips it', () => {
    for (const v of [null, undefined, '', '   ']) {
      const doc = new User({ username: 'a', email: 'a@example.test', password: 'x', phoneNumber: v }).toObject();
      assert.equal('phoneNumber' in doc, false, `${JSON.stringify(v)} is not stored`);
    }
    const doc = new User({ username: 'a', email: 'a@example.test', password: 'x', phoneNumber: ' 07700 900123 ' }).toObject();
    assert.equal(doc.phoneNumber, '07700 900123');
  });

  it('has no null default and keeps the sparse unique index', () => {
    const path = userModel.schema.path('phoneNumber');
    assert.equal(path.defaultValue, undefined);
    assert.equal(path.options.unique, true);
    assert.equal(path.options.sparse, true);
    assert.equal(blankToUndefined(null), undefined);
    assert.equal(blankToUndefined('x'), 'x');
  });

  describe('start-up clean-up', () => {
    let saved; let calls;
    before(() => {
      saved = mdb.INTERNAL;
      mdb.INTERNAL = {
        user: { collection: { updateMany: async (filter, update) => { calls.push({ filter, update }); return { modifiedCount: 1 }; } } },
      };
    });
    after(() => { mdb.INTERNAL = saved; });

    it('unsets stored null or empty numbers only', async () => {
      calls = [];
      assert.equal(await phoneCleanup.unsetBlankPhoneNumbers(), 1);
      assert.deepEqual(calls, [{ filter: BLANK_PHONE_FILTER, update: { $unset: { phoneNumber: '' } } }]);
      assert.deepEqual(BLANK_PHONE_FILTER, { $and: [{ phoneNumber: { $exists: true } }, { phoneNumber: { $in: [null, ''] } }] });
    });
  });
});

describe('Access denied pages', () => {
  it('sets the template locals before the global route guard', () => {
    const app = read('../app.js');
    const locals = app.indexOf('res.locals.package = packageJson.version');
    const guard = app.indexOf('appRouter.use(authService.ensureRouteAccess)');
    const auth = app.indexOf('appRouter.use(authService.ensureAuthenticated)');
    assert.ok(locals > 0 && guard > 0 && auth > 0);
    assert.ok(auth < locals && locals < guard, 'ensureAuthenticated → view locals → ensureRouteAccess');
  });

  it('a 403 whose page fails to render is still a 403, never the start-up page', () => {
    const sent = {};
    const req = { originalUrl: '/daily', method: 'GET', headers: {}, ip: '127.0.0.1', session: {} };
    const res = {
      locals: {},
      status(c) { sent.status = c; return this; },
      set() { return this; },
      type(t) { sent.type = t; return this; },
      send(b) { sent.body = b; return this; },
      render(_view, _locals, cb) { cb(new Error('package is not defined')); },
    };
    let nexted = false;
    errorHandlerService({ statusCode: 403, name: 'ForbiddenError', message: 'You do not have permission to access this page.' }, req, res, () => { nexted = true; });
    assert.equal(nexted, false);
    assert.equal(sent.status, 403);
    assert.equal(sent.type, 'text/plain');
    assert.match(sent.body, /^403 - ForbiddenError: You do not have permission/);
  });

  it('no controller renders the old mongoose/ views', () => {
    const dir = new URL('../mongoose/controllers/', import.meta.url);
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      const src = fs.readFileSync(new URL(f, dir), 'utf8');
      assert.doesNotMatch(src, /path\.join\(\s*["']mongoose["']\s*,\s*["']error["']\s*\)/, `${f} renders mongoose/error`);
    }
  });
});
