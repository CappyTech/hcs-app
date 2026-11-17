import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import ejs from 'ejs';
import jobRegisterModel, { jobProblem, repeatedNumber } from '../mongoose/models/mongoose/INTERNAL/jobRegister.js';
import rbac from '../mongoose/config/rolePermissionsConfig.js';
import accessGroups from '../mongoose/config/accessGroupsConfig.js';
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import jr, {
  stageOf, jobValues, clientKey, taxYearOf, matchJob, buildRegister, findUnregistered, nextNumber,
  parseJobForm, parseQuoteLine, parseInvoiceLine, lineUpdate, jobNumber, jobTitle, entryDate,
  parseNextAvailable, suggestNext, formEcho, fillNext, ukToday, STAGE_LABELS, QUOTE_STATUSES, QUOTE_STATUS_LABELS,
} from '../mongoose/services/jobRegisterService.js';
import lifecycle, { stageHooks } from '../mongoose/services/jobRegisterLifecycleService.js';
import { readFilters } from '../mongoose/controllers/jobRegisterController.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const Job = mongoose.models.jobRegisterTest || mongoose.model('jobRegisterTest', jobRegisterModel.schema.clone());
const d = (s) => new Date(`${s}T12:00:00Z`);
const oid = () => new mongoose.Types.ObjectId();

// Made-up jobs: quote numbers 51xxx, project numbers 41xxx
const Q = { a: oid(), b: oid(), c: oid(), e: oid(), f1: oid(), f2: oid() };
const I = { a: oid(), f1: oid() };
const entries = [
  { uuid: 'a', projectNumber: 41158, jobDate: d('2025-12-16'), site: 'Maple House, Testtown', client: 'Rigby Test', contact: 'Derek', description: 'Gully', clientRef: '513', completed: true,
    quotes: [{ _id: Q.a, number: 51425, date: d('2025-12-04'), value: 750, status: 'won' }],
    invoices: [{ _id: I.a, number: 1622, date: d('2026-02-10') }] },
  { uuid: 'b', site: '58 Sample St, Testtown', client: 'Plus Example', contact: 'Ian', description: 'Fencing',
    quotes: [{ _id: Q.b, number: 51437, date: d('2025-12-16'), value: 3244, status: 'quoted' }] },
  { uuid: 'c', site: '25 Example Ave, Sandtown', client: 'Plus example ', description: 'Paving',
    quotes: [{ _id: Q.c, number: 51766, date: d('2026-11-11'), value: 7424, status: 'quoted' }] },
  { uuid: 'd', projectNumber: 41299, jobDate: d('2026-11-11'), site: '7 Test Gardens', client: 'Plus Example', value: 600, description: 'Gravel', clientRef: '130984', quotes: [] },
  { uuid: 'e', site: '61 Sample Fields', client: 'Plus Example', description: 'Structural', cancelled: true,
    quotes: [{ _id: Q.e, number: 51659, date: d('2026-08-01'), status: 'quoted' }] },
  // A live job with a variation and a stage payment
  { uuid: 'f', projectNumber: 41300, jobDate: d('2026-10-01'), site: '9 Variation Row', client: 'Rigby Test',
    quotes: [{ _id: Q.f1, number: 51800, value: 1000, status: 'won' }, { _id: Q.f2, number: 51801, value: 250, status: 'won', description: 'Extra wall' }],
    invoices: [{ _id: I.f1, number: 1700, value: 500 }] },
];
const quotes = new Map([
  [51425, { uuid: 'q1', Number: 51425, CustomerName: 'Rigby Test', NetAmount: 750 }],
  [51437, { uuid: 'q2', Number: 51437, CustomerName: 'Plus Example', NetAmount: 3000 }],
  [51800, { uuid: 'q3', Number: 51800, CustomerName: 'Rigby Test', NetAmount: 1000 }],
  [51801, { uuid: 'q4', Number: 51801, CustomerName: 'Rigby Test', NetAmount: 250 }],
]);
const projects = new Map([
  [41158, { uuid: 'p1', Number: 41158, CustomerName: 'Rigby Test' }],
  [41299, { uuid: 'p2', Number: 41299, CustomerName: 'Plus Example' }],
  [41300, { uuid: 'p3', Number: 41300, CustomerName: 'Rigby Test' }],
]);
const invoices = new Map([
  [1622, { uuid: 'i1', Number: 1622, CustomerName: 'Rigby Test', ProjectNumber: 41158 }],
  [1700, { uuid: 'i2', Number: 1700, CustomerName: 'Rigby Test', ProjectNumber: 41300, NetAmount: 500 }],
]);
const build = (filters) => buildRegister({ entries, quotesByNumber: quotes, projectsByNumber: projects, invoicesByNumber: invoices, filters });

// ── Model ───────────────────────────────────────────────────────────────

