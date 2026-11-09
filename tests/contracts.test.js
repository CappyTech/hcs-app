import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import ejs from 'ejs';

process.env.ENCRYPTION_KEY ||= 'test-key';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWS = path.join(root, 'mongoose/views/tailwindcss');
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const oid = () => new mongoose.Types.ObjectId();

const chain = (rows) => {
  const c = { select: () => c, sort: () => c, limit: () => c, lean: async () => rows };
  return c;
};

let mdb, crud, helpers, list, safety, config;

before(async () => {
  mdb = (await imp('mongoose/services/mongooseDatabaseService.js')).default;
  // Register every model on an unopened connection, with no database behind it.
  for (const ns of ['REST', 'INTERNAL']) {
    const conn = mongoose.createConnection();
    const dir = path.join(root, 'mongoose/models/mongoose', ns);
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      const { modelName, schema } = (await import(pathToFileURL(path.join(dir, f)).href)).default;
      if (!mdb[ns][modelName]) mdb[ns][modelName] = conn.model(modelName, schema);
      mdb[ns][modelName].find = () => chain([]);
    }
  }
  helpers = await imp('mongoose/controllers/CRUDController.js');
  crud = helpers.default;
  list = await imp('mongoose/controllers/listController.js');
  safety = await imp('mongoose/services/contractSiteSafetyService.js');
  config = (await imp('mongoose/config/CRUDControllerConfig.js')).default.contract;
});

/** Runs a generic create GET and returns what it renders. */
function renderedBy(handler, query = {}) {
  return new Promise((resolve, reject) => {
    handler(
      { method: 'GET', query, user: { role: 'admin' } },
      { render: (view, locals) => resolve({ view, locals }) },
      reject,
    );
  });
}

const renderField = (key, locals) => ejs.renderFile(path.join(VIEWS, 'partials/_formField.ejs'), {
  key, field: locals.schema[key], formData: locals.formData, referenceData: locals.referenceData,
  readOnly: false, showTips: true, config: locals.config, groupPrefix: null,
});

describe('New assignment from a contract page', () => {
  it('opens the form with that contract chosen', async () => {
    const contract = { _id: oid(), uuid: 'c-uuid', title: 'A site' };
    const other = { _id: oid(), uuid: 'other', title: 'Another site' };
    const { contract: Contract } = mdb.INTERNAL;
    const [findOne, find] = [Contract.findOne, Contract.find];
    Contract.findOne = (q) => chain(q.uuid === contract.uuid ? contract : null);
    Contract.find = () => chain([other, contract]);
    try {
      const { locals } = await renderedBy(crud.createAssignment, { contractId: contract.uuid });
      assert.equal(locals.formData.contractId, String(contract._id));
      const html = await renderField('contractId', locals);
      assert.match(html, new RegExp(`<option value="${contract._id}" selected>A site</option>`));
      assert.doesNotMatch(html, new RegExp(`<option value="${other._id}" selected`));
    } finally {
      Object.assign(Contract, { findOne, find });
    }
  });
});

