import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import ejs from 'ejs';

/**
 * Bulk delete on INTERNAL list pages: tick records, confirm the count, and
 * each is deleted the way the single delete does it (same route guard, one
 * findOneAndDelete per record, so the audit plugin logs each one).
 */

process.env.ENCRYPTION_KEY ||= 'test-key';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(path.join(root, p)).href).then((m) => m);

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let mdb, svc, crud, routes;

before(async () => {
  mdb = (await imp('mongoose/services/mongooseDatabaseService.js')).default;
  // Register every model on an unopened connection: enough for the controller
  // and router to generate their handlers, without a database.
  for (const ns of ['REST', 'INTERNAL']) {
    const conn = mongoose.createConnection();
    const dir = path.join(root, 'mongoose/models/mongoose', ns);
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
      const { modelName, schema } = (await import(pathToFileURL(path.join(dir, f)).href)).default;
      if (!mdb[ns][modelName]) mdb[ns][modelName] = conn.model(modelName, schema);
    }
  }
  svc = await imp('mongoose/services/bulkDeleteService.js');
  crud = (await imp('mongoose/controllers/CRUDController.js')).default;
  routes = (await imp('mongoose/routes/CRUDRoutes.js')).default;
});

describe('parseBulkUuids', () => {
  it('takes one value or several, drops non-uuids and repeats', () => {
    assert.deepEqual(svc.parseBulkUuids({ uuids: U(1) }).uuids, [U(1)]);
    assert.deepEqual(
      svc.parseBulkUuids({ uuids: [U(1), 'nope', U(2), U(1), { $ne: 1 }] }).uuids,
      [U(1), U(2)],
    );
    assert.deepEqual(svc.parseBulkUuids({}).uuids, []);
  });

  it('flags a batch over the cap', () => {
    const many = Array.from({ length: svc.BULK_DELETE_MAX + 1 }, (_, i) => U(i + 1));
    assert.equal(svc.parseBulkUuids({ uuids: many }).tooMany, true);
    assert.equal(svc.parseBulkUuids({ uuids: many.slice(1) }).tooMany, false);
  });
});

describe('canBulkDelete', () => {
  it('offers it on INTERNAL models with a uuid and an audited delete', () => {
    assert.equal(svc.canBulkDelete('INTERNAL', 'employee', mdb.INTERNAL.employee, {}), true);
    assert.equal(svc.canBulkDelete('INTERNAL', 'vehicle', mdb.INTERNAL.vehicle, {}), true);
  });

  it('never on REST, a denied delete, unaudited or uuid-less collections', () => {
    assert.equal(svc.canBulkDelete('REST', 'supplier', mdb.REST.supplier, {}), false);
    assert.equal(svc.canBulkDelete('INTERNAL', 'employee', mdb.INTERNAL.employee, { deny: ['d'] }), false);
    assert.equal(svc.canBulkDelete('INTERNAL', 'auditLog', mdb.INTERNAL.auditLog, {}), false);
    assert.equal(svc.canBulkDelete('INTERNAL', 'inAppNotification', mdb.INTERNAL.inAppNotification, {}), false);
    assert.equal(svc.canBulkDelete('INTERNAL', 'securityEvent', mdb.INTERNAL.securityEvent, {}), false);
  });

  it('a controller handler exists exactly where it is offered', () => {
    assert.equal(typeof crud.bulkDeleteEmployee, 'function');
    assert.equal(crud.bulkDeleteSupplier, undefined);
    assert.equal(crud.bulkDeleteAuditLog, undefined);
  });
});

describe('recordLabel', () => {
  it('prefers the list link field, then common name fields', () => {
    assert.equal(svc.recordLabel({ title: 'T', name: 'N' }, 'title'), 'T');
    assert.equal(svc.recordLabel({ name: 'N' }, 'title'), 'N');
    assert.equal(svc.recordLabel({ firstName: 'A', lastName: 'B' }), 'A B');
    assert.equal(svc.recordLabel({ uuid: U(1) }), U(1));
  });
});