describe('Job Register model', () => {
  it('needs a site, a client, and a numbered quote or a project number', async () => {
    await assert.rejects(() => new Job({ site: 'X', client: 'Y' }).validate(), /quote number, a project number/);
    await assert.rejects(() => new Job({ site: 'X', client: 'Y', quotes: [{ status: 'toQuote' }] }).validate(), /quote number, a project number/);
    await assert.rejects(() => new Job({ quotes: [{ number: 1 }], client: 'Y' }).validate(), /site/);
    await new Job({ quotes: [{ number: 51000 }], site: 'X', client: 'Y' }).validate();
    await new Job({ projectNumber: 40011, site: 'Maintenance', client: 'Y' }).validate();
  });

  it('needs a project number for an invoice, and a number on each invoice', async () => {
    await assert.rejects(() => new Job({ quotes: [{ number: 1 }], site: 'X', client: 'Y', invoices: [{ number: 5 }] }).validate(), /project number/);
    await assert.rejects(() => new Job({ projectNumber: 2, site: 'X', client: 'Y', invoices: [{ value: 5 }] }).validate(), /invoice number/);
    await new Job({ projectNumber: 2, site: 'X', client: 'Y', invoices: [{ number: 5 }, { number: 6, value: 10 }] }).validate();
  });

  it("won't hold one quote or invoice number twice on a job", async () => {
    await assert.rejects(() => new Job({ projectNumber: 2, site: 'X', client: 'Y', quotes: [{ number: 7 }, { number: 7 }] }).validate(), /Quote 7 is on this job twice/);
    await assert.rejects(() => new Job({ projectNumber: 2, site: 'X', client: 'Y', invoices: [{ number: 8 }, { number: 8 }] }).validate(), /Invoice 8 is on this job twice/);
    assert.equal(repeatedNumber([1, null, 2, null]), null);
    assert.equal(jobProblem({ projectNumber: 1, quotes: [{ number: 3 }, {}] }), null);
  });

  it('keeps quote statuses to the four, quoted by default', async () => {
    const j = new Job({ projectNumber: 2, site: 'X', client: 'Y', quotes: [{ number: 9 }] });
    assert.equal(j.quotes[0].status, 'quoted');
    assert.deepEqual(QUOTE_STATUSES, ['toQuote', 'quoted', 'won', 'lost']);
    await assert.rejects(() => new Job({ projectNumber: 2, site: 'X', client: 'Y', quotes: [{ number: 9, status: 'maybe' }] }).validate(), /status/);
  });

  it('indexes a quote number once across jobs, invoice numbers for lookup, and the project number once', () => {
    const idx = jobRegisterModel.schema.indexes();
    const find = (key) => idx.find(([keys]) => JSON.stringify(keys) === JSON.stringify(key));
    const opts = (key) => { const o = find(key)[1]; return { unique: o.unique, partialFilterExpression: o.partialFilterExpression }; };
    assert.deepEqual(opts({ 'quotes.number': 1 }), { unique: true, partialFilterExpression: { 'quotes.number': { $type: 'number' } } });
    assert.deepEqual(opts({ projectNumber: 1 }), { unique: true, partialFilterExpression: { projectNumber: { $type: 'number' } } });
    assert.ok(find({ 'invoices.number': 1 }));
    assert.notEqual(find({ 'invoices.number': 1 })[1]?.unique, true);
    assert.ok(find({ customerCode: 1 }));
    assert.ok(find({ importId: 1 }));
    assert.equal(find({ quoteNumber: 1 }), undefined);
    assert.equal(find({ invoiceNumber: 1 }), undefined);
  });
});

// ── Stage, values, matching ─────────────────────────────────────────────

describe('Job Register stages', () => {
  it('works the stage out from the job', () => {
    assert.equal(stageOf(entries[1]), 'quoted');
    assert.equal(stageOf(entries[3]), 'won');
    assert.equal(stageOf(entries[0]), 'invoiced');
    assert.equal(stageOf(entries[4]), 'cancelled');
  });

  it('covers every case', () => {
    const q = (status) => ({ number: 1, status });
    assert.equal(stageOf({ quotes: [q('toQuote')] }), 'toQuote');
    assert.equal(stageOf({ quotes: [q('quoted')] }), 'quoted');
    assert.equal(stageOf({ quotes: [q('toQuote'), q('quoted')] }), 'quoted');
    assert.equal(stageOf({ quotes: [q('quoted')], won: true }), 'won', 'won with no project number yet');
    assert.equal(stageOf({ quotes: [q('won')] }), 'won', 'a won quote');
    assert.equal(stageOf({ projectNumber: 2, quotes: [q('quoted')] }), 'won');
    assert.equal(stageOf({ projectNumber: 2, completed: true }), 'completed');
    assert.equal(stageOf({ projectNumber: 2, completed: true, invoices: [{ number: 3 }] }), 'invoiced');
    assert.equal(stageOf({ projectNumber: 2, completed: true, cancelled: true }), 'cancelled');
    assert.equal(stageOf({ quotes: [q('lost')] }), 'cancelled', 'every quote lost');
    assert.equal(stageOf({ quotes: [] }), 'toQuote');
  });

  it('leaves a job with stage payments won until it is completed', () => {
    const part = { projectNumber: 2, quotes: [{ number: 1, value: 1000, status: 'won' }], invoices: [{ number: 3, value: 400 }] };
    assert.equal(stageOf(part), 'won');
    assert.deepEqual(jobValues(part), { quoted: 1000, agreed: 1000, invoiced: 400 });
    assert.equal(stageOf({ ...part, completed: true }), 'invoiced');
  });

  it('values a job: quoted, agreed once won, and invoiced', () => {
    assert.deepEqual(jobValues(entries[5]), { quoted: 1250, agreed: 1250, invoiced: 500 });
    assert.deepEqual(jobValues(entries[3]), { quoted: 600, agreed: 600, invoiced: 0 }, 'a job-only row is worth its own value');
    assert.deepEqual(jobValues(entries[1]), { quoted: 3244, agreed: 0, invoiced: 0 }, 'not won yet');
    // An invoice with no value covers the rest of the job
    assert.equal(jobValues(entries[0]).invoiced, 750);
    // Won with no quote marked won: its open quotes; a lost quote counts for nothing
    const lost = { projectNumber: 2, quotes: [{ number: 1, value: 100, status: 'quoted' }, { number: 2, value: 50, status: 'lost' }] };
    assert.deepEqual(jobValues(lost), { quoted: 100, agreed: 100, invoiced: 0 });
  });

  it('dates a job by when it was won, else its first quote', () => {
    assert.equal(entryDate(entries[0]).toISOString().slice(0, 10), '2025-12-16');
    assert.equal(entryDate({ quotes: [{ date: d('2026-03-01') }, { date: d('2026-01-01') }] }).toISOString().slice(0, 10), '2026-01-01');
  });

  it('knows a job by its project number, else its highest quote number', () => {
    assert.equal(jobNumber(entries[0]), 41158);
    assert.equal(jobNumber(entries[1]), 51437);
    assert.equal(jobTitle(entries[5]), 'Job 41300');
    assert.equal(jobTitle(entries[2]), 'Quote 51766');
  });

  it('treats spellings of one client as one', () => {
    assert.equal(clientKey(' Plus  example '), clientKey('Plus Example'));
  });

  it('puts dates in UK tax years', () => {
    assert.equal(taxYearOf(d('2026-04-05')), 2025);
    assert.equal(taxYearOf(d('2026-04-06')), 2026);
  });
});

