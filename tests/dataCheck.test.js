import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';

process.env.ENCRYPTION_KEY ||= 'test-key';

const { runCheck, UUID_V4 } = await import('../mongoose/services/dataCheckService.js');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOOD = '3f2b8c1e-4a5d-4e6f-8a7b-1c2d3e4f5a6b';

function model({ docs = [], dupes = [], paths = ['uuid'], fail = false, seen = [] } = {}) {
  return {
    schema: { path: (p) => paths.includes(p) },
    collection: {
      countDocuments: async (f, o) => { if (fail) throw new Error('timed out'); seen.push({ f, o }); return docs.length; },
      find: (f, o) => { seen.push({ f, o }); return { toArray: async () => docs }; },
      aggregate: () => ({ toArray: async () => dupes }),
    },
  };
}

describe('data check', () => {
  it('lists records whose id is wrong or missing, labelled readably', async () => {
    const db = { REST: { invoice: model({ docs: [{ _id: 'a', uuid: 'odd:1', Number: 7 }, { _id: 'b', Name: 'No id' }] }) } };
    const out = await runCheck(db);
    assert.equal(out.checked, 1);
    assert.equal(out.total, 2);
    assert.deepEqual(out.problems[0].records, [{ label: '7', uuid: 'odd:1' }, { label: 'No id', uuid: null }]);
    assert.equal(out.problems[0].listPath, '/invoices');
  });

  it('falls back to the database id for records with no label fields', async () => {
    const out = await runCheck({ INTERNAL: { thing: model({ docs: [{ _id: 'x1', uuid: 'odd' }] }) } });
    assert.equal(out.problems[0].records[0].label, 'x1');
  });

  it('reports ids shared by more than one record', async () => {
    const out = await runCheck({ INTERNAL: { thing: model({ dupes: [{ _id: GOOD, count: 2 }] }) } });
    assert.deepEqual(out.problems[0].duplicates, [{ uuid: GOOD, count: 2 }]);
    assert.equal(out.total, 1);
  });

  it('ignores soft-deleted records where the model has them', async () => {
    const seen = [];
    await runCheck({ REST: { a: model({ paths: ['uuid', 'deletedAt'], seen }) } });
    assert.equal(seen[0].f.deletedAt, null);
    const plain = [];
    await runCheck({ REST: { a: model({ seen: plain }) } });
    assert.ok(!('deletedAt' in plain[0].f));
  });

  it('skips models with no uuid and things that are not models', async () => {
    const out = await runCheck({ REST: { connection: {}, noId: model({ paths: [], docs: [{ _id: 1 }] }) } });
    assert.equal(out.checked, 0);
    assert.deepEqual(out.problems, []);
  });

  it('never reads a failed scan as all clear', async () => {
    const out = await runCheck({ REST: { slow: model({ fail: true }), fine: model() } });
    assert.equal(out.checked, 1);
    assert.deepEqual(out.failed.map((f) => f.model), ['slow']);
  });

  it('accepts what record pages accept', () => {
    assert.ok(UUID_V4.test(GOOD));
    for (const bad of ['record:1', '', '3f2b8c1e-4a5d-1e6f-8a7b-1c2d3e4f5a6b']) assert.ok(!UUID_V4.test(bad), bad);
    assert.match(fs.readFileSync(path.join(root, 'mongoose/routes/CRUDRoutes.js'), 'utf8'), /UUID_V4\.test\(uuid\)/);
  });
});

describe('data check page', () => {
  const file = path.join(root, 'mongoose/views/tailwindcss/admin/dataCheck.ejs');
  const render = (result) => ejs.renderFile(file, { result });

  it('says when all is clear', async () => {
    const html = await render({ checked: 40, problems: [], failed: [], total: 0 });
    assert.match(html, /id="data-check-clear"/);
    assert.match(html, /40 kinds of record/);
  });

  it('shows problems and escapes stored values', async () => {
    const html = await render({ checked: 3, failed: [], total: 1, problems: [
      { title: 'Invoices', listPath: '/invoices', count: 1, records: [{ label: '<b>7</b>', uuid: 'odd:1' }], duplicates: [] },
    ] });
    assert.match(html, /odd:1/);
    assert.match(html, /&lt;b&gt;7/);
    assert.doesNotMatch(html, /data-check-clear/);
  });

  it('warns when the check was incomplete, even with nothing found', async () => {
    const html = await render({ checked: 3, failed: [{ model: 'slow' }], problems: [], total: 0 });
    assert.match(html, /id="data-check-failed"/);
    assert.match(html, /slow/);
  });

  it('is admin only', async () => {
    const rbac = (await import('../mongoose/config/rolePermissionsConfig.js')).default;
    assert.deepEqual(rbac.routeAccess['/admin/data-check'], ['admin']);
    assert.match(fs.readFileSync(path.join(root, 'mongoose/routes/dataCheckRoutes.js'), 'utf8'), /ensureRole\('admin'\)/);
  });
});
