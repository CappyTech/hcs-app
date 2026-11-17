import { describe, it, beforeEach, afterEach, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import mongoose from 'mongoose';

/*
 * The Job Register lifecycle hooks doing their work: a quote added is created
 * in KashFlow, a won job gets its KashFlow project with its quotes put on it.
 * KashFlow is never called: kfSession's withKfAuth and kfAxios.get/post/put
 * are fakes, hcs-sync's pull is a fake, the register is an in-memory
 * stand-in on mdb.INTERNAL and the synced records one on mdb.REST. Then
 * the OneDrive folders on the same events, with the folder service faked.
 */
import kfSession from '../services/kashflowSessionService.js';
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import hcsSyncService from '../mongoose/services/hcsSyncService.js';
import kf, { quoteUpdatePayload, autoQuoteSkip, createdNotice } from '../mongoose/services/jobRegisterKashflowService.js';
import lifecycle, { stageHooks } from '../mongoose/services/jobRegisterLifecycleService.js';
import jobRegister, { matchJob, stageOf, jobValues, STAGE_LABELS, QUOTE_STATUSES, QUOTE_STATUS_LABELS } from '../mongoose/services/jobRegisterService.js';
import oneDrive from '../services/oneDriveFolderService.js';
import ctrl from '../mongoose/controllers/jobRegisterController.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const d = (s) => new Date(`${s}T12:00:00Z`);
const AUTO = 'JOB_REGISTER_KASHFLOW_AUTO';

// Made-up jobs: no real clients, sites or numbers
const QID = new mongoose.Types.ObjectId();
const Q2 = new mongoose.Types.ObjectId();
const LOST = new mongoose.Types.ObjectId();
const enquiry = () => ({
  uuid: 'enq', site: '1 Test Street, Testtown', customerCode: 'CUST01', client: 'Test Client Ltd', description: 'Fencing', clientRef: 'PO-1',
  quotes: [{ _id: QID, number: 900101, date: d('2026-11-02'), value: 1250, status: 'quoted' }],
});
const won = () => ({
  uuid: 'won', projectNumber: 800201, jobDate: d('2026-11-10'), site: '2 Sample Road', customerCode: 'CUST02', client: 'Sample Homes', description: 'Paving',
  quotes: [
    { _id: QID, number: 900102, value: 600, status: 'won', sentAt: d('2026-11-01') },
    { _id: Q2, number: 900103, value: 200, status: 'quoted' },
    { _id: LOST, number: 900104, value: 50, status: 'lost', sentAt: d('2026-11-01') },
  ],
});

/** A deep copy that keeps ObjectIds and Dates. */
const copy = (v) => {
  if (Array.isArray(v)) return v.map(copy);
  if (v && typeof v === 'object' && v.constructor === Object) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)]));
  return v;
};

