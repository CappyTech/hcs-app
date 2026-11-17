import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reshapeRow, migrateRowsToJobs, OLD_FIELDS } from '../mongoose/services/jobRegisterMigration.js';
import { stageOf, jobValues } from '../mongoose/services/jobRegisterService.js';

/*
 * Job Register rows → jobs. The database is a fake collection: find(filter)
 * .toArray(), updateOne($set/$unset, only while the filter's old fields are
 * still there), dropIndex and createIndexes.
 */
const d = (s) => new Date(`${s}T12:00:00Z`);
let n = 0;
const ids = () => `id${++n}`;

// The kinds of old row (made-up numbers)
const enquiry = { _id: 'r1', uuid: 'u1', quoteNumber: 51001, quoteDate: d('2026-01-05'), quoteStatus: 'toQuote', site: 'A', client: 'C', value: 500, description: 'Paving' };
const quoted = { _id: 'r2', uuid: 'u2', quoteNumber: 51002, quoteStatus: 'quoted', site: 'B', client: 'C', value: 300 };
const wonNoProject = { _id: 'r3', uuid: 'u3', quoteNumber: 51003, quoteStatus: 'quoted', won: true, site: 'C', client: 'C', value: 900, quoteSentAt: d('2026-02-01'), quoteSendingAt: d('2026-02-01') };
const live = { _id: 'r4', uuid: 'u4', quoteNumber: 51004, projectNumber: 41004, jobDate: d('2026-03-01'), site: 'D', client: 'C', value: 1200 };
const invoiced = { _id: 'r5', uuid: 'u5', quoteNumber: 51005, projectNumber: 41005, site: 'E', client: 'C', value: 750, invoiceNumber: 1622, invoiceDate: d('2026-04-10') };
const jobOnly = { _id: 'r6', uuid: 'u6', projectNumber: 41006, site: 'F', client: 'C', value: 600, invoiceNumber: 1700 };
const jobOnlyLive = { _id: 'r7', uuid: 'u7', projectNumber: 41007, site: 'G', client: 'C', value: 400, quoteStatus: 'quoted' };
const alreadyJob = { _id: 'r8', uuid: 'u8', projectNumber: 41008, site: 'H', client: 'C', quotes: [{ _id: 'x', number: 51008, status: 'won' }], invoices: [] };
const noStatus = { _id: 'r9', uuid: 'u9', quoteNumber: 51009, site: 'I', client: 'C' };

describe('Reshaping one row', () => {
  it('a quote on its own becomes a job with one quote, carrying its status, value and description', () => {
    const r = reshapeRow(enquiry, ids);
    assert.deepEqual(r.set.quotes, [{ _id: r.set.quotes[0]._id, number: 51001, date: d('2026-01-05'), value: 500, description: 'Paving', status: 'toQuote' }]);
    assert.deepEqual(r.set.invoices, []);
    assert.equal(r.set.completed, undefined);
    assert.deepEqual(Object.keys(r.unset).sort(), ['quoteDate', 'quoteNumber', 'quoteStatus', 'value']);
    assert.equal(reshapeRow(quoted, ids).set.quotes[0].status, 'quoted');
    assert.equal(reshapeRow(noStatus, ids).set.quotes[0].status, 'quoted', 'no colour: quoted');
  });

  it('a won quote (marked, or with a project number) is won; its KashFlow send moves onto the quote', () => {
    const w = reshapeRow(wonNoProject, ids);
    assert.equal(w.set.quotes[0].status, 'won');
    assert.deepEqual(w.set.quotes[0].sentAt, d('2026-02-01'));
    assert.ok('quoteSentAt' in w.unset && 'quoteSendingAt' in w.unset);
    assert.equal(w.set.quotes[0].sendingAt, undefined, 'an in-flight claim is dropped');
    assert.equal(reshapeRow(live, ids).set.quotes[0].status, 'won');
  });

  it('an invoiced row gets its invoice and is completed', () => {
    const r = reshapeRow(invoiced, ids);
    assert.deepEqual(r.set.invoices, [{ _id: r.set.invoices[0]._id, number: 1622, date: d('2026-04-10') }]);
    assert.equal(r.set.completed, true);
    assert.equal(r.set.quotes[0].value, 750);
    assert.ok('invoiceNumber' in r.unset && 'invoiceDate' in r.unset && 'value' in r.unset);
  });

  it('a job-only row keeps its value on the job', () => {
    const r = reshapeRow(jobOnly, ids);
    assert.deepEqual(r.set.quotes, []);
    assert.equal(r.set.invoices[0].number, 1700);
    assert.equal(r.set.completed, true);
    assert.equal('value' in r.unset, false);
    const s = reshapeRow(jobOnlyLive, ids);
    assert.deepEqual(Object.keys(s.unset), ['quoteStatus']);
  });

  it('leaves a job alone, and never adds a quote or invoice twice', () => {
    assert.equal(reshapeRow(alreadyJob, ids), null);
    const half = { ...alreadyJob, quoteNumber: 51008, invoiceNumber: 1800 };
    const r = reshapeRow(half, ids);
    assert.equal(r.set.quotes.length, 1);
    assert.equal(r.set.invoices.length, 1);
  });

  it('keeps each row at the stage it had', () => {
    const after = (row) => {
      const r = reshapeRow(row, ids);
      const out = { ...row, ...r.set };
      for (const k of Object.keys(r.unset)) delete out[k];
      return out;
    };
    assert.deepEqual([enquiry, quoted, wonNoProject, live, invoiced, jobOnly, jobOnlyLive].map((r) => stageOf(after(r))),
      ['toQuote', 'quoted', 'won', 'won', 'invoiced', 'invoiced', 'won']);
    assert.equal(jobValues(after(invoiced)).invoiced, 750);
    assert.equal(jobValues(after(jobOnly)).quoted, 600);
  });
});