describe('Job Register matching', () => {
  it('checks the project, each quote and each invoice', () => {
    const ok = matchJob(entries[5], { project: projects.get(41300), quotesByNumber: quotes, invoicesByNumber: invoices });
    assert.equal(ok.project.state, 'ok');
    assert.deepEqual(ok.quotes.map((s) => [s.number, s.state]), [[51800, 'ok'], [51801, 'ok']]);
    assert.deepEqual(ok.invoices.map((s) => [s.number, s.state]), [[1700, 'ok']]);
    assert.equal(ok.quotes[1].id, String(Q.f2));
    assert.equal(ok.missing, false);
    assert.equal(ok.differs, false);
  });

  it("names a quote's value or client that differs, and a quote not in KashFlow yet", () => {
    const off = matchJob(entries[1], { quotesByNumber: quotes });
    assert.equal(off.quotes[0].state, 'differs');
    assert.match(off.quotes[0].issues[0], /£3000\.00/);
    assert.equal(off.project.state, 'none');
    const missing = matchJob(entries[2], {});
    assert.equal(missing.quotes[0].state, 'missing');
    assert.ok(missing.missing);
    const client = matchJob({ ...entries[1], customerCode: 'EX1' }, { quotesByNumber: new Map([[51437, { CustomerCode: 'OTHER', CustomerName: 'Other Ltd', NetAmount: 3244 }]]) });
    assert.match(client.quotes[0].issues[0], /Client in KashFlow is Other Ltd/);
  });

  it('flags an invoice on another project, or for a different value', () => {
    const wrong = matchJob(entries[5], { invoicesByNumber: new Map([[1700, { Number: 1700, ProjectNumber: 40000, NetAmount: 600 }]]) });
    assert.match(wrong.invoices[0].issues.join(' '), /project 40000/);
    assert.match(wrong.invoices[0].issues.join(' '), /£600\.00/);
    // An invoice with no value of its own isn't checked on value
    const noValue = matchJob(entries[0], { invoicesByNumber: new Map([[1622, { Number: 1622, ProjectNumber: 41158, NetAmount: 999 }]]) });
    assert.equal(noValue.invoices[0].state, 'ok');
  });

  it('checks KashFlow records by customer code when both have one, else by name', () => {
    const job = { client: 'Example Homes Ltd', customerCode: 'EX1', quotes: [{ number: 1 }] };
    const one = (r) => matchJob(job, { quotesByNumber: new Map([[1, r]]) }).quotes[0].state;
    assert.equal(one({ CustomerCode: 'ex1', CustomerName: 'Renamed Ltd' }), 'ok');
    assert.equal(one({ CustomerCode: 'OTHER', CustomerName: 'Example Homes Ltd' }), 'differs');
    assert.equal(matchJob({ ...job, customerCode: '' }, { quotesByNumber: new Map([[1, { CustomerName: 'example homes ltd' }]]) }).quotes[0].state, 'ok');
  });
});

// ── The register ────────────────────────────────────────────────────────

