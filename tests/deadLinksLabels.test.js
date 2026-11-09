import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import mongoose from 'mongoose';
import ejs from 'ejs';

process.env.ENCRYPTION_KEY ||= 'test-key';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWS = path.join(root, 'mongoose/views/tailwindcss');
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const chain = (rows) => { const c = { select: () => c, sort: () => c, limit: () => c, lean: async () => rows }; return c; };

let crud, list, listPaths, inventory, listConfig, routes;

before(async () => {
  const mdb = (await imp('mongoose/services/mongooseDatabaseService.js')).default;
  for (const ns of ['REST', 'INTERNAL']) {
    const conn = mongoose.createConnection();
    const dir = path.join(root, 'mongoose/models/mongoose', ns);
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      const { modelName, schema } = (await import(pathToFileURL(path.join(dir, f)).href)).default;
      if (!mdb[ns][modelName]) mdb[ns][modelName] = conn.model(modelName, schema);
      mdb[ns][modelName].find = () => chain([]);
    }
  }
  crud = (await imp('mongoose/controllers/CRUDController.js')).default;
  list = await imp('mongoose/controllers/listController.js');
  listPaths = await imp('mongoose/services/listPathService.js');
  inventory = await imp('services/routeInventoryService.js');
  listConfig = (await imp('mongoose/config/listControllerConfig.js')).default;
  routes = (await imp('mongoose/routes/listRoutes.js')).default;
});

const created = (handler) => new Promise((resolve, reject) => {
  handler({ method: 'GET', query: {}, user: { role: 'admin' } }, { render: (v, l) => resolve(l) }, reject);
});

describe('list addresses', () => {
  it('uses the real address where a plain plural would be wrong', () => {
    assert.equal(listPaths.listPathFor('country'), '/countries');
    assert.equal(listPaths.listPathFor('currency'), '/currencies');
    assert.equal(listPaths.listPathFor('quoteCategory'), '/quotecategories');
    assert.equal(listPaths.listPathFor('rams'), '/rams');
    assert.equal(listPaths.listPathFor('contract'), '/contracts');
  });

  it('handles nested renames and overrides without a slash', () => {
    assert.equal(listPaths.listPathFor('x', { modelRename: 'paperless/ocrDocument' }), '/paperless/ocrdocuments');
    assert.equal(listPaths.listPathFor('x', { pathOverride: 'things' }), '/things');
  });

  it('every configured list has a route at that address', () => {
    const registered = new Set(routes.stack.filter((l) => l.route).map((l) => String(l.route.path).toLowerCase()));
    const missing = Object.keys(listConfig)
      .filter((m) => list.default[`list${m.charAt(0).toUpperCase()}${m.slice(1)}`] && m === m.charAt(0).toLowerCase() + m.slice(1))
      .filter((m) => !registered.has(listPaths.listPathFor(m).toLowerCase()));
    assert.deepEqual(missing, []);
  });

  it('the record page Back link goes there', async () => {
    const html = await ejs.render(read('mongoose/views/tailwindcss/partials/form-read.ejs').split('\n').slice(0, 2).join('\n') + '</div>', { listPath: '/countries', basePath: 'country' });
    assert.match(html, /<a href="\/countries"/);
  });
});

describe('dead links', () => {
  it('sends the subcontractor form back to the suppliers list', () => {
    const src = read('mongoose/views/tailwindcss/supplier/assignSubcontractor.ejs');
    assert.doesNotMatch(src, /href="\/supplier"/);
    assert.equal((src.match(/href="\/suppliers"/g) || []).length, 2);
  });

  it('links vehicles by uuid', () => {
    for (const f of ['attendance/weekly.ejs', 'partials/vehiclesTable-excel.ejs']) {
      const src = fs.readFileSync(path.join(VIEWS, f), 'utf8');
      assert.doesNotMatch(src, /vehicle\/read\/<%= v\._id/, f);
    }
  });

  it('hides Submit Attendance from admins only', async () => {
    const tiles = (await imp('mongoose/config/dashboardTilesConfig.js')).default;
    assert.equal(tiles.SubmitAttendance.hideFromAdmin, true);
    const src = read('mongoose/controllers/indexController.js');
    assert.match(src, /return !tile\?\.hideFromAdmin;/);
  });
});

describe('accessible pages', () => {
  const app = () => {
    const a = express();
    const outer = express.Router();
    const inner = express.Router();
    inner.get('/Reports', (q, s) => s.end());
    inner.get('/thing/:id', (q, s) => s.end());
    inner.post('/purchase/change', (q, s) => s.end());
    outer.use('/', inner);
    outer.get('/help', (q, s) => s.end());
    a.use(outer);
    a.get('/', (q, s) => s.end());
    return a;
  };

  it('keeps GET pages from nested routers and drops form-only and prefix paths', () => {
    assert.deepEqual(
      inventory.onlyPages(['/', '/help', '/reports', '/purchase/change', '/payments'], app()),
      ['/', '/help', '/reports'],
    );
  });

  it('keeps everything when there is no route table', () => {
    assert.deepEqual(inventory.onlyPages(['/a'], {}), ['/a']);
  });
});

describe('labels', () => {
  it('names a link after the record and a stored id as ID', async () => {
    const l = await created(crud.createAttendance);
    assert.equal(l.schema.contractId.label, 'Contract');
    const e = await created(crud.createEmployee);
    const payroll = Object.entries(e.schema).find(([k]) => k.endsWith('payrollId'))[1];
    assert.match(payroll.label, /Payroll ID$/);
    assert.equal(e.schema.managerId.label, 'Manager');
  });

  it('spaces tab names built from stored values', () => {
    assert.equal(list.spaced('CostOfSale'), 'Cost Of Sale');
    assert.equal(list.spaced('Turnover'), 'Turnover');
  });

  it('keeps sync bookkeeping off the nominal and VAT lists', () => {
    for (const m of ['nominal', 'vatrate']) {
      for (const f of ['createdByRunId', 'syncedAt', 'lastSeenRun', 'deletedAt', 'DeletedAt']) {
        assert.ok(listConfig[m].hideFields.includes(f), `${m}.${f}`);
      }
    }
  });

  it('says 1 day and 1 hour', () => {
    const src = fs.readFileSync(path.join(VIEWS, 'attendance/weekly.ejs'), 'utf8');
    assert.match(src, /Number\(totalSubcontractorDays\) === 1 \? '' : 's'/);
    assert.match(src, /Number\(totalEmployeeHours\) === 1 \? '' : 's'/);
  });
});