describe('contract form', () => {
  it('has a singular heading, clear labels, the quote, and notes last', async () => {
    const { locals } = await renderedBy(crud.createContract);
    assert.equal(locals.title, 'Create Contract');
    assert.equal(locals.schema.location.label, 'Site or area');
    assert.equal(locals.schema.locationId.label, 'Saved location');
    assert.equal(locals.schema.projectId.label, 'Project');
    assert.equal(locals.schema.quoteId.label, 'Quote');
    const keys = Object.keys(locals.schema).filter((k) => config.fieldOrder.includes(k));
    assert.deepEqual(keys, config.fieldOrder);
    assert.ok(!helpers.lockedFields(locals.config).includes('quoteId'), 'the quote can be saved');
  });

  it('explains an empty site managers picker and offers no +', async () => {
    const { locals } = await renderedBy(crud.createContract);
    const html = await renderField('siteManagers', locals);
    assert.match(html, /Nobody holds the Site Manager or Supervisor job role yet\./);
    assert.match(html, /href="\/users"/);
    assert.doesNotMatch(html, /No options available/);
    assert.doesNotMatch(html, /bi-plus-lg/);
  });

  it('keeps + on other fields', async () => {
    const { locals } = await renderedBy(crud.createContract);
    assert.match(await renderField('locationId', locals), /bi-plus-lg/);
  });

  it('labels a quote by number and customer', () => {
    assert.equal(config.referenceLabelFormat.quoteId({ Number: 7, CustomerName: 'Example' }), 'Quote 7 — Example');
    assert.equal(config.referenceLabelFormat.quoteId({ Number: 7 }), 'Quote 7');
  });

  it('gives notes a multi-line box', async () => {
    const { locals } = await renderedBy(crud.createContract);
    assert.match(await renderField('notes', locals), /<textarea id="notes" name="notes"/);
  });

  it('rejects an end date before the start date', () => {
    const errors = (body) => helpers.formErrors(config, body);
    assert.deepEqual(errors({ startDate: '2026-05-02', endDate: '2026-05-01' }), ['The end date is before the start date.']);
    assert.deepEqual(errors({ startDate: '2026-05-01', endDate: '2026-05-01' }), []);
    assert.deepEqual(errors({ startDate: '2026-05-01' }), []);
  });

  it('clears what was blanked, including the last site manager', () => {
    const cleaned = helpers.applyClearWhenBlank({ title: 'Kept', projectId: 'p' }, config);
    assert.deepEqual(cleaned.siteManagers, []);
    assert.equal(cleaned.quoteId, null);
    assert.equal(cleaned.endDate, null);
    assert.equal(cleaned.projectId, 'p', 'a chosen value stays');
    assert.equal(cleaned.title, 'Kept');
    assert.ok(!('location' in cleaned), 'the required field is never blanked');
  });

  it('leaves models without the setting alone', () => {
    assert.deepEqual(helpers.applyClearWhenBlank({ a: 1 }, {}), { a: 1 });
  });
});