describe('routes', () => {
  const layer = (method, p) =>
    routes.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]);

  it('registers the confirm page and the delete, both guarded like the single delete', () => {
    for (const model of ['employee', 'vehicle', 'task']) {
      const single = layer('post', `/${model}/:uuid/delete`);
      const bulk = layer('post', `/${model}/bulk-delete`);
      const confirm = layer('post', `/${model}/bulk-delete/confirm`);
      assert.ok(single && bulk && confirm, model);
      assert.equal(bulk.route.stack.length, single.route.stack.length, model);
      assert.equal(confirm.route.stack.length, single.route.stack.length, model);
    }
    assert.equal(layer('post', '/supplier/bulk-delete'), undefined);
  });

  it('refuses people without delete permission on the model', async () => {
    const guards = layer('post', '/vehicle/bulk-delete').route.stack.slice(0, -1).map((s) => s.handle);
    const run = (user) => new Promise((resolve) => {
      const req = { user, path: '/vehicle/bulk-delete', method: 'POST', headers: {}, flash() {} };
      const res = {
        statusCode: 200,
        locals: {},
        status(c) { this.statusCode = c; return this; },
        render() { resolve({ statusCode: this.statusCode }); },
        redirect() { resolve({ statusCode: 302 }); },
        send() { resolve({ statusCode: this.statusCode }); },
        json() { resolve({ statusCode: this.statusCode }); },
      };
      let i = 0;
      const next = (err) => {
        if (err) return resolve({ statusCode: err.statusCode || err.status || 500 });
        const g = guards[i++];
        if (!g) return resolve({ statusCode: 200 });
        g(req, res, next);
      };
      next();
    });
    assert.equal((await run({ role: 'admin', roles: [] })).statusCode, 200);
    assert.notEqual((await run({ role: 'subcontractor', roles: [] })).statusCode, 200);
  });
});