describe('Job Register filters', () => {
  it('counts every stage, and the double-entry checks leave cancelled jobs out', () => {
    const r = build({});
    assert.equal(r.rows.length, 6);
    assert.deepEqual(
      { quoted: r.counts.quoted, won: r.counts.won, invoiced: r.counts.invoiced, cancelled: r.counts.cancelled },
      { quoted: 2, won: 2, invoiced: 1, cancelled: 1 },
    );
    assert.equal(r.counts.unmatched, 1); // 51766 isn't in KashFlow; cancelled 51659 isn't counted
    assert.equal(r.counts.differs, 1); // 51437's value
  });

  it('filters by stage, client, tax year and search, and searches every quote and invoice number', () => {
    assert.deepEqual(build({ stage: 'won' }).rows.map((r) => r.entry.uuid), ['f', 'd']);
    assert.deepEqual(build({ stage: 'unmatched' }).rows.map((r) => r.entry.uuid), ['c']);
    assert.deepEqual(build({ stage: 'differs' }).rows.map((r) => r.entry.uuid), ['b']);
    assert.equal(build({ client: 'plus example' }).rows.length, 4);
    assert.deepEqual(build({ client: 'Rigby Test' }).rows.map((r) => r.entry.uuid), ['f', 'a']);
    assert.deepEqual(build({ year: 2025 }).rows.map((r) => r.entry.uuid).sort(), ['a', 'b']);
    assert.deepEqual(build({ q: 'sample st' }).rows.map((r) => r.entry.uuid), ['b']);
    assert.deepEqual(build({ q: '51801' }).rows.map((r) => r.entry.uuid), ['f'], 'a variation');
    assert.deepEqual(build({ q: '1622' }).rows.map((r) => r.entry.uuid), ['a'], 'an invoice');
    assert.deepEqual(build({ q: 'extra wall' }).rows.map((r) => r.entry.uuid), ['f'], "a quote's description");
  });

  it('sorts by project number, else the highest quote number, newest first', () => {
    assert.deepEqual(build({}).rows.map((r) => r.entry.uuid), ['c', 'e', 'b', 'f', 'd', 'a']);
  });

  it('lists clients once, by their most used spelling', () => {
    const plus = build({}).clients.find((c) => c.key === 'plus example');
    assert.equal(plus.name, 'Plus Example');
    assert.equal(plus.variants, 2);
  });

  it('totals quoted, won and invoiced, leaving out cancelled', () => {
    const t = build({}).totals;
    assert.equal(t.quoted, 750 + 3244 + 7424 + 600 + 1250);
    assert.equal(t.won, 750 + 600 + 1250);
    assert.equal(t.invoiced, 750 + 500);
  });

  it('finds KashFlow quotes and projects not in the register', () => {
    const u = findUnregistered({
      quotes: [{ Number: 51425 }, { Number: 51900 }],
      projects: [{ Number: 41158 }, { Number: 41400 }],
      quoteNumbers: new Set([51425]),
      projectNumbers: new Set([41158]),
    });
    assert.deepEqual(u.quotes.map((q) => q.Number), [51900]);
    assert.deepEqual(u.projects.map((p) => p.Number), [41400]);
  });

  it('suggests the number after the highest in the register or KashFlow', () => {
    assert.equal(nextNumber([51766, 51700], [51770]), 51771);
    assert.equal(nextNumber([], []), null);
  });

  it('reads KashFlow next-available answers in any likely shape', () => {
    assert.equal(parseNextAvailable(1001), 1001);
    assert.equal(parseNextAvailable('1001'), 1001);
    assert.equal(parseNextAvailable('"1001"'), 1001);
    assert.equal(parseNextAvailable({ Number: 1001 }), 1001);
    assert.equal(parseNextAvailable({ NextNumber: '1001' }), 1001);
    assert.equal(parseNextAvailable({ Data: { Number: 1001 } }), 1001);
    assert.equal(parseNextAvailable(null), null);
    assert.equal(parseNextAvailable(''), null);
    assert.equal(parseNextAvailable('abc'), null);
    assert.equal(parseNextAvailable(0), null);
    assert.equal(parseNextAvailable({ Other: 5 }), null);
  });

  it("takes KashFlow's next number, unless the register is already past it", () => {
    assert.deepEqual(suggestNext({ kashflow: 1001, register: [990], synced: [999] }), { number: 1001, source: 'kashflow' });
    assert.deepEqual(suggestNext({ kashflow: 1001, register: [1001, 1002], synced: [1000] }), { number: 1003, source: 'kashflow' });
    assert.deepEqual(suggestNext({ kashflow: null, register: [990], synced: [999] }), { number: 1000, source: 'sync' });
    assert.deepEqual(suggestNext({ kashflow: null, register: [], synced: [] }), { number: null, source: 'sync' });
  });

  it('reads the year from the query string, and ignores junk', () => {
    assert.equal(readFilters({ year: '2026' }).year, 2026);
    assert.equal(readFilters({ year: 'x' }).year, null);
    assert.equal(readFilters({}).stage, 'all');
  });
});

// ── Forms ───────────────────────────────────────────────────────────────

describe('Job Register forms', () => {
  it("reads a job's own fields; blanks clear", () => {
    const f = parseJobForm({ projectNumber: '', value: '£7,424.00', jobDate: '2026-11-11', site: ' 25 Example Ave ', client: 'Plus Example', cancelled: 'on', won: 'on', inKashflow: 'on' });
    assert.equal(f.projectNumber, null);
    assert.equal(f.value, 7424);
    assert.equal(f.site, '25 Example Ave');
    assert.equal(f.cancelled, true);
    assert.equal(f.won, true);
    assert.equal(f.completed, false);
    assert.equal(f.inKashflow, true);
    assert.equal(f.jobDate.toISOString().slice(0, 10), '2026-11-11');
    assert.equal('quoteNumber' in f, false);
    assert.equal('invoiceNumber' in f, false);
  });

  it('reads a quote line: number, date, value, description, status (quoted by default), notes', () => {
    const q = parseQuoteLine({ number: '51770', date: '2026-11-12', value: '1,250', description: ' Extra ', status: 'won', notes: 'n' });
    assert.deepEqual({ ...q, date: q.date.toISOString().slice(0, 10) }, { number: 51770, date: '2026-11-12', value: 1250, description: 'Extra', status: 'won', notes: 'n' });
    assert.equal(parseQuoteLine({ number: '1', status: 'nonsense' }).status, 'quoted');
    assert.equal(parseQuoteLine({}).number, null, 'a quote may wait for its number');
  });

  it('reads an invoice line, which needs its number', () => {
    const i = parseInvoiceLine({ number: '1701', value: '500', notes: 'Stage 1' });
    assert.equal(i.number, 1701);
    assert.equal(i.value, 500);
    assert.equal(i.date, null);
    assert.throws(() => parseInvoiceLine({ value: '5' }), /invoice number/);
  });

  it('refuses a bad number, value or date', () => {
    assert.throws(() => parseJobForm({ projectNumber: '41a' }), /project number/);
    assert.throws(() => parseJobForm({ value: '-3' }), /value/);
    assert.throws(() => parseJobForm({ jobDate: '11/11/2026' }), /job date/);
    assert.throws(() => parseQuoteLine({ number: '5x' }), /quote number/);
    assert.throws(() => parseInvoiceLine({ number: '7', date: 'soon' }), /invoice date/);
  });

  it('turns a line into positional $set and $unset', () => {
    assert.deepEqual(lineUpdate({ number: 5, date: null, notes: '' }, 'quotes.$.'), { $set: { 'quotes.$.number': 5 }, $unset: { 'quotes.$.date': 1, 'quotes.$.notes': 1 } });
  });
});

