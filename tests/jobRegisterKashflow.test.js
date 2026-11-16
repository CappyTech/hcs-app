import { describe, it, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';

/*
 * Create in KashFlow from a Job Register row. KashFlow is never called: the
 * kfSession singleton's withKfAuth and kfAxios.get/post are replaced with
 * fakes, hcs-sync's pull is a fake, and the register collection is an
 * in-memory stand-in on mdb.INTERNAL.
 */
import kfSession from '../services/kashflowSessionService.js';
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import hcsSyncService from '../mongoose/services/hcsSyncService.js';
import kf, {
  lineText, quoteFormDefaults, parseQuoteForm, quoteTotals, buildQuotePayload, buildProjectPayload,
  numberPlan, cannotCreate, kfError, VAT_CHOICES,
} from '../mongoose/services/jobRegisterKashflowService.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const d = (s) => new Date(`${s}T12:00:00Z`);

// Made-up rows: no real clients, sites or numbers
const quoteRow = () => ({
  uuid: 'row-q', quoteNumber: 900101, quoteDate: d('2026-11-02'), site: '1 Test Street, Testtown',
  customerCode: 'CUST01', client: 'Test Client Ltd', value: 1250, description: 'Fencing', clientRef: 'PO-1',
});
const wonRow = () => ({
  uuid: 'row-p', quoteNumber: 900102, projectNumber: 800201, jobDate: d('2026-11-10'), site: '2 Sample Road',
  customerCode: 'CUST02', client: 'Sample Homes', value: 600, description: 'Paving',
});

// ── Pure helpers ────────────────────────────────────────────────────────

describe('Create quote form', () => {
  it('starts with one line for the whole job at the register value', () => {
    const f = quoteFormDefaults(quoteRow(), { nominal: 4000 });
    assert.equal(f.date, '2026-11-02');
    assert.equal(f.reference, 'PO-1');
    assert.deepEqual(f.lines, [{ description: 'Fencing — 1 Test Street, Testtown', quantity: '1', rate: '1250.00', vat: '20', nominal: '4000' }]);
  });

  it("uses today when the row has no quote date, and the site alone when there's no description", () => {
    const f = quoteFormDefaults({ ...quoteRow(), quoteDate: null, description: '' }, { now: d('2026-11-16') });
    assert.equal(f.date, '2026-11-16');
    assert.equal(f.lines[0].nominal, '');
    assert.equal(lineText({ site: 'Only Site' }), 'Only Site');
  });

  it('drops cleared lines and reads the rest', () => {
    const r = parseQuoteForm({
      date: '2026-11-02', reference: 'PO-1',
      lines: {
        0: { description: 'Labour', quantity: '2', rate: '£1,000.50', vat: '20', nominal: '4000' },
        1: { description: '', quantity: '', rate: '', vat: '20', nominal: '4000' },
        2: { description: 'Skip hire', quantity: '', rate: '200', vat: 'rc', nominal: '4010' },
      },
    });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.lines.length, 2);
    assert.deepEqual(r.lines[0], { description: 'Labour', quantity: 2, rate: 1000.5, vat: '20', level: 20, nominal: 4000 });
    assert.equal(r.lines[1].quantity, 1, 'a blank quantity is 1');
    assert.equal(r.lines[1].level, 0, 'reverse charge carries no VAT');
    assert.equal(r.values.lines.length, 2);
  });

  it('says what is wrong, by line', () => {
    const r = parseQuoteForm({ date: '02/11/2026', lines: [{ description: 'X', quantity: '0', rate: 'abc', vat: '17', nominal: '' }] });
    assert.equal(r.ok, false);
    assert.ok(r.errors.date);
    for (const k of ['quantity', 'rate', 'vat', 'nominal']) assert.ok(r.errors[`lines.0.${k}`], k);
    assert.ok(parseQuoteForm({ date: '2026-11-02', lines: [] }).errors.lines);
  });

  it('totals the lines: net, VAT per line, gross', () => {
    const { lines } = parseQuoteForm({ date: '2026-11-02', lines: [
      { description: 'A', quantity: '1', rate: '1000', vat: '20', nominal: '1' },
      { description: 'B', quantity: '3', rate: '33.33', vat: '5', nominal: '1' },
      { description: 'C', quantity: '1', rate: '50', vat: 'rc', nominal: '1' },
    ] });
    assert.deepEqual(quoteTotals(lines), { net: 1149.99, vat: 205, gross: 1354.99 });
  });

  it('offers 20%, 5%, 0% and reverse charge', () => {
    assert.deepEqual(VAT_CHOICES.map((c) => c.value), ['20', '5', '0', 'rc']);
  });
});