/** Enough of the register collection for the creates: findOne, the claim, positional $set/$unset. */
function fakeRegister(rows) {
  const byUuid = (uuid) => rows.find((r) => r.uuid === uuid) || null;
  const lean = (v) => ({ lean: async () => (v ? copy(v) : null) });
  const free = (sent, sending, stale) => sent == null && (sending == null || sending < stale);
  const at = (r, filter, path) => {
    const m = path.match(/^quotes\.\$\.(\w+)$/);
    if (!m) return [r, path];
    const id = filter['quotes._id'] ?? filter.quotes?.$elemMatch?._id;
    return [r.quotes.find((q) => String(q._id) === String(id)), m[1]];
  };
  return {
    findOne: ({ uuid }) => lean(byUuid(uuid)),
    findOneAndUpdate: (filter, update) => {
      const r = byUuid(filter.uuid);
      let ok = false;
      if (r && filter.quotes?.$elemMatch) {
        const em = filter.quotes.$elemMatch;
        const q = r.quotes.find((x) => String(x._id) === String(em._id));
        ok = !!q && free(q.sentAt, q.sendingAt, em.$or[1].sendingAt.$lt);
      } else if (r) {
        ok = free(r.projectSentAt, r.projectSendingAt, filter.$or[1].projectSendingAt.$lt);
      }
      if (ok) for (const [k, v] of Object.entries(update.$set)) { const [o, f] = at(r, filter, k); o[f] = v; }
      return lean(ok ? r : null);
    },
    updateOne: async (filter, update) => {
      const r = byUuid(filter.uuid);
      for (const [k, v] of Object.entries(update.$set || {})) { const [o, f] = at(r, filter, k); o[f] = v; }
      for (const k of Object.keys(update.$unset || {})) { const [o, f] = at(r, filter, k); delete o[f]; }
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
}

/** Synced records: the quote and project numbers hcs-sync has, and the nominals. */
function fakeRest({ quotes = [], projects = [], nominal = 4000 } = {}) {
  const has = (list) => ({ findOne: ({ Number: n }) => ({ select: () => ({ lean: async () => (list.includes(n) ? { _id: n } : null) }) }) });
  return {
    quote: { ...has(quotes), aggregate: async () => (nominal != null ? [{ _id: nominal, n: 3 }] : []) },
    project: has(projects),
    nominal: { find: () => ({ select: () => ({ sort: () => ({ lean: async () => (nominal != null ? [{ Code: nominal, Name: 'Sales' }] : []) }) }) }) },
  };
}

/** Fake KashFlow: `existing` is what GET finds by 'quotes/n' / 'projects/n'; POST and PUT record what was sent. */
function fakeKashflow({ existing = {}, created = null, postError = null, putError = null } = {}) {
  const calls = { posts: [], puts: [] };
  kfSession.withKfAuth = async (fn) => fn('test-token');
  kfSession.kfAxios.get = mock.fn(async (url) => {
    const m = String(url).match(/\/(quotes|projects)\/(\d+)$/);
    const hit = m && existing[`${m[1]}/${m[2]}`];
    if (hit) return { data: copy(hit) };
    throw Object.assign(new Error('Not found'), { response: { status: 404 } });
  });
  kfSession.kfAxios.post = mock.fn(async (url, payload) => {
    calls.posts.push({ url, payload });
    if (postError) throw postError;
    return { status: 201, data: created ?? { Number: payload.Number } };
  });
  kfSession.kfAxios.put = mock.fn(async (url, payload) => {
    calls.puts.push({ url, payload });
    if (putError) throw putError;
    const m = String(url).match(/\/quotes\/(\d+)$/);
    if (m && existing[`quotes/${m[1]}`]) existing[`quotes/${m[1]}`].ProjectNumber = payload.ProjectNumber;
    return { status: 200, data: payload };
  });
  return calls;
}

const kfFail = (msg) => Object.assign(new Error('400'), { response: { status: 400, data: { Message: msg } } });

let saved;
before(() => {
  saved = {
    INTERNAL: mdb.INTERNAL, REST: mdb.REST, withKfAuth: kfSession.withKfAuth,
    get: kfSession.kfAxios.get, post: kfSession.kfAxios.post, put: kfSession.kfAxios.put,
    pull: hcsSyncService.pullEntity, auto: process.env[AUTO],
  };
});
after(() => {
  mdb.INTERNAL = saved.INTERNAL;
  mdb.REST = saved.REST;
  kfSession.withKfAuth = saved.withKfAuth;
  Object.assign(kfSession.kfAxios, { get: saved.get, post: saved.post, put: saved.put });
  hcsSyncService.pullEntity = saved.pull;
  if (saved.auto === undefined) delete process.env[AUTO]; else process.env[AUTO] = saved.auto;
});

let rows;
let pulls;
const job = (uuid) => rows.find((r) => r.uuid === uuid);
function setup({ rest = {}, on = true } = {}) {
  rows = [enquiry(), won()];
  mdb.INTERNAL = { ...(mdb.INTERNAL || {}), jobRegister: fakeRegister(rows) };
  mdb.REST = { ...(mdb.REST || {}), ...fakeRest(rest) };
  pulls = [];
  hcsSyncService.pullEntity = async (kind, n) => { pulls.push(`${kind}/${n}`); return { ok: true }; };
  if (on) process.env[AUTO] = 'true'; else delete process.env[AUTO];
}

// ── Pure helpers ────────────────────────────────────────────────────────

describe('Automatic KashFlow: helpers', () => {
  it('is off unless switched on', () => {
    delete process.env[AUTO];
    assert.equal(kf.autoEnabled(), false);
    process.env[AUTO] = 'false';
    assert.equal(kf.autoEnabled(), false);
    process.env[AUTO] = 'true';
    assert.equal(kf.autoEnabled(), true);
  });

  it('says why a quote is not created automatically', () => {
    const j = enquiry();
    const q = j.quotes[0];
    assert.equal(autoQuoteSkip(j, q), null);
    assert.match(autoQuoteSkip({ ...j, customerCode: '' }, q), /no KashFlow customer/);
    assert.match(autoQuoteSkip(j, { ...q, sentAt: new Date() }), /already created/);
    assert.match(autoQuoteSkip(j, { ...q, number: undefined }), /no number/);
    assert.match(autoQuoteSkip(j, { ...q, status: 'lost' }), /lost/);
    assert.match(autoQuoteSkip(j, { ...q, value: undefined }), /no value/);
    assert.match(autoQuoteSkip({ ...j, cancelled: true }, q), /cancelled/);
    assert.match(autoQuoteSkip(null, q), /no longer exists/);
  });

  it('PUTs a quote back whole, request fields only, with the project number', () => {
    const body = quoteUpdatePayload({
      Number: 900102, Date: '2026-11-01T00:00:00', CustomerCode: 'CUST02', CustomerName: 'Sample Homes', CustomerReference: 'PO-9',
      NetAmount: 600, GrossAmount: 720, Permalink: 'x', ProjectNumber: null, Currency: { Code: 'GBP', ExchangeRate: 1, Symbol: '£' },
      LineItems: [{ Number: 1, Description: 'Paving', Quantity: 1, Rate: 600, VATLevel: 20, VATAmount: 120, NominalCode: 4000, ProductName: 'n/a' }],
      Addresses: [{ Line1: '1 Road', PostCode: 'AB1 2CD', CountryName: 'UK' }],
    }, 800201);
    assert.deepEqual(body, {
      Number: 900102, Date: '2026-11-01T00:00:00', CustomerCode: 'CUST02', CustomerReference: 'PO-9',
      Currency: { Code: 'GBP', ExchangeRate: 1 },
      LineItems: [{ Number: 1, Description: 'Paving', Quantity: 1, Rate: 600, VATLevel: 20, VATAmount: 120, NominalCode: 4000 }],
      Addresses: [{ Line1: '1 Road', PostCode: 'AB1 2CD' }],
      ProjectNumber: 800201,
    });
  });

  it('a won job first getting its project number calls onJobWon again', () => {
    const wonNoNumber = { won: true, quotes: [{ number: 1, status: 'won' }] };
    assert.deepEqual(stageHooks(wonNoNumber, { ...wonNoNumber, projectNumber: 2 }), ['onJobWon']);
    assert.deepEqual(stageHooks(wonNoNumber, { ...wonNoNumber, projectNumber: 2, completed: true }), ['onJobWon', 'onJobCompleted']);
    assert.deepEqual(stageHooks({ ...wonNoNumber, projectNumber: 2 }, { ...wonNoNumber, projectNumber: 3 }), [], 'a changed number is not a new win');
  });

  it('words a create the same for the buttons and the automatic create', () => {
    assert.deepEqual(createdNotice('Quote', { number: 5, rowNumber: 5, picked: false }), { type: 'success', text: 'Quote 5 created in KashFlow.' });
    assert.equal(createdNotice('Project', { number: 6, rowNumber: 5, picked: true, rowNotUpdated: true }).type, 'error');
  });
});

// ── A quote added ───────────────────────────────────────────────────────

describe('Automatic KashFlow: a quote added', () => {
  beforeEach(() => setup());

  it('creates the quote in KashFlow with the Create quote defaults', async () => {
    const calls = fakeKashflow();
    const r = await kf.autoCreateQuote(job('enq'), job('enq').quotes[0]);
    assert.equal(calls.posts.length, 1);
    assert.match(calls.posts[0].url, /\/quotes$/);
    assert.deepEqual(calls.posts[0].payload, {
      Date: '2026-11-02', CustomerCode: 'CUST01', Number: 900101, CustomerReference: 'PO-1',
      LineItems: [{ Description: 'Fencing — 1 Test Street, Testtown', Quantity: 1, Rate: 1250, VATLevel: 20, VATAmount: 250, NominalCode: 4000 }],
    });
    assert.deepEqual(r.notices, [{ type: 'success', text: 'Quote 900101 created in KashFlow.' }]);
    assert.ok(job('enq').quotes[0].sentAt instanceof Date);
    assert.deepEqual(pulls, ['quote/900101']);
  });

  it("puts a variation on the job's project only when the project is in KashFlow", async () => {
    let calls = fakeKashflow();
    await kf.autoCreateQuote(job('won'), job('won').quotes[1]);
    assert.equal('ProjectNumber' in calls.posts[0].payload, false, 'project not in KashFlow yet');

    setup({ rest: { projects: [800201] } });
    calls = fakeKashflow();
    await kf.autoCreateQuote(job('won'), job('won').quotes[1]);
    assert.equal(calls.posts[0].payload.ProjectNumber, 800201);
  });

  it('skips, calling nothing, when switched off, already in KashFlow, or the quote has nothing to create', async () => {
    const calls = fakeKashflow();
    setup({ on: false });
    assert.deepEqual(await kf.autoCreateQuote(job('enq'), job('enq').quotes[0]), { notices: [], skipped: 'switched off' });

    setup({ rest: { quotes: [900101] } });
    assert.match((await kf.autoCreateQuote(job('enq'), job('enq').quotes[0])).skipped, /already in KashFlow/);

    setup();
    job('enq').customerCode = '';
    assert.match((await kf.autoCreateQuote(job('enq'), job('enq').quotes[0])).skipped, /no KashFlow customer/);
    assert.match((await kf.autoCreateQuote(job('won'), job('won').quotes[0])).skipped, /already created/);
    job('won').quotes[1].value = undefined;
    const r = await kf.autoCreateQuote(job('won'), job('won').quotes[1]);
    assert.match(r.skipped, /no value/);
    assert.deepEqual(r.notices, []);
    assert.equal(calls.posts.length, 0);
    assert.equal(kfSession.kfAxios.get.mock.callCount(), 0);
  });

  it("skips quietly when this client's quote is already in KashFlow under the number", async () => {
    const calls = fakeKashflow({ existing: { 'quotes/900101': { Number: 900101, CustomerCode: 'CUST01' } } });
    const r = await kf.autoCreateQuote(job('enq'), job('enq').quotes[0]);
    assert.deepEqual(r.notices, []);
    assert.match(r.skipped, /already in KashFlow/);
    assert.equal(calls.posts.length, 0);
  });

  it("says what didn't happen and why when KashFlow refuses, without throwing", async () => {
    fakeKashflow({ postError: kfFail('Invalid customer') });
    const r = await kf.autoCreateQuote(job('enq'), job('enq').quotes[0]);
    assert.deepEqual(r.notices, [{ type: 'error', text: 'Quote 900101 was saved but not created in KashFlow: Invalid customer. Use Create quote to try again.' }]);
    assert.equal(job('enq').quotes[0].sentAt, undefined, 'the Create quote button is still offered');
    assert.equal(job('enq').quotes[0].sendingAt, undefined);
  });

  it('asks for Create quote when there is no usual nominal', async () => {
    setup({ rest: { nominal: null } });
    const calls = fakeKashflow();
    const r = await kf.autoCreateQuote(job('enq'), job('enq').quotes[0]);
    assert.match(r.notices[0].text, /no usual sales nominal/);
    assert.equal(calls.posts.length, 0);
  });

  it('never throws, even when the register itself fails', async () => {
    mdb.INTERNAL.jobRegister = { findOne: () => ({ lean: async () => { throw new Error('db down'); } }) };
    const r = await kf.autoCreateQuote(job('enq'), job('enq').quotes[0]);
    assert.equal(r.notices[0].type, 'error');
    assert.match(r.notices[0].text, /db down/);
  });
});

// ── A job won ───────────────────────────────────────────────────────────

describe('Automatic KashFlow: a job won', () => {
  beforeEach(() => setup());

  const existing = () => ({
    'quotes/900102': { Number: 900102, Date: '2026-11-01', CustomerCode: 'CUST02', LineItems: [{ Description: 'Paving', Quantity: 1, Rate: 600, VATLevel: 20, NominalCode: 4000 }] },
    'quotes/900104': { Number: 900104, CustomerCode: 'CUST02', LineItems: [] },
  });

  it('creates the project, then puts its quotes that are in KashFlow on it', async () => {
    const calls = fakeKashflow({ existing: existing() });
    const r = await kf.autoJobWon(job('won'));
    assert.equal(calls.posts.length, 1);
    assert.match(calls.posts[0].url, /\/projects$/);
    assert.equal(calls.posts[0].payload.Number, 800201);
    assert.ok(job('won').projectSentAt instanceof Date);
    assert.equal(calls.puts.length, 1, 'the lost quote and the one not in KashFlow are left alone');
    assert.match(calls.puts[0].url, /\/quotes\/900102$/);
    assert.equal(calls.puts[0].payload.ProjectNumber, 800201);
    assert.equal(calls.puts[0].payload.CustomerCode, 'CUST02');
    assert.deepEqual(calls.puts[0].payload.LineItems, existing()['quotes/900102'].LineItems, 'the full body goes back');
    assert.deepEqual(r.notices, [
      { type: 'success', text: 'Project 800201 created in KashFlow.' },
      { type: 'success', text: 'Quote 900102 put on project 800201 in KashFlow.' },
    ]);
  });

  it('does nothing the second time (idempotent)', async () => {
    const ex = existing();
    let calls = fakeKashflow({ existing: ex });
    await kf.autoJobWon(job('won'));
    calls = fakeKashflow({ existing: ex });
    const r = await kf.autoJobWon(job('won'));
    assert.equal(calls.posts.length, 0);
    assert.equal(calls.puts.length, 0);
    assert.deepEqual(r.notices, []);
  });

  it("uses a project already in KashFlow, and a synced quote; leaves another customer's quote alone", async () => {
    setup({ rest: { projects: [800201], quotes: [900103] } });
    const ex = { ...existing(), 'quotes/900103': { Number: 900103, CustomerCode: 'OTHER' } };
    const calls = fakeKashflow({ existing: ex });
    const r = await kf.autoJobWon(job('won'));
    assert.equal(calls.posts.length, 0, 'no project created');
    assert.deepEqual(calls.puts.map((p) => p.url.match(/(\d+)$/)[1]), ['900102']);
    assert.deepEqual(r.notices, [{ type: 'success', text: 'Quote 900102 put on project 800201 in KashFlow.' }]);
  });

  it("treats this client's project already in KashFlow (not synced) as there", async () => {
    const calls = fakeKashflow({ existing: { ...existing(), 'projects/800201': { Number: 800201, CustomerCode: 'CUST02' } } });
    const r = await kf.autoJobWon(job('won'));
    assert.equal(calls.posts.length, 0);
    assert.equal(calls.puts.length, 1);
    assert.equal(r.notices.length, 1);
  });

  it('waits for the project number, and is off when switched off', async () => {
    let calls = fakeKashflow();
    const noNumber = { ...job('won') };
    delete job('won').projectNumber;
    let r = await kf.autoJobWon(noNumber);
    assert.match(r.skipped, /no project number/);
    assert.match(r.notices[0].text, /when the job has its project number/);
    setup({ on: false });
    calls = fakeKashflow();
    r = await kf.autoJobWon(job('won'));
    assert.deepEqual(r, { notices: [], skipped: 'switched off' });
    assert.equal(calls.posts.length + calls.puts.length, 0);
  });

  it("says the project wasn't created, and puts no quotes on it, when KashFlow refuses", async () => {
    const calls = fakeKashflow({ existing: existing(), postError: kfFail('Customer is archived') });
    const r = await kf.autoJobWon(job('won'));
    assert.deepEqual(r.notices, [{ type: 'error', text: "Project 800201 wasn't created in KashFlow: Customer is archived. Use Create project to try again." }]);
    assert.equal(calls.puts.length, 0);
    assert.equal(job('won').projectSentAt, undefined, 'the Create project button is still offered');
  });

  it("says which quote couldn't be put on the project", async () => {
    setup({ rest: { projects: [800201] } });
    fakeKashflow({ existing: existing(), putError: kfFail('Quote is locked') });
    const r = await kf.autoJobWon(job('won'));
    assert.deepEqual(r.notices, [{ type: 'error', text: "Quote 900102 couldn't be put on project 800201 in KashFlow: Quote is locked" }]);
  });
});

// ── Through the hooks and the controller ────────────────────────────────

describe('Automatic KashFlow: through the hooks', () => {
  beforeEach(() => setup());

  it('fireQuoteAdded and fireStageHooks pass the notices back and never throw', async () => {
    fakeKashflow({ postError: kfFail('Service unavailable') });
    const notices = [];
    await lifecycle.fireQuoteAdded(job('enq'), job('enq').quotes[0], lifecycle, notices);
    const before = copy(job('enq'));
    job('enq').projectNumber = 800300;
    const names = await lifecycle.fireStageHooks(before, job('enq'), lifecycle, notices);
    assert.deepEqual(names, ['onJobWon']);
    assert.equal(notices.length, 2);
    assert.match(notices[0].text, /^Quote 900101 was saved but not created in KashFlow: Service unavailable/);
    assert.match(notices[1].text, /^Project 800300 wasn't created in KashFlow: Service unavailable/);
  });

  it('a hook that throws adds nothing and the save goes on', async () => {
    const notices = [];
    const hooks = { onJobWon: async () => { throw new Error('boom'); } };
    assert.deepEqual(await lifecycle.fireStageHooks({ quotes: [{ number: 1, status: 'quoted' }] }, { projectNumber: 2 }, hooks, notices), ['onJobWon']);
    assert.deepEqual(notices, []);
  });
});

describe('Automatic KashFlow: the flash', () => {
  let savedAdd;
  before(() => { savedAdd = jobRegister.addQuote; });
  after(() => { jobRegister.addQuote = savedAdd; });
  afterEach(() => { jobRegister.addQuote = savedAdd; });

  it("flashes the save, then what the hooks said, and still goes back to the job", async () => {
    jobRegister.addQuote = async (uuid, body, notices) => {
      notices.push({ type: 'error', text: 'Quote 900101 was saved but not created in KashFlow: Invalid customer. Use Create quote to try again.' });
      return { job: {}, quote: { number: 900101 } };
    };
    const flashes = [];
    const req = { params: { uuid: 'enq' }, body: {}, flash: (type, text) => flashes.push([type, text]) };
    let redirected = null;
    await ctrl.postAddQuote(req, { redirect: (u) => { redirected = u; } }, (err) => { throw err; });
    assert.deepEqual(flashes, [
      ['success', 'Added quote 900101.'],
      ['error', 'Quote 900101 was saved but not created in KashFlow: Invalid customer. Use Create quote to try again.'],
    ]);
    assert.equal(redirected, '/job-register/enq#quotes');
  });
});

// ── OneDrive folders ────────────────────────────────────────────────────
//
// oneDriveFolderService is never called for real: its functions on the
// default export (what the lifecycle calls through) are replaced with fakes.

describe('OneDrive folders on quote, win and completion', () => {
  const FNS = ['ensureQuoteFolder', 'moveToLive', 'moveToCompleted', 'findJobFolder'];
  let savedOd;
  let calls;
  const folder = (id, path) => ({ id, name: path.split('/').pop(), webUrl: `https://example.test/${id}`, path });
  const fakeOneDrive = (answers = {}) => {
    calls = {};
    for (const fn of FNS) {
      calls[fn] = [];
      oneDrive[fn] = async (args) => {
        calls[fn].push(args);
        const a = answers[fn];
        if (a instanceof Error) throw a;
        return typeof a === 'function' ? a(args) : a;
      };
    }
  };
  before(() => { savedOd = Object.fromEntries(FNS.map((fn) => [fn, oneDrive[fn]])); });
  after(() => Object.assign(oneDrive, savedOd));
  beforeEach(() => setup({ on: false }));

  it('the first quote gets its quote folder, kept on the job', async () => {
    fakeOneDrive({ ensureQuoteFolder: folder('F1', 'Jobs & Quotes/3. QUOTES 2026/900101 1 Test Street') });
    const notices = await lifecycle.onQuoteAdded(job('enq'), job('enq').quotes[0]);
    assert.deepEqual(calls.ensureQuoteFolder, [{ quoteNumber: 900101, site: '1 Test Street, Testtown', quoteDate: d('2026-11-02') }]);
    assert.deepEqual(notices, []);
    assert.equal(job('enq').oneDriveFolderId, 'F1');
    assert.equal(job('enq').oneDriveFolderUrl, 'https://example.test/F1');
    assert.equal(job('enq').oneDriveFolderPath, 'Jobs & Quotes/3. QUOTES 2026/900101 1 Test Street');
  });

  it("a variation, a live job, or a job with its folder doesn't get a quote folder", async () => {
    fakeOneDrive({ ensureQuoteFolder: folder('F1', 'x') });
    job('enq').quotes.push({ _id: Q2, number: 900105, status: 'quoted' });
    await lifecycle.onQuoteAdded(job('enq'), job('enq').quotes[1]);
    await lifecycle.onQuoteAdded(job('won'), job('won').quotes[1]);
    job('enq').oneDriveFolderId = 'F0';
    await lifecycle.onQuoteAdded(job('enq'), job('enq').quotes[0]);
    assert.equal(calls.ensureQuoteFolder.length, 0);
  });

  it('a won job moves its folder to the live jobs folder, by the folder kept on it', async () => {
    job('won').oneDriveFolderId = 'F1';
    fakeOneDrive({ moveToLive: folder('F1', 'Jobs & Quotes/1.1 LIVE JOBS 2026/800201 2 Sample Road') });
    const notices = await lifecycle.onJobWon(job('won'));
    assert.equal(calls.moveToLive.length, 1);
    const a = calls.moveToLive[0];
    assert.deepEqual({ ...a, wonDate: a.wonDate instanceof Date }, {
      quoteNumber: 900102, projectNumber: 800201, site: '2 Sample Road', quoteDate: undefined, wonDate: true, folderId: 'F1',
    });
    assert.deepEqual(notices, []);
    assert.equal(job('won').oneDriveFolderPath, 'Jobs & Quotes/1.1 LIVE JOBS 2026/800201 2 Sample Road');
  });

  it('waits for the project number before moving to live', async () => {
    fakeOneDrive({ moveToLive: folder('F1', 'x') });
    delete job('won').projectNumber;
    assert.deepEqual(await lifecycle.onJobWon(job('won')), []);
    assert.equal(calls.moveToLive.length, 0);
  });

  it('a completed job moves its folder to Completed Jobs', async () => {
    Object.assign(job('won'), { oneDriveFolderId: 'F1', completed: true });
    fakeOneDrive({ moveToCompleted: folder('F1', 'Jobs & Quotes/1.1 LIVE JOBS 2026/Completed Jobs/800201 2 Sample Road') });
    assert.deepEqual(await lifecycle.onJobCompleted(job('won')), []);
    assert.deepEqual(calls.moveToCompleted, [{ projectNumber: 800201, site: '2 Sample Road', wonDate: d('2026-11-10'), folderId: 'F1' }]);
    assert.match(job('won').oneDriveFolderPath, /Completed Jobs/);
  });

  it('OneDrive switched off: nothing kept, nothing said', async () => {
    const skipped = { skipped: 'not configured' };
    fakeOneDrive({ ensureQuoteFolder: skipped, moveToLive: skipped, moveToCompleted: skipped });
    assert.deepEqual(await lifecycle.onQuoteAdded(job('enq'), job('enq').quotes[0]), []);
    assert.deepEqual(await lifecycle.onJobWon(job('won')), []);
    assert.deepEqual(await lifecycle.onJobCompleted(job('won')), []);
    assert.equal(job('enq').oneDriveFolderId, undefined);
    assert.equal(job('won').oneDriveFolderId, undefined);
  });

  it("says what couldn't be done and why, never throwing", async () => {
    fakeOneDrive({
      ensureQuoteFolder: new Error('OneDrive: the top folder "Jobs & Quotes" was not found.'),
      moveToLive: new Error('Graph says no'),
      moveToCompleted: new Error('OneDrive: no folder for job 800201 was found.'),
    });
    assert.deepEqual(await lifecycle.onQuoteAdded(job('enq'), job('enq').quotes[0]), [
      { type: 'error', text: 'The OneDrive folder couldn\'t be created: OneDrive: the top folder "Jobs & Quotes" was not found.' },
    ]);
    assert.deepEqual(await lifecycle.onJobWon(job('won')), [{ type: 'error', text: "The OneDrive folder couldn't be moved to the live jobs folder: Graph says no" }]);
    const notices = [];
    await lifecycle.fireStageHooks({ ...job('won') }, { ...job('won'), completed: true }, lifecycle, notices);
    assert.deepEqual(notices, [{ type: 'error', text: "The OneDrive folder couldn't be moved to Completed Jobs: OneDrive: no folder for job 800201 was found." }]);
    assert.equal(job('won').oneDriveFolderId, undefined);
  });

  it("keeps no link that isn't https", async () => {
    fakeOneDrive({ ensureQuoteFolder: { id: 'F9', webUrl: 'javascript:alert(1)', path: 'p' } });
    await lifecycle.onQuoteAdded(job('enq'), job('enq').quotes[0]);
    assert.equal(job('enq').oneDriveFolderId, 'F9');
    assert.equal(job('enq').oneDriveFolderUrl, undefined);
  });

  describe('Find folder', () => {
    it('finds the folder by the project and quote numbers and keeps it', async () => {
      fakeOneDrive({ findJobFolder: folder('F7', 'Jobs & Quotes/1.1 LIVE JOBS 2025/800201 2 Sample Road') });
      const r = await lifecycle.findFolder('won');
      assert.deepEqual(calls.findJobFolder, [{ quoteNumber: 900102, projectNumber: 800201 }]);
      assert.equal(r.folder.id, 'F7');
      assert.equal(job('won').oneDriveFolderId, 'F7');
    });

    it('leaves a job with a folder alone, and says when OneDrive is off or nothing was found', async () => {
      fakeOneDrive({ findJobFolder: null });
      assert.deepEqual(await lifecycle.findFolder('enq'), { folder: null });
      fakeOneDrive({ findJobFolder: { skipped: 'not configured' } });
      assert.deepEqual(await lifecycle.findFolder('enq'), { skipped: 'not configured' });
      job('enq').oneDriveFolderId = 'F0';
      assert.equal((await lifecycle.findFolder('enq')).already, true);
      assert.equal(calls.findJobFolder.length, 1);
      await assert.rejects(lifecycle.findFolder('nope'), (e) => e.status === 404);
    });

    it('flashes what happened and goes back to the job', async () => {
      const run = async () => {
        const flashes = [];
        let to = null;
        await ctrl.postFindFolder({ params: { uuid: 'won' }, flash: (t, m) => flashes.push([t, m]) }, { redirect: (u) => { to = u; } }, (e) => { throw e; });
        return { flashes, to };
      };
      fakeOneDrive({ findJobFolder: folder('F7', 'Jobs & Quotes/1.1 LIVE JOBS 2025/800201 2 Sample Road') });
      assert.deepEqual(await run(), { flashes: [['success', 'Found the OneDrive folder: Jobs & Quotes/1.1 LIVE JOBS 2025/800201 2 Sample Road.']], to: '/job-register/won' });
      setup({ on: false });
      fakeOneDrive({ findJobFolder: new Error('Graph is down') });
      assert.deepEqual((await run()).flashes, [['error', "The OneDrive folder couldn't be found: Graph is down"]]);
    });
  });

  it('the job page links the folder, or offers Find folder', async () => {
    const view = path.join(root, 'mongoose/views/tailwindcss/jobRegister/show.ejs');
    const j = won();
    const locals = (over) => ({
      csrfToken: 't', job: j, stage: stageOf(j), values: jobValues(j), match: matchJob(j, {}), next: {}, stageLabels: STAGE_LABELS,
      quoteStatuses: QUOTE_STATUSES, quoteStatusLabels: QUOTE_STATUS_LABELS, canEdit: true, canCreate: { project: false, quotes: {} },
      editQuote: null, editInvoice: null, crumbs: [], title: 'Job', ...over,
    });
    const linked = await ejs.renderFile(view, locals({ job: { ...j, oneDriveFolderId: 'F1', oneDriveFolderUrl: 'https://example.test/F1', oneDriveFolderPath: 'Jobs/800201' }, oneDriveOn: true }));
    assert.match(linked, /<a href="https:\/\/example\.test\/F1" target="_blank" rel="noopener"[^>]*>.*OneDrive folder<\/a>/);
    assert.doesNotMatch(linked, /onedrive-folder"/);
    const find = await ejs.renderFile(view, locals({ oneDriveOn: true }));
    assert.match(find, /action="\/job-register\/won\/onedrive-folder"/);
    assert.match(find, /Find folder/);
    assert.doesNotMatch(await ejs.renderFile(view, locals({ oneDriveOn: true, canEdit: false })), /onedrive-folder/);
    assert.doesNotMatch(await ejs.renderFile(view, locals({ oneDriveOn: false })), /OneDrive folder/, 'nothing when OneDrive is off and the job has none');
  });
});