describe('Job Register Next buttons', () => {
  it('keeps what was typed and fills in the asked-for number', () => {
    const body = { fill: 'project', quoteNumber: '1001', site: ' 1 Test St ', client: 'Client A', value: '12.5',
      quoteDate: '2026-11-11', jobDate: 'junk', contractUuid: 'k1', cancelled: 'on' };
    const e = fillNext(body, { quote: 2000, project: 3000 });
    assert.equal(e.projectNumber, '3000');
    assert.equal(e.quoteNumber, '1001');
    assert.equal(e.site, '1 Test St');
    assert.equal(e.value, '12.5');
    assert.equal(e.quoteDate, '2026-11-11');
    assert.equal(e.jobDate, '');
    assert.deepEqual(e.contractId, { uuid: 'k1' });
    assert.equal(e.cancelled, true);
    assert.equal(fillNext({}, { quote: 2000 }).quoteNumber, '2000');
    assert.equal(fillNext({ fill: 'quote', quoteNumber: '5' }, { quote: null }).quoteNumber, '5');
    assert.equal(formEcho().site, '');
  });

  it('fills a date field with today in the UK for the Today buttons', () => {
    // 23:30 UTC on 31 Mar is 00:30 on 1 Apr in London (BST)
    const now = new Date('2026-03-31T23:30:00Z');
    assert.equal(ukToday(now), '2026-04-01');
    const e = fillNext({ fill: 'jobDate', quoteNumber: '7', quoteDate: '2026-01-02' }, { quote: 2000 }, now);
    assert.equal(e.jobDate, '2026-04-01');
    assert.equal(e.quoteDate, '2026-01-02');
    assert.equal(e.quoteNumber, '7');
    assert.equal(fillNext({ fill: 'quoteDate' }, {}, now).quoteDate, '2026-04-01');
  });
});

// ── Quotes and invoices on a job, and the lifecycle hooks ───────────────

/** A deep copy that keeps ObjectIds and Dates (structuredClone flattens ObjectIds). */
const copy = (v) => {
  if (Array.isArray(v)) return v.map(copy);
  if (v && typeof v === 'object' && v.constructor === Object) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)]));
  return v;
};

/** A one-collection stand-in: findOne(...).lean() and updateOne, recording the updates. */
function fakeJobs(rows) {
  const calls = [];
  const byUuid = (uuid) => rows.find((r) => r.uuid === uuid) || null;
  return {
    calls,
    findOne: ({ uuid }) => ({ lean: async () => (byUuid(uuid) ? copy(byUuid(uuid)) : null) }),
    updateOne: async (filter, update, options) => {
      calls.push({ filter, update, options });
      return { matchedCount: byUuid(filter.uuid) ? 1 : 0, modifiedCount: 1 };
    },
  };
}

describe('Adding, changing and removing quotes and invoices', () => {
  let saved; let jobs; let hooks;
  const enquiry = () => ({ _id: oid(), uuid: 'enq', site: '1 Test St', client: 'Example Homes', quotes: [{ _id: Q.b, number: 51437, status: 'quoted', value: 100 }], invoices: [] });
  const live = () => ({ _id: oid(), uuid: 'live', projectNumber: 41300, site: '9 Variation Row', client: 'Rigby Test',
    quotes: [{ _id: Q.f1, number: 51800, status: 'won', value: 1000 }], invoices: [{ _id: I.f1, number: 1700, value: 500 }] });

  before(() => { saved = { INTERNAL: mdb.INTERNAL, hooks: { ...lifecycle } }; });
  after(() => { mdb.INTERNAL = saved.INTERNAL; Object.assign(lifecycle, saved.hooks); });
  beforeEach(() => {
    jobs = fakeJobs([enquiry(), live()]);
    mdb.INTERNAL = { jobRegister: jobs };
    hooks = { onQuoteAdded: mock.fn(async () => {}), onJobWon: mock.fn(async () => {}), onJobCompleted: mock.fn(async () => {}) };
    Object.assign(lifecycle, hooks);
  });

  it('adds a variation with $push, marks the job edited, and calls onQuoteAdded', async () => {
    const r = await jr.addQuote('live', { number: '51801', value: '250', description: 'Extra wall', status: 'won' });
    const { filter, update, options } = jobs.calls[0];
    assert.deepEqual(filter, { uuid: 'live' });
    assert.equal(update.$push.quotes.number, 51801);
    assert.equal(update.$push.quotes.value, 250);
    assert.ok(update.$push.quotes._id instanceof mongoose.Types.ObjectId);
    assert.ok(update.$set.editedAt instanceof Date);
    assert.equal(options.runValidators, true);
    assert.equal(r.job.quotes.length, 2);
    assert.equal(hooks.onQuoteAdded.mock.callCount(), 1);
    assert.equal(hooks.onQuoteAdded.mock.calls[0].arguments[1].number, 51801);
    assert.equal(hooks.onJobWon.mock.callCount(), 0, 'already won');
  });

  it("won't add a quote number the job already has", async () => {
    await assert.rejects(jr.addQuote('live', { number: '51800' }), (e) => e.status === 400 && /already/.test(e.message));
    await assert.rejects(jr.addQuote('nope', { number: '1' }), (e) => e.status === 404);
    assert.equal(jobs.calls.length, 0);
  });

  it('changes a quote with positional $set/$unset, and a quote marked won wins the job (onJobWon once)', async () => {
    await jr.updateQuote('enq', String(Q.b), { number: '51437', status: 'won', value: '', description: 'Fencing' });
    const { filter, update } = jobs.calls[0];
    assert.deepEqual(filter, { uuid: 'enq', 'quotes._id': Q.b });
    assert.equal(update.$set['quotes.$.status'], 'won');
    assert.equal(update.$set['quotes.$.description'], 'Fencing');
    assert.equal(update.$set.won, true);
    assert.equal(update.$unset['quotes.$.value'], 1);
    assert.ok(update.$set.editedAt);
    assert.equal(hooks.onJobWon.mock.callCount(), 1);
    assert.equal(hooks.onJobCompleted.mock.callCount(), 0);
  });

  it("won't take away an enquiry's only quote number", async () => {
    await assert.rejects(jr.updateQuote('enq', String(Q.b), { number: '' }), (e) => e.status === 400 && /only number/.test(e.message));
    await assert.rejects(jr.removeQuote('enq', String(Q.b)), (e) => e.status === 400 && /only number/.test(e.message));
    await assert.rejects(jr.updateQuote('enq', String(oid()), { number: '1' }), (e) => e.status === 404 && /no longer on this job/.test(e.message));
    await assert.rejects(jr.updateQuote('enq', 'junk', { number: '1' }), (e) => e.status === 404);
    assert.equal(jobs.calls.length, 0);
  });

  it('removes a quote from a job that has its project number with $pull', async () => {
    await jr.removeQuote('live', String(Q.f1));
    assert.deepEqual(jobs.calls[0].update.$pull, { quotes: { _id: Q.f1 } });
  });

  it('adds a stage payment only to a job with its project number; the job stays won', async () => {
    await assert.rejects(jr.addInvoice('enq', { number: '1701' }), (e) => e.status === 400 && /project number/.test(e.message));
    await assert.rejects(jr.addInvoice('live', { number: '1700' }), (e) => e.status === 400 && /already/.test(e.message));
    const r = await jr.addInvoice('live', { number: '1701', value: '300', notes: 'Stage 2' });
    assert.equal(jobs.calls[0].update.$push.invoices.number, 1701);
    assert.equal(stageOf(r.job), 'won');
    assert.equal(jobValues(r.job).invoiced, 800);
    assert.equal(hooks.onJobCompleted.mock.callCount(), 0);
  });

  it('changes and removes an invoice', async () => {
    await jr.updateInvoice('live', String(I.f1), { number: '1700', value: '', date: '2026-11-01' });
    assert.deepEqual(jobs.calls[0].filter, { uuid: 'live', 'invoices._id': I.f1 });
    assert.equal(jobs.calls[0].update.$unset['invoices.$.value'], 1);
    assert.equal(jobs.calls[0].update.$set['invoices.$.date'].toISOString().slice(0, 10), '2026-11-01');
    await jr.removeInvoice('live', String(I.f1));
    assert.deepEqual(jobs.calls[1].update.$pull, { invoices: { _id: I.f1 } });
    await assert.rejects(jr.removeInvoice('live', String(oid())), (e) => e.status === 404);
  });
});