describe('bulk delete handler', () => {
  const Employee = () => mdb.INTERNAL.employee;
  const User = () => mdb.INTERNAL.user;
  let saved;
  const deleted = [];

  before(() => {
    saved = {
      eFind: Employee().find, eDel: Employee().findOneAndDelete,
      uFind: User().find, uDel: User().findOneAndDelete,
    };
    const fakeFind = (filter) => ({
      lean: async () => filter.uuid.$in.filter((u) => u !== U(99)).map((uuid) => ({ uuid, name: `n-${uuid.slice(-2)}` })),
    });
    const fakeDel = async ({ uuid }) => { deleted.push(uuid); return uuid === U(99) ? null : { uuid }; };
    Employee().find = fakeFind; Employee().findOneAndDelete = fakeDel;
    User().find = fakeFind; User().findOneAndDelete = fakeDel;
  });

  after(() => {
    Employee().find = saved.eFind; Employee().findOneAndDelete = saved.eDel;
    User().find = saved.uFind; User().findOneAndDelete = saved.uDel;
  });

  const call = (handler, { path: p, body, user = { role: 'admin', username: 'a' } }) =>
    new Promise((resolve, reject) => {
      const flashes = [];
      const req = { path: p, body, user, flash: (t, m) => flashes.push([t, m]) };
      const res = {
        render: (view, locals) => resolve({ view, locals, flashes }),
        redirect: (to) => resolve({ redirect: to, flashes }),
      };
      handler(req, res, reject);
    });

  it('the first step only shows the confirmation with the count', async () => {
    deleted.length = 0;
    const out = await call(crud.bulkDeleteEmployee, {
      path: '/employee/bulk-delete', body: { uuids: [U(1), U(2), U(99)] },
    });
    assert.match(out.view, /form-bulk-delete$/);
    assert.equal(out.locals.records.length, 2);
    assert.equal(out.locals.missingCount, 1);
    assert.equal(out.locals.formAction, '/employee/bulk-delete/confirm');
    assert.deepEqual(deleted, []);
  });

  it('confirming deletes each record and reports what was gone', async () => {
    deleted.length = 0;
    const out = await call(crud.bulkDeleteEmployee, {
      path: '/employee/bulk-delete/confirm', body: { uuids: [U(1), U(2), U(99)], count: '3' },
    });
    assert.deepEqual(deleted, [U(1), U(2), U(99)]);
    assert.ok(out.redirect);
    assert.ok(out.flashes.some(([t, m]) => t === 'success' && /^2 /.test(m)));
    assert.ok(out.flashes.some(([t, m]) => t === 'error' && /already gone/.test(m)));
  });

  it('deletes nothing when the count does not match the confirmation', async () => {
    deleted.length = 0;
    const out = await call(crud.bulkDeleteEmployee, {
      path: '/employee/bulk-delete/confirm', body: { uuids: [U(1), U(2)], count: '1' },
    });
    assert.deepEqual(deleted, []);
    assert.ok(out.flashes.some(([t]) => t === 'error'));
  });

  it('deletes nothing over the cap or with nothing ticked', async () => {
    deleted.length = 0;
    const many = Array.from({ length: svc.BULK_DELETE_MAX + 1 }, (_, i) => U(i + 1));
    await call(crud.bulkDeleteEmployee, {
      path: '/employee/bulk-delete/confirm', body: { uuids: many, count: String(many.length) },
    });
    await call(crud.bulkDeleteEmployee, { path: '/employee/bulk-delete/confirm', body: {} });
    assert.deepEqual(deleted, []);
  });

  it('never deletes the signed-in person\'s own user account', async () => {
    deleted.length = 0;
    const me = { role: 'admin', username: 'me', uuid: U(5) };
    const page = await call(crud.bulkDeleteUser, {
      path: '/user/bulk-delete', body: { uuids: [U(5), U(6)] }, user: me,
    });
    assert.equal(page.locals.skippedSelf, true);
    assert.deepEqual(page.locals.records.map((r) => r.uuid), [U(6)]);
    await call(crud.bulkDeleteUser, {
      path: '/user/bulk-delete/confirm', body: { uuids: [U(5), U(6)], count: '2' }, user: me,
    });
    assert.deepEqual(deleted, [U(6)]);
  });
});

describe('views', () => {
  const viewsDir = path.join(root, 'mongoose/views/tailwindcss/partials');

  it('the confirmation page states the count and posts it with CSRF', async () => {
    const html = await ejs.renderFile(path.join(viewsDir, 'form-bulk-delete.ejs'), {
      title: 'Delete 2 Employee records',
      records: [{ uuid: U(1), label: 'Ann' }, { uuid: U(2), label: 'Bob' }],
      skippedSelf: false,
      missingCount: 0,
      formAction: '/employee/bulk-delete/confirm',
      cancelUrl: '/employees',
      csrfToken: 'tok',
    });
    assert.match(html, /permanently delete <strong>2<\/strong> records/);
    assert.match(html, /name="_csrf" value="tok"/);
    assert.match(html, /name="count" value="2"/);
    assert.equal((html.match(/name="uuids"/g) || []).length, 2);
    assert.doesNotMatch(html, /<script/);
  });

  it('the list table adds checkboxes only when bulk delete is offered', () => {
    const src = fs.readFileSync(path.join(viewsDir, 'listTable.ejs'), 'utf8');
    assert.match(src, /x-data="bulkSelect"/);
    assert.match(src, /form="bulk-delete-form"/);
    assert.match(src, /canModel\(modelName, 'd'\)/);
    const js = fs.readFileSync(path.join(root, 'public/js/alpine-components.js'), 'utf8');
    assert.match(js, /Alpine\.data\('bulkSelect'/);
  });
});