describe('contract page', () => {
  const page = (extra = {}) => ejs.renderFile(path.join(VIEWS, 'contract/read.ejs'), {
    item: { uuid: 'c-uuid', title: 'A site', status: 'In Progress' },
    isAdmin: true, isAuthenticated: true, canUpdate: true, canDelete: true, basePath: 'contract',
    slimDateTime: () => 'a date', csrfToken: 't', assignments: [], siteManagers: [], safety: null,
    ...extra,
  });

  it('links New to the assignment form with this contract', async () => {
    assert.match(await page(), /id="contract-new-assignment" href="\/assignment\/create\?contractId=c-uuid"/);
  });

  it('names the site managers', async () => {
    const html = await page({ siteManagers: [{ uuid: 'u1', username: 'sam' }, { uuid: 'u2', username: 'alex' }] });
    assert.match(html, /<a href="\/user\/read\/u1"[^>]*>sam<\/a>/);
    assert.match(html, />alex<\/a>/);
  });

  it('links names for admins only', async () => {
    const html = await page({ isAdmin: false, canUpdate: false, siteManagers: [{ uuid: 'u1', username: 'sam' }] });
    assert.match(html, /sam/);
    assert.doesNotMatch(html, /\/user\/read\/u1/);
  });

  it('warns when an open contract names nobody, and not when it is finished', async () => {
    assert.match(await page(), /can't see this contract until someone is|can&#39;t see this contract until someone is/);
    assert.doesNotMatch(await page({ item: { uuid: 'x', title: 't', status: 'Completed' } }), /until someone is/);
  });

  it('shows the safety panel with links to this site, only when there is one', async () => {
    assert.doesNotMatch(await page(), /id="contract-safety"/);
    const html = await page({ safety: {
      inductions: { total: 3, unsigned: 1, due: 2 },
      rams: { total: 1, draft: 0, reviewDue: 0, rows: [{ uuid: 'r1', title: 'Lifting', status: 'Approved', version: '2' }] },
      briefings: { total: 4 },
    } });
    assert.match(html, /href="\/inductions\?f_contractId=c-uuid"/);
    assert.match(html, /href="\/rams\?f_contractId=c-uuid"/);
    assert.match(html, /href="\/ramsbriefings\?f_contractId=c-uuid"/);
    assert.match(html, /href="\/rams\/read\/r1"/);
    assert.doesNotMatch(html, /accident/i);
  });
});

describe('site safety figures', () => {
  const contract = { _id: oid() };
  const counting = (n, seen) => ({
    countDocuments: async (f) => { seen.push(f); return n; },
    find: () => chain([{ uuid: 'r1', title: 'A', status: 'Approved' }]),
  });
  const db = (seen = []) => ({ INTERNAL: { induction: counting(2, seen), rams: counting(1, seen), ramsBriefing: counting(5, seen) } });
  const run = (user, d = db(), extra = {}) => safety.siteSafety({ user, ...extra }, contract, d);

  it('counts everything for an admin', async () => {
    const seen = [];
    const out = await run({ _id: oid(), role: 'admin' }, db(seen));
    assert.equal(out.inductions.total, 2);
    assert.equal(out.rams.rows.length, 1);
    assert.equal(out.briefings.total, 5);
    assert.deepEqual(seen[0], { contractId: contract._id });
  });

  it('opens for job roles holding Health & Safety', async () => {
    assert.ok(await run({ _id: oid(), role: 'none', roles: ['healthSafetyAdvisor'] }));
    assert.ok(await run({ _id: oid(), role: 'none', roles: ['contractsManager'] }));
  });

  it('keeps a site role to its own sites', async () => {
    const seen = [];
    const sets = { contractIds: [contract._id], projectIds: [], projectNumbers: [], quoteIds: [], locationIds: [], employeeIds: [], subcontractorIds: [] };
    const out = await run({ _id: oid(), role: 'none', roles: ['siteManager'] }, db(seen), { _projectScope: Promise.resolve(sets) });
    assert.ok(out);
    assert.deepEqual(seen[0], { $and: [{ contractId: contract._id }, { contractId: { $in: [contract._id] } }] });
  });

  it('stays hidden from own-only access and from those with none', async () => {
    assert.equal(await run({ _id: oid(), role: 'employee' }), null);
    assert.equal(await run({ _id: oid(), role: 'subcontractor' }), null);
    assert.equal(await run({ _id: oid(), role: 'none', roles: ['fleetManager'] }), null);
  });
});

describe('contract list', () => {
  const transforms = () => ({ siteManagers: { emptyLabel: (row) => (row.status === 'Completed' ? '' : 'Nobody named') } });

  it('flags open contracts that name nobody', () => {
    assert.equal(list.applyEmptyLabels({ status: 'Planned', siteManagers: [] }, transforms()).siteManagers, 'Nobody named');
    assert.equal(list.applyEmptyLabels({ status: 'Planned', siteManagers: undefined }, transforms()).siteManagers, 'Nobody named');
    assert.equal(list.applyEmptyLabels({ status: 'Completed', siteManagers: [] }, transforms()).siteManagers, '');
    assert.equal(list.applyEmptyLabels({ status: 'Planned', siteManagers: 'sam' }, transforms()).siteManagers, 'sam');
  });

  it('shows site managers in the rows layout, which keeps two plain fields', async () => {
    const order = (await imp('mongoose/config/listControllerConfig.js')).default.contract.fieldOrder;
    assert.equal(order.indexOf('siteManagers'), order.indexOf('endDate') + 1);
  });

  it('counts open contracts with nobody named on the overview', async () => {
    const nodes = (await imp('mongoose/config/overviews/nodes/projects.js')).default;
    const node = nodes.find((n) => n.id === 'contract');
    assert.deepEqual(node.overview.figures.includes('noSiteManager'), true);
    assert.deepEqual(node.figures.noSiteManager.where['siteManagers.0'], { $exists: false });
  });

  it('filters by a record uuid, and an unknown uuid matches nothing', async () => {
    const id = oid();
    const { contract: Contract } = mdb.INTERNAL;
    const findOne = Contract.findOne;
    Contract.findOne = (q) => chain(q.uuid === 'known' ? { _id: id } : null);
    const fc = [{ field: 'contractId', model: 'contract', type: 'ref', label: 'site' }];
    try {
      assert.deepEqual(await list.applyFilterParams({ query: { f_contractId: 'known' } }, fc, {}), { contractId: { $in: [id] } });
      assert.deepEqual(await list.applyFilterParams({ query: { f_contractId: 'nope' } }, fc, {}), { contractId: { $in: [] } });
      assert.deepEqual(await list.applyFilterParams({ query: {} }, fc, {}), {});
      assert.deepEqual(await list.applyFilterParams({ query: { f_contractId: { $ne: 'x' } } }, fc, {}), {}, 'objects are ignored');
    } finally {
      Contract.findOne = findOne;
    }
  });

  it('list table template still compiles', () => {
    const file = path.join(VIEWS, 'partials/listTable.ejs');
    assert.ok(ejs.compile(fs.readFileSync(file, 'utf8'), { filename: file }));
  });
});