/** A raw collection stand-in that understands the migration's queries. */
function fakeCollection(rows) {
  const dropped = [];
  const indexes = new Set(['_id_', 'quoteNumber_1', 'invoiceNumber_1', 'projectNumber_1']);
  const hasOld = (r) => OLD_FIELDS.some((f) => r[f] !== undefined);
  return {
    rows,
    dropped,
    updates: 0,
    find(filter) {
      assert.ok(filter.$or, 'finds rows by an old field');
      return { toArray: async () => rows.filter(hasOld).map((r) => ({ ...r })) };
    },
    async updateOne(filter, update) {
      const r = rows.find((x) => x._id === filter._id);
      if (!r || !hasOld(r)) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(r, update.$set);
      for (const k of Object.keys(update.$unset)) delete r[k];
      this.updates++;
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async dropIndex(name) {
      if (!indexes.has(name)) throw Object.assign(new Error('index not found'), { code: 27, codeName: 'IndexNotFound' });
      indexes.delete(name);
      dropped.push(name);
    },
  };
}

describe('Running the migration', () => {
  it('reshapes every old row, swaps the indexes, and does nothing the second time', async () => {
    const rows = [enquiry, quoted, wonNoProject, live, invoiced, jobOnly, jobOnlyLive, alreadyJob, noStatus].map((r) => structuredClone(r));
    const coll = fakeCollection(rows);
    let built = 0;
    const db = { INTERNAL: { jobRegister: { collection: coll, createIndexes: async () => { built++; } } } };

    assert.equal(await migrateRowsToJobs(db), 8);
    assert.deepEqual(coll.dropped, ['quoteNumber_1', 'invoiceNumber_1']);
    assert.equal(built, 1);
    for (const r of rows) for (const f of OLD_FIELDS) assert.equal(r[f], undefined, `${r.uuid} ${f}`);
    assert.equal(rows.find((r) => r.uuid === 'u4').quotes[0].number, 51004);
    assert.equal(rows.find((r) => r.uuid === 'u4').value, undefined);
    assert.equal(rows.find((r) => r.uuid === 'u6').value, 600);
    assert.equal(rows.find((r) => r.uuid === 'u8').quotes.length, 1, 'a job already reshaped is untouched');

    const snapshot = JSON.stringify(rows);
    assert.equal(await migrateRowsToJobs(db), 0);
    assert.equal(JSON.stringify(rows), snapshot);
    assert.equal(coll.updates, 8);
    assert.equal(built, 2, 'indexes are ensured every start');
  });

  it('passes on an index error that is not "not found"', async () => {
    const coll = fakeCollection([]);
    coll.dropIndex = async () => { throw Object.assign(new Error('not allowed'), { code: 13 }); };
    await assert.rejects(migrateRowsToJobs({ INTERNAL: { jobRegister: { collection: coll, createIndexes: async () => {} } } }), /not allowed/);
  });

  it('does nothing without the model', async () => {
    assert.equal(await migrateRowsToJobs({ INTERNAL: {} }), 0);
  });
});