describe('KashFlow payloads', () => {
  const { lines } = parseQuoteForm({ date: '2026-11-02', lines: [{ description: 'Fencing — 1 Test Street', quantity: '1', rate: '1250', vat: '20', nominal: '4000' }] });

  it("builds the quote with the row's customer and number", () => {
    const p = buildQuotePayload(quoteRow(), { date: '2026-11-02', reference: 'PO-1', lines });
    assert.deepEqual(p, {
      Number: 900101, Date: '2026-11-02', CustomerCode: 'CUST01', CustomerReference: 'PO-1',
      LineItems: [{ Description: 'Fencing — 1 Test Street', Quantity: 1, Rate: 1250, VATLevel: 20, VATAmount: 250, NominalCode: 4000 }],
    });
  });

  it('leaves the number out for KashFlow to pick', () => {
    const p = buildQuotePayload(quoteRow(), { date: '2026-11-02', reference: '', lines }, { number: null });
    assert.equal('Number' in p, false);
    assert.equal('CustomerReference' in p, false);
  });

  it('builds the project: named after the site, starting on the job date', () => {
    assert.deepEqual(buildProjectPayload(wonRow()), {
      Number: 800201, Name: '2 Sample Road', CustomerCode: 'CUST02', StartDate: '2026-11-10', Description: 'Paving',
    });
    assert.equal('Number' in buildProjectPayload(wonRow(), { number: null }), false);
  });
});

describe('When the number is taken', () => {
  it("uses a free number, lets KashFlow pick if another client has it, stops if it's this client's", () => {
    assert.equal(numberPlan(quoteRow(), null), 'use');
    assert.equal(numberPlan(quoteRow(), { Number: 900101, CustomerCode: 'OTHER' }), 'pick');
    assert.equal(numberPlan(quoteRow(), { Number: 900101, CustomerCode: 'cust01' }), 'stop');
  });
});