describe('Lifecycle hooks', () => {
  it('fire once, when the stage changes', () => {
    const quoted = { quotes: [{ number: 1, status: 'quoted' }] };
    assert.deepEqual(stageHooks(null, quoted), []);
    assert.deepEqual(stageHooks(quoted, { ...quoted, projectNumber: 2 }), ['onJobWon']);
    assert.deepEqual(stageHooks({ ...quoted, projectNumber: 2 }, { ...quoted, projectNumber: 2 }), []);
    assert.deepEqual(stageHooks({ ...quoted, projectNumber: 2 }, { ...quoted, projectNumber: 2, completed: true }), ['onJobCompleted']);
    assert.deepEqual(stageHooks(quoted, { ...quoted, projectNumber: 2, completed: true }), ['onJobWon', 'onJobCompleted']);
    assert.deepEqual(stageHooks(null, { projectNumber: 2 }), ['onJobWon'], 'a job entered already won');
    assert.deepEqual(stageHooks({ projectNumber: 2, completed: true }, { projectNumber: 2, completed: true, invoices: [{ number: 1 }] }), [], 'completed → invoiced is still done');
    assert.deepEqual(stageHooks(quoted, { ...quoted, cancelled: true }), []);
  });

  it("log and never stop a save when one fails", async () => {
    const hooks = { onJobWon: async () => { throw new Error('boom'); } };
    assert.deepEqual(await lifecycle.fireStageHooks({ quotes: [{ number: 1, status: 'quoted' }] }, { projectNumber: 2 }, hooks), ['onJobWon']);
  });

  describe('from the job form', () => {
    let saved; let doc; let hooks;
    before(() => { saved = { INTERNAL: mdb.INTERNAL, REST: mdb.REST, hooks: { ...lifecycle } }; });
    after(() => { mdb.INTERNAL = saved.INTERNAL; mdb.REST = saved.REST; Object.assign(lifecycle, saved.hooks); });

    /** Enough of a Mongoose document for updateEntry. */
    const makeDoc = (fields) => ({
      ...structuredClone(fields),
      set(k, v) { if (v === undefined) delete this[k]; else this[k] = v; },
      toObject() { const { set, toObject, save, ...rest } = this; return structuredClone(rest); },
      async save() { return this; },
    });

    beforeEach(() => {
      doc = makeDoc({ uuid: 'w', site: 'S', client: 'C', customerCode: 'EX1', quotes: [{ _id: 'q1', number: 51000, status: 'quoted', value: 900 }], invoices: [] });
      mdb.INTERNAL = { jobRegister: { findOne: async () => doc }, contract: {} };
      mdb.REST = { customer: { findOne: () => ({ select: () => ({ lean: async () => ({ Code: 'EX1', Name: 'Example Homes Ltd' }) }) }) } };
      hooks = { onQuoteAdded: mock.fn(async () => {}), onJobWon: mock.fn(async () => {}), onJobCompleted: mock.fn(async () => {}) };
      Object.assign(lifecycle, hooks);
    });

    it('winning a job (its project number) calls onJobWon and wins its only quote', async () => {
      const saved2 = await jr.updateEntry('w', { site: 'S', customerCode: 'EX1', projectNumber: '41500' });
      assert.equal(saved2.projectNumber, 41500);
      assert.equal(saved2.quotes[0].status, 'won');
      assert.equal(saved2.value, undefined, 'a job with quotes keeps no value of its own');
      assert.ok(saved2.editedAt instanceof Date);
      assert.equal(hooks.onJobWon.mock.callCount(), 1);
      assert.equal(hooks.onJobCompleted.mock.callCount(), 0);
    });

    it('completing it calls onJobCompleted, and saving again calls nothing', async () => {
      doc.projectNumber = 41500;
      await jr.updateEntry('w', { site: 'S', customerCode: 'EX1', projectNumber: '41500', completed: 'on' });
      assert.equal(hooks.onJobCompleted.mock.callCount(), 1);
      await jr.updateEntry('w', { site: 'S', customerCode: 'EX1', projectNumber: '41500', completed: 'on' });
      assert.equal(hooks.onJobCompleted.mock.callCount(), 1);
      assert.equal(hooks.onJobWon.mock.callCount(), 0);
    });
  });

  describe('from the add form', () => {
    let saved; let created; let hooks;
    before(() => {
      saved = { INTERNAL: mdb.INTERNAL, REST: mdb.REST, hooks: { ...lifecycle } };
      mdb.INTERNAL = { jobRegister: { create: async (f) => { created.push(f); return { uuid: 'n1', ...f }; } } };
      mdb.REST = { customer: { findOne: () => ({ select: () => ({ lean: async () => ({ Code: 'EX1', Name: 'Example Homes Ltd' }) }) }) } };
    });
    after(() => { mdb.INTERNAL = saved.INTERNAL; mdb.REST = saved.REST; Object.assign(lifecycle, saved.hooks); });
    beforeEach(() => {
      created = [];
      hooks = { onQuoteAdded: mock.fn(async () => {}), onJobWon: mock.fn(async () => {}), onJobCompleted: mock.fn(async () => {}) };
      Object.assign(lifecycle, hooks);
    });

    it('an enquiry is a job with one quote carrying the value; onQuoteAdded, not onJobWon', async () => {
      await jr.createEntry({ quoteNumber: '51900', quoteDate: '2026-11-12', quoteStatus: 'toQuote', value: '1,000', description: 'Paving', site: 'A', customerCode: 'EX1' });
      const f = created[0];
      assert.equal(f.projectNumber, undefined);
      assert.equal(f.value, undefined);
      assert.equal(f.quotes.length, 1);
      assert.deepEqual({ ...f.quotes[0], date: f.quotes[0].date.toISOString().slice(0, 10) }, { number: 51900, date: '2026-11-12', value: 1000, description: 'Paving', status: 'toQuote' });
      assert.equal(f.client, 'Example Homes Ltd');
      assert.equal(hooks.onQuoteAdded.mock.callCount(), 1);
      assert.equal(hooks.onJobWon.mock.callCount(), 0);
    });

    it('a job entered won has its quote won and calls onJobWon; a job with no quote keeps its value', async () => {
      await jr.createEntry({ quoteNumber: '51901', projectNumber: '41501', value: '50', site: 'A', customerCode: 'EX1' });
      assert.equal(created[0].quotes[0].status, 'won');
      assert.equal(hooks.onJobWon.mock.callCount(), 1);
      await jr.createEntry({ projectNumber: '41502', value: '600', site: 'B', customerCode: 'EX1' });
      assert.equal(created[1].value, 600);
      assert.deepEqual(created[1].quotes, []);
    });
  });
});

