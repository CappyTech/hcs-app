import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mongoose from 'mongoose';

/**
 * The generic CRUD layer had two gaps:
 *
 * 1. Routes. CRUDController registers create/read/update/delete for every REST
 *    and INTERNAL model, and CRUDRoutes guarded each action only with the
 *    middleware its config listed. A model with no config (appConfig,
 *    payrollRun, auditLog, …) got 249 routes that every signed-in user could
 *    call. An action with no listed guard now falls back to the RBAC matrix.
 *
 * 2. Fields. The edit form ignored config.readOnly, so uuid, lockout counters,
 *    tokens and sync stamps were editable text boxes, and the update handler
 *    wrote whatever came back.
 */

process.env.ENCRYPTION_KEY ||= 'test-key';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(path.join(root, p)).href).then((m) => m);

let crud, routes, crudConfig;

before(async () => {
  const mdb = (await imp('mongoose/services/mongooseDatabaseService.js')).default;
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
  crud = await imp('mongoose/controllers/CRUDController.js');
  routes = await imp('mongoose/routes/CRUDRoutes.js');
  crudConfig = (await imp('mongoose/config/CRUDControllerConfig.js')).default;
});

describe('generic CRUD routes', () => {
  it('every generated route has a guard before its handler', () => {
    const open = routes.default.stack
      .filter((l) => l.route && l.route.stack.length < 2)
      .map((l) => `${Object.keys(l.route.methods).join(',').toUpperCase()} ${l.route.path}`);
    assert.deepEqual(open, []);
  });

  const call = (guard, user) => new Promise((resolve) => {
    const req = { user, path: '/x' };
    guard(req, {}, (err) => resolve(err || null));
  });

  it('the fallback guard follows the RBAC matrix', async () => {
    const g = routes.defaultModelGuard('payrollRun', 'u');
    assert.equal(await call(g, { role: 'admin' }), null);
    assert.equal((await call(g, { role: 'subcontractor' }))?.statusCode, 403);
    assert.equal((await call(g, { role: 'employee' }))?.statusCode, 403);
    // accountant is granted read on bank models in the matrix
    assert.equal(await call(routes.defaultModelGuard('bankRule', 'r'), { role: 'accountant' }), null);
    assert.equal((await call(routes.defaultModelGuard('bankRule', 'd'), { role: 'accountant' }))?.statusCode, 403);
  });
});

describe('locked fields', () => {
  it('strips flat and nested dot-path fields from a form body', () => {
    const body = {
      uuid: 'x', name: 'kept', loginAttempts: '0',
      contract: { termsType: 'kept', hoursPerWeek: '40' },
      'contract.hoursPerWeek': '40',
    };
    crud.stripFields(body, ['uuid', 'loginAttempts', 'contract.hoursPerWeek', 'customPermissions.models.$*']);
    assert.deepEqual(body, { name: 'kept', contract: { termsType: 'kept' } });
  });

  it('locks system fields on every model, plus each config readOnly and hideFields', () => {
    const locked = crud.lockedFields(crudConfig.user);
    for (const f of ['_id', 'uuid', 'createdAt', 'updatedAt', 'Id', 'syncedAt',
      'loginAttempts', 'lockedUntil', 'notificationToken', 'password', 'roles']) {
      assert.ok(locked.includes(f), `${f} should be locked on user`);
    }
  });

  it('locks app-computed fields on employeeHoliday and vehicle', () => {
    for (const f of ['accruedDays', 'accruedHours', 'takenDays', 'takenHours', 'bankHolidaysCounted', 'carryOverAppliedAt']) {
      assert.ok(crudConfig.employeeHoliday.readOnly.includes(f), f);
    }
    assert.ok(crudConfig.vehicle.readOnly.includes('lastMileageUpdate'));
  });

  it('sessions and sync meta cannot be created or edited through the generic form', () => {
    for (const m of ['session', 'meta']) {
      assert.ok(crudConfig[m].deny.includes('c') && crudConfig[m].deny.includes('u'), m);
    }
  });
});