describe('Which rows can be created', () => {
  it('needs a KashFlow customer, a number, and not done already', () => {
    assert.equal(cannotCreate(quoteRow(), 'quote'), null);
    assert.match(cannotCreate({ ...quoteRow(), customerCode: '' }, 'quote'), /KashFlow customers/);
    assert.match(cannotCreate({ ...quoteRow(), cancelled: true }, 'quote'), /cancelled/);
    assert.match(cannotCreate({ ...quoteRow(), quoteSentAt: new Date() }, 'quote'), /already created/);
    assert.match(cannotCreate(quoteRow(), 'project'), /isn't won/);
    assert.equal(cannotCreate(wonRow(), 'project'), null);
    assert.match(cannotCreate({ ...wonRow(), projectSentAt: new Date() }, 'project'), /already created/);
    assert.match(cannotCreate(null, 'quote'), /no longer exists/);
  });

  it("reads KashFlow's error message", () => {
    assert.equal(kfError({ response: { data: { Message: 'Customer not found' } } }), 'Customer not found');
    assert.equal(kfError(new Error('timeout')), 'timeout');
  });
});

// ── Creating, against a fake KashFlow ───────────────────────────────────

const saved = { INTERNAL: mdb.INTERNAL.jobRegister, withKfAuth: kfSession.withKfAuth, get: kfSession.kfAxios.get, post: kfSession.kfAxios.post, pull: hcsSyncService.pullEntity };
after(() => {
  mdb.INTERNAL.jobRegister = saved.INTERNAL;
  kfSession.withKfAuth = saved.withKfAuth;
  kfSession.kfAxios.get = saved.get;
  kfSession.kfAxios.post = saved.post;
  hcsSyncService.pullEntity = saved.pull;
});

/** One-collection stand-in: enough of findOne / findOneAndUpdate / updateOne for the service. */
function fakeRegister(rows, { takenNumbers = [] } = {}) {
  const byUuid = (uuid) => rows.find((r) => r.uuid === uuid) || null;
  const lean = (v) => ({ lean: async () => (v ? structuredClone(v) : null) });
  const isNull = (v) => v == null;
  return {
    findOne: ({ uuid }) => lean(byUuid(uuid)),
    findOneAndUpdate: (filter, update) => {
      const r = byUuid(filter.uuid);
      const sentKey = Object.keys(filter).find((k) => k.endsWith('SentAt'));
      const claimKey = Object.keys(filter.$or[0])[0];
      const stale = filter.$or[1][claimKey].$lt;
      const ok = r && isNull(r[sentKey]) && (isNull(r[claimKey]) || r[claimKey] < stale);
      if (ok) Object.assign(r, update.$set);
      return lean(ok ? r : null);
    },
    updateOne: async ({ uuid }, update) => {
      const r = byUuid(uuid);
      for (const k of ['quoteNumber', 'projectNumber']) {
        if (update.$set?.[k] != null && takenNumbers.includes(update.$set[k])) throw Object.assign(new Error('dup'), { code: 11000 });
      }
      Object.assign(r, update.$set || {});
      for (const k of Object.keys(update.$unset || {})) delete r[k];
      return { modifiedCount: 1 };
    },
  };
}

/** Fake KashFlow: `existing` is what GET /quotes|projects/{n} finds; POST answers `created`. */
function fakeKashflow({ existing = {}, created = null, postError = null } = {}) {
  const posts = [];
  kfSession.withKfAuth = async (fn) => fn('test-token');
  kfSession.kfAxios.get = mock.fn(async (url) => {
    const m = String(url).match(/\/(quotes|projects)\/(\d+)$/);
    const hit = m && existing[`${m[1]}/${m[2]}`];
    if (hit) return { data: hit };
    throw Object.assign(new Error('Not found'), { response: { status: 404 } });
  });
  kfSession.kfAxios.post = mock.fn(async (url, payload, opts) => {
    posts.push({ url, payload, auth: opts?.headers?.Authorization });
    if (postError) throw postError;
    return { status: 201, data: created ?? { Number: payload.Number } };
  });
  return posts;
}

const quoteBody = { date: '2026-11-02', reference: 'PO-1', lines: [{ description: 'Fencing — 1 Test Street', quantity: '1', rate: '1250', vat: '20', nominal: '4000' }] };

describe('createQuote', () => {
  let rows;
  let pulls;
  beforeEach(() => {
    rows = [quoteRow(), wonRow()];
    mdb.INTERNAL.jobRegister = fakeRegister(rows);
    pulls = [];
    hcsSyncService.pullEntity = async (kind, n) => { pulls.push(`${kind}/${n}`); return { ok: true }; };
  });

  it("creates the quote under the row's number and marks the row", async () => {
    const posts = fakeKashflow();
    const r = await kf.createQuote('row-q', quoteBody);
    assert.deepEqual(r, { number: 900101, rowNumber: 900101, picked: false, rowNotUpdated: false });
    assert.equal(posts.length, 1);
    assert.match(posts[0].url, /\/quotes$/);
    assert.equal(posts[0].auth, 'KfToken test-token');
    assert.equal(posts[0].payload.Number, 900101);
    assert.equal(posts[0].payload.CustomerCode, 'CUST01');
    assert.ok(rows[0].quoteSentAt instanceof Date);
    assert.equal(rows[0].quoteSendingAt, undefined, 'the claim is released');
    assert.deepEqual(pulls, ['quote/900101'], 'hcs-sync pulls the new quote');
  });

  it("lets KashFlow pick when another client has the number, and changes the row's number", async () => {
    const posts = fakeKashflow({ existing: { 'quotes/900101': { Number: 900101, CustomerCode: 'OTHER' } }, created: { Number: 900150 } });
    const r = await kf.createQuote('row-q', quoteBody);
    assert.equal('Number' in posts[0].payload, false);
    assert.deepEqual(r, { number: 900150, rowNumber: 900101, picked: true, rowNotUpdated: false });
    assert.equal(rows[0].quoteNumber, 900150);
  });

  it('keeps the send but not the number when another register row already has the picked number', async () => {
    mdb.INTERNAL.jobRegister = fakeRegister(rows, { takenNumbers: [900150] });
    fakeKashflow({ existing: { 'quotes/900101': { Number: 900101, CustomerCode: 'OTHER' } }, created: { Number: 900150 } });
    const r = await kf.createQuote('row-q', quoteBody);
    assert.equal(r.rowNotUpdated, true);
    assert.equal(rows[0].quoteNumber, 900101);
    assert.ok(rows[0].quoteSentAt);
  });

  it("creates nothing when this client's quote is already there under the number", async () => {
    const posts = fakeKashflow({ existing: { 'quotes/900101': { Number: 900101, CustomerCode: 'CUST01' } } });
    await assert.rejects(() => kf.createQuote('row-q', quoteBody), (e) => e.status === 400 && /already in KashFlow for this client/.test(e.message));
    assert.equal(posts.length, 0);
    assert.equal(rows[0].quoteSentAt, undefined);
    assert.equal(rows[0].quoteSendingAt, undefined);
    assert.deepEqual(pulls, ['quote/900101'], 'asks hcs-sync to pull it so it matches');
  });

  it("passes KashFlow's error on and frees the row for another go", async () => {
    fakeKashflow({ postError: Object.assign(new Error('400'), { response: { status: 400, data: { Message: 'Invalid nominal' } } }) });
    await assert.rejects(() => kf.createQuote('row-q', quoteBody), /KashFlow didn't create the quote: Invalid nominal/);
    assert.equal(rows[0].quoteSentAt, undefined);
    assert.equal(rows[0].quoteSendingAt, undefined);
  });

  it("doesn't send a form with problems, or a row already sent or being sent", async () => {
    const posts = fakeKashflow();
    await assert.rejects(() => kf.createQuote('row-q', { ...quoteBody, lines: [] }), (e) => e.status === 400 && Boolean(e.form));
    rows[0].quoteSendingAt = new Date();
    await assert.rejects(() => kf.createQuote('row-q', quoteBody), /already being created/);
    rows[0].quoteSentAt = new Date();
    await assert.rejects(() => kf.createQuote('row-q', quoteBody), /already created/);
    await assert.rejects(() => kf.createQuote('nope', quoteBody), (e) => e.status === 404);
    assert.equal(posts.length, 0);
  });

  it('takes over a claim left behind by a crash', async () => {
    fakeKashflow();
    rows[0].quoteSendingAt = new Date(Date.now() - 10 * 60 * 1000);
    const r = await kf.createQuote('row-q', quoteBody);
    assert.equal(r.number, 900101);
  });

  it("still succeeds when hcs-sync can't be reached", async () => {
    fakeKashflow();
    hcsSyncService.pullEntity = async () => { throw new Error('down'); };
    const r = await kf.createQuote('row-q', quoteBody);
    assert.equal(r.number, 900101);
  });
});

describe('createProject', () => {
  let rows;
  beforeEach(() => {
    rows = [quoteRow(), wonRow()];
    mdb.INTERNAL.jobRegister = fakeRegister(rows);
    hcsSyncService.pullEntity = async () => ({ ok: true });
  });

  it("creates the project from the won row", async () => {
    const posts = fakeKashflow();
    const r = await kf.createProject('row-p');
    assert.equal(r.number, 800201);
    assert.match(posts[0].url, /\/projects$/);
    assert.deepEqual(posts[0].payload, { Number: 800201, Name: '2 Sample Road', CustomerCode: 'CUST02', StartDate: '2026-11-10', Description: 'Paving' });
    assert.ok(rows[1].projectSentAt);
  });

  it('lets KashFlow pick when the number is taken by another client', async () => {
    const posts = fakeKashflow({ existing: { 'projects/800201': { Number: 800201, CustomerCode: 'OTHER' } }, created: { Number: 800230 } });
    const r = await kf.createProject('row-p');
    assert.equal('Number' in posts[0].payload, false);
    assert.equal(r.picked, true);
    assert.equal(rows[1].projectNumber, 800230);
  });

  it("won't create a project for a row that isn't won", async () => {
    const posts = fakeKashflow();
    await assert.rejects(() => kf.createProject('row-q'), /isn't won/);
    assert.equal(posts.length, 0);
  });
});

// ── Views ───────────────────────────────────────────────────────────────

describe('Create in KashFlow views', () => {
  const views = path.join(root, 'mongoose/views/tailwindcss/jobRegister');
  const render = (file, locals) => ejs.renderFile(path.join(views, file), { csrfToken: 't', ...locals });

  it('the quote page shows the register value beside the lines and warns when they differ', async () => {
    const entry = { ...quoteRow(), value: 1000 };
    const values = quoteFormDefaults(quoteRow(), { nominal: 4000 });
    const html = await render('kashflow-quote.ejs', {
      entry, values, errors: {}, totals: quoteTotals(parseQuoteForm(values).lines),
      nominals: [{ code: 4000, name: 'Sales' }], defaultNominal: 4000, vatChoices: VAT_CHOICES, crumbs: [], title: 'Create quote',
    });
    assert.match(html, /Register value \(net\)/);
    assert.match(html, /£1,000\.00/);
    assert.match(html, /£1,250\.00/);
    assert.match(html, /data-price-differs/);
    assert.match(html, /name="action" value="create"/);
    assert.match(html, /name="_csrf"/);
    assert.doesNotMatch(html, /<script/);
  });

  it('the row page offers the buttons only where the record is missing and the user may', async () => {
    const entry = wonRow();
    const match = {
      quote: { state: 'missing', record: null, issues: [] },
      project: { state: 'missing', record: null, issues: [] },
      invoice: { state: 'none', record: null, issues: [] },
    };
    const locals = {
      entry, stage: 'won', stageLabels: { won: 'Won' }, match, next: {}, clients: [], contracts: [], customers: [], crumbs: [], title: 'Job',
    };
    const yes = await render('edit.ejs', { ...locals, canCreate: { quote: true, project: true } });
    assert.match(yes, /\/job-register\/row-p\/kashflow-quote/);
    assert.match(yes, /action="\/job-register\/row-p\/kashflow-project"/);
    const no = await render('edit.ejs', { ...locals, canCreate: { quote: false, project: false } });
    assert.doesNotMatch(no, /kashflow-quote|kashflow-project/);
    const sent = await render('edit.ejs', { ...locals, entry: { ...entry, projectSentAt: d('2026-11-12') }, canCreate: { quote: true, project: false } });
    assert.match(sent, /Created in KashFlow from here on 12\/11\/2026/);
  });
});