// ── Access and pages ────────────────────────────────────────────────────

describe('Job Register access', () => {
  it('sits with Commercial, and the accountant can read it', () => {
    assert.ok(accessGroups.groups.commercial.models.includes('jobRegister'));
    assert.ok(accessGroups.groups.commercial.routes.view.includes('/job-register'));
    assert.ok(accessGroups.groups.finance.routes.view.includes('/job-register'));
    assert.deepEqual(rbac.routeAccess['/job-register'].filter((r) => ['admin', 'accountant'].includes(r)).sort(), ['accountant', 'admin']);
  });
});

describe('Job Register page', () => {
  const view = path.join(root, 'mongoose/views/tailwindcss/jobRegister/index.ejs');
  const base = {
    title: 'Job Register', csrfToken: 'c', crumbs: [], contracts: [{ uuid: 'k1', title: 'Windsor', status: 'In Progress' }],
    stageLabels: STAGE_LABELS, stages: jr.STAGES, form: {},
    next: { quote: 51767, project: 41301 },
    unregistered: { year: 2026, quoteCount: 1, projectCount: 0, quotes: [{ uuid: 'q9', Number: 51900, Date: d('2026-11-01'), CustomerName: 'Example Council', NetAmount: 100 }], projects: [] },
  };

  it('shows a row per job, each linking to its page, with the KashFlow checks and the add form', async () => {
    const html = await ejs.renderFile(view, { ...base, ...build({}) });
    for (const col of ['Job', 'Quotes', 'Site / Client', 'Stage', 'Quoted', 'Invoiced', 'KashFlow']) {
      assert.match(html, new RegExp(`>${col}</th>`), col);
    }
    assert.match(html, /href="\/job-register\/f"/);
    assert.match(html, /Maple House, Testtown/);
    assert.match(html, /51800[\s\S]*51801/);
    assert.match(html, /Value in KashFlow is £3000\.00/);
    assert.match(html, /£500\.00\s*<p class="text-xs text-gray-500 dark:text-gray-400">of £1,250\.00/, 'part-invoiced');
    assert.match(html, /Enquiry/);
    assert.match(html, /In KashFlow, not in the register/);
    assert.match(html, /51900/);
    assert.match(html, /Next quote number: <span class="font-mono">51767/);
    assert.match(html, /action="\/job-register"/);
    assert.match(html, /name="_csrf"/);
    assert.doesNotMatch(html, /<script/);
    assert.match(html, /name="fill" value="quote" formaction="\/job-register\/next#add" formnovalidate/);
    assert.match(html, /name="fill" value="project" formaction="\/job-register\/next#add" formnovalidate/);
    assert.doesNotMatch(html, /name="invoiceNumber"/);
  });

  it('shows the add form again as typed after a Next button', async () => {
    const form = fillNext({ fill: 'quote', site: '1 Test St', client: 'Client A', value: 'abc' }, base.next);
    const html = await ejs.renderFile(view, { ...base, ...build({}), form });
    assert.match(html, /id="jr-quoteNumber" name="quoteNumber" inputmode="numeric" value="51767"/);
    assert.match(html, /value="1 Test St"/);
    assert.match(html, /id="jr-value" name="value" inputmode="decimal" value="abc"/);
  });

  it("says when KashFlow didn't answer and the numbers come from the sync", async () => {
    const html = await ejs.renderFile(view, { ...base, ...build({}), next: { ...base.next, quoteSource: 'sync', projectSource: 'kashflow' } });
    assert.match(html, /KashFlow didn.t answer/);
    const ok = await ejs.renderFile(view, { ...base, ...build({}), next: { ...base.next, quoteSource: 'kashflow', projectSource: 'kashflow' } });
    assert.doesNotMatch(ok, /didn.t answer/);
  });

  it('keeps the other filters on the stage chips', async () => {
    const html = await ejs.renderFile(view, { ...base, ...build({ client: 'rigby test', year: 2025 }) });
    assert.match(html, /href="\/job-register\?stage=won&amp;client=rigby%20test&amp;year=2025"/);
  });
});

describe('The job page', () => {
  const view = path.join(root, 'mongoose/views/tailwindcss/jobRegister/show.ejs');
  const render = (job, over = {}) => {
    const match = matchJob(job, { project: projects.get(job.projectNumber) || null, quotesByNumber: quotes, invoicesByNumber: invoices });
    return ejs.renderFile(view, {
      csrfToken: 'c', crumbs: [], title: jobTitle(job), job, stage: stageOf(job), values: jobValues(job), match, next: { quote: 51802 },
      stageLabels: STAGE_LABELS, quoteStatuses: QUOTE_STATUSES, quoteStatusLabels: QUOTE_STATUS_LABELS,
      canEdit: true, canCreate: { project: false, quotes: {} }, editQuote: null, editInvoice: null, ...over,
    });
  };

  it('shows the job, its money, its quotes and its invoices with their KashFlow checks', async () => {
    const html = await render(entries[5]);
    assert.match(html, /Job 41300: 9 Variation Row/);
    assert.match(html, />Quoted</);
    assert.match(html, /£500\.00 of £1,250\.00 invoiced so far/);
    assert.match(html, /id="quotes"/);
    assert.match(html, /51801[\s\S]*Extra wall[\s\S]*£250\.00/);
    assert.match(html, /id="invoices"/);
    assert.match(html, /1700/);
    assert.match(html, /href="\/quote\/read\/q4"/);
    assert.match(html, /href="\/job-register\/f\/edit"/);
    assert.match(html, /action="\/job-register\/f\/quotes"/);
    assert.match(html, /action="\/job-register\/f\/invoices"/);
    assert.match(html, new RegExp(`href="/job-register/f\\?quote=${Q.f2}#quote-form"`));
    assert.match(html, /name="_csrf"/);
    assert.doesNotMatch(html, /<script|onclick=/);
  });

  it('opens a quote or invoice for editing, with its delete form', async () => {
    const job = entries[5];
    const html = await render(job, { editQuote: job.quotes[1], editInvoice: job.invoices[0] });
    assert.match(html, new RegExp(`action="/job-register/f/quotes/${Q.f2}"`));
    assert.match(html, new RegExp(`action="/job-register/f/quotes/${Q.f2}/delete"`));
    assert.match(html, /value="Extra wall"/);
    assert.match(html, new RegExp(`action="/job-register/f/invoices/${I.f1}/delete"`));
    assert.match(html, /Save invoice/);
  });

  it('offers Create in KashFlow per quote only where it is missing and allowed', async () => {
    const job = entries[2];
    const yes = await render(job, { canCreate: { project: false, quotes: { [String(Q.c)]: true } } });
    assert.match(yes, new RegExp(`href="/job-register/c/kashflow-quote/${Q.c}"`));
    const no = await render(job, { canCreate: { project: false, quotes: {} } });
    assert.doesNotMatch(no, /kashflow-quote/);
    const sent = await render({ ...job, quotes: [{ ...job.quotes[0], sentAt: d('2026-11-12') }] }, { canCreate: { project: false, quotes: { [String(Q.c)]: true } } });
    assert.match(sent, /Created from here on 12\/11\/2026/);
    assert.doesNotMatch(sent, /kashflow-quote/);
  });

  it("asks for the project number before invoices, and hides the forms from readers", async () => {
    const enquiry = await render(entries[2]);
    assert.match(enquiry, /project number \(Edit job\) before adding an invoice/);
    assert.doesNotMatch(enquiry, /action="\/job-register\/c\/invoices"/);
    const reader = await render(entries[5], { canEdit: false });
    assert.doesNotMatch(reader, /method="POST"/);
  });

  it('the edit page edits the job only', async () => {
    const html = await ejs.renderFile(path.join(root, 'mongoose/views/tailwindcss/jobRegister/edit.ejs'), {
      csrfToken: 'c', crumbs: [], title: 'Edit quote 51437', entry: entries[1], stage: 'quoted', stageLabels: STAGE_LABELS, next: {}, contracts: [], customers: [],
    });
    assert.match(html, /action="\/job-register\/b"/);
    assert.match(html, /formaction="\/job-register\/b\/next"/);
    assert.doesNotMatch(html, /name="quoteNumber"|name="invoiceNumber"|name="value"/);
    const jobOnly = await ejs.renderFile(path.join(root, 'mongoose/views/tailwindcss/jobRegister/edit.ejs'), {
      csrfToken: 'c', crumbs: [], title: 'Edit job 41299', entry: entries[3], stage: 'won', stageLabels: STAGE_LABELS, next: {}, contracts: [], customers: [],
    });
    assert.match(jobOnly, /Agreed value/);
  });
});
