import { describe, it, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import mongoose from 'mongoose';

/*
 * Create in KashFlow from a Job Register job (its project) or one of its quotes. KashFlow is never called: the
 * kfSession singleton's withKfAuth and kfAxios.get/post are replaced with
 * fakes, hcs-sync's pull is a fake, and the register collection is an
 * in-memory stand-in on mdb.INTERNAL.
 */
import kfSession from '../services/kashflowSessionService.js';
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import hcsSyncService from '../mongoose/services/hcsSyncService.js';
import kf, {
  lineText, findQuote, quoteFormDefaults, parseQuoteForm, quoteTotals, buildQuotePayload, buildProjectPayload,
  numberPlan, cannotCreate, kfError, VAT_CHOICES,
} from '../mongoose/services/jobRegisterKashflowService.js';
import { matchJob, stageOf, jobValues, STAGE_LABELS, QUOTE_STATUSES, QUOTE_STATUS_LABELS } from '../mongoose/services/jobRegisterService.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const d = (s) => new Date(`${s}T12:00:00Z`);

// Made-up jobs: no real clients, sites or numbers
const QID = new mongoose.Types.ObjectId();
const VID = new mongoose.Types.ObjectId();
const PQID = new mongoose.Types.ObjectId();
const quoteRow = () => ({
  uuid: 'row-q', site: '1 Test Street, Testtown', customerCode: 'CUST01', client: 'Test Client Ltd', description: 'Fencing', clientRef: 'PO-1',
  quotes: [{ _id: QID, number: 900101, date: d('2026-11-02'), value: 1250, status: 'quoted' }],
});
const wonRow = () => ({
  uuid: 'row-p', projectNumber: 800201, jobDate: d('2026-11-10'), site: '2 Sample Road',
  customerCode: 'CUST02', client: 'Sample Homes', description: 'Paving',
  quotes: [{ _id: PQID, number: 900102, value: 600, status: 'won', sentAt: d('2026-11-01') }, { _id: VID, number: 900103, value: 200, status: 'quoted', description: 'Extra wall' }],
});
const quoteOf = (row, id = QID) => findQuote(row, id);

// ── Pure helpers ────────────────────────────────────────────────────────

describe('Create quote form', () => {
  it("starts with one line for the whole quote at the quote's value", () => {
    const f = quoteFormDefaults(quoteRow(), quoteOf(quoteRow()), { nominal: 4000 });
    assert.equal(f.date, '2026-11-02');
    assert.equal(f.reference, 'PO-1');
    assert.deepEqual(f.lines, [{ description: 'Fencing — 1 Test Street, Testtown', quantity: '1', rate: '1250.00', vat: '20', nominal: '4000' }]);
  });

  it("uses today when the quote has no date, and the site alone when there's no description", () => {
    const f = quoteFormDefaults({ ...quoteRow(), description: '' }, { number: 1 }, { now: d('2026-11-16') });
    assert.equal(f.date, '2026-11-16');
    assert.equal(f.lines[0].nominal, '');
    assert.equal(f.lines[0].rate, '');
    assert.equal(lineText({ site: 'Only Site' }), 'Only Site');
  });

  it("describes a variation by its own description", () => {
    assert.equal(lineText(wonRow(), quoteOf(wonRow(), VID)), 'Extra wall — 2 Sample Road');
    assert.equal(quoteOf(wonRow(), 'nope'), null);
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

  it("builds the quote with the job's customer and the quote's number", () => {
    const p = buildQuotePayload(quoteRow(), quoteOf(quoteRow()), { date: '2026-11-02', reference: 'PO-1', lines });
    assert.deepEqual(p, {
      Number: 900101, Date: '2026-11-02', CustomerCode: 'CUST01', CustomerReference: 'PO-1',
      LineItems: [{ Description: 'Fencing — 1 Test Street', Quantity: 1, Rate: 1250, VATLevel: 20, VATAmount: 250, NominalCode: 4000 }],
    });
  });

  it('leaves the number out for KashFlow to pick', () => {
    const p = buildQuotePayload(quoteRow(), quoteOf(quoteRow()), { date: '2026-11-02', reference: '', lines }, { number: null });
    assert.equal('Number' in p, false);
    assert.equal('CustomerReference' in p, false);
    assert.equal('ProjectNumber' in p, false, 'an enquiry has no project yet');
  });

  it("puts a won job's quote (a variation) on its project", () => {
    const p = buildQuotePayload(wonRow(), quoteOf(wonRow(), VID), { date: '2026-11-20', reference: '', lines });
    assert.equal(p.Number, 900103);
    assert.equal(p.ProjectNumber, 800201);
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

describe('What can be created', () => {
  it('needs a KashFlow customer, a number, and not done already, per quote', () => {
    const q = quoteOf(quoteRow());
    assert.equal(cannotCreate(quoteRow(), 'quote', q), null);
    assert.match(cannotCreate({ ...quoteRow(), customerCode: '' }, 'quote', q), /KashFlow customers/);
    assert.match(cannotCreate({ ...quoteRow(), cancelled: true }, 'quote', q), /cancelled/);
    assert.match(cannotCreate(quoteRow(), 'quote', { ...q, sentAt: new Date() }), /already created/);
    assert.match(cannotCreate(quoteRow(), 'quote', { ...q, number: null }), /no number/);
    assert.match(cannotCreate(quoteRow(), 'quote', { ...q, status: 'lost' }), /lost/);
    assert.match(cannotCreate(quoteRow(), 'quote', null), /no longer on this job/);
    assert.match(cannotCreate(wonRow(), 'quote', quoteOf(wonRow(), PQID)), /already created/);
    assert.equal(cannotCreate(wonRow(), 'quote', quoteOf(wonRow(), VID)), null, 'its variation can be');
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

/** A deep copy that keeps ObjectIds and Dates. */
const copy = (v) => {
  if (Array.isArray(v)) return v.map(copy);
  if (v && typeof v === 'object' && v.constructor === Object) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)]));
  return v;
};

/**
 * One-collection stand-in: enough of findOne / findOneAndUpdate / updateOne
 * for the service, including a quote's claim ($elemMatch) and its positional
 * $set / $unset ('quotes.$.x' with 'quotes._id' in the filter).
 */
function fakeRegister(rows, { takenNumbers = [] } = {}) {
  const byUuid = (uuid) => rows.find((r) => r.uuid === uuid) || null;
  const lean = (v) => ({ lean: async () => (v ? copy(v) : null) });
  const isNull = (v) => v == null;
  const free = (sent, sending, stale) => isNull(sent) && (isNull(sending) || sending < stale);
  // The element a positional path points at, and the field
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
        const stale = em.$or[1].sendingAt.$lt;
        const q = r.quotes.find((x) => String(x._id) === String(em._id));
        ok = !!q && free(q.sentAt, q.sendingAt, stale);
      } else if (r) {
        ok = free(r.projectSentAt, r.projectSendingAt, filter.$or[1].projectSendingAt.$lt);
      }
      if (ok) for (const [k, v] of Object.entries(update.$set)) { const [o, f] = at(r, filter, k); o[f] = v; }
      return lean(ok ? r : null);
    },
    updateOne: async (filter, update) => {
      const r = byUuid(filter.uuid);
      for (const [k, v] of Object.entries(update.$set || {})) {
        if (/number$|Number$/.test(k) && takenNumbers.includes(v)) throw Object.assign(new Error('dup'), { code: 11000 });
      }
      for (const [k, v] of Object.entries(update.$set || {})) { const [o, f] = at(r, filter, k); o[f] = v; }
      for (const k of Object.keys(update.$unset || {})) { const [o, f] = at(r, filter, k); delete o[f]; }
      return { matchedCount: 1, modifiedCount: 1 };
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
  const q0 = () => rows[0].quotes[0];
  beforeEach(() => {
    rows = [quoteRow(), wonRow()];
    mdb.INTERNAL.jobRegister = fakeRegister(rows);
    pulls = [];
    hcsSyncService.pullEntity = async (kind, n) => { pulls.push(`${kind}/${n}`); return { ok: true }; };
  });

  it("creates the quote under its number and marks the quote", async () => {
    const posts = fakeKashflow();
    const r = await kf.createQuote('row-q', String(QID), quoteBody);
    assert.deepEqual(r, { number: 900101, rowNumber: 900101, picked: false, rowNotUpdated: false });
    assert.equal(posts.length, 1);
    assert.match(posts[0].url, /\/quotes$/);
    assert.equal(posts[0].auth, 'KfToken test-token');
    assert.equal(posts[0].payload.Number, 900101);
    assert.equal(posts[0].payload.CustomerCode, 'CUST01');
    assert.ok(q0().sentAt instanceof Date);
    assert.equal(q0().sendingAt, undefined, 'the claim is released');
    assert.ok(rows[0].editedAt instanceof Date);
    assert.deepEqual(pulls, ['quote/900101'], 'hcs-sync pulls the new quote');
  });

  it("lets KashFlow pick when another client has the number, and changes the quote's number", async () => {
    const posts = fakeKashflow({ existing: { 'quotes/900101': { Number: 900101, CustomerCode: 'OTHER' } }, created: { Number: 900150 } });
    const r = await kf.createQuote('row-q', String(QID), quoteBody);
    assert.equal('Number' in posts[0].payload, false);
    assert.deepEqual(r, { number: 900150, rowNumber: 900101, picked: true, rowNotUpdated: false });
    assert.equal(q0().number, 900150);
  });

  it("creates a won job's variation on its project, leaving its other quote alone", async () => {
    const posts = fakeKashflow();
    const r = await kf.createQuote('row-p', String(VID), quoteBody);
    assert.equal(r.number, 900103);
    assert.equal(posts[0].payload.ProjectNumber, 800201);
    assert.ok(rows[1].quotes[1].sentAt instanceof Date);
    assert.deepEqual(rows[1].quotes[0].sentAt, d('2026-11-01'));
  });

  it('keeps the send but not the number when another register job already has the picked number', async () => {
    mdb.INTERNAL.jobRegister = fakeRegister(rows, { takenNumbers: [900150] });
    fakeKashflow({ existing: { 'quotes/900101': { Number: 900101, CustomerCode: 'OTHER' } }, created: { Number: 900150 } });
    const r = await kf.createQuote('row-q', String(QID), quoteBody);
    assert.equal(r.rowNotUpdated, true);
    assert.equal(q0().number, 900101);
    assert.ok(q0().sentAt);
  });

  it("creates nothing when this client's quote is already there under the number", async () => {
    const posts = fakeKashflow({ existing: { 'quotes/900101': { Number: 900101, CustomerCode: 'CUST01' } } });
    await assert.rejects(() => kf.createQuote('row-q', String(QID), quoteBody), (e) => e.status === 400 && /already in KashFlow for this client/.test(e.message));
    assert.equal(posts.length, 0);
    assert.equal(q0().sentAt, undefined);
    assert.equal(q0().sendingAt, undefined);
    assert.deepEqual(pulls, ['quote/900101'], 'asks hcs-sync to pull it so it matches');
  });

  it("passes KashFlow's error on and frees the row for another go", async () => {
    fakeKashflow({ postError: Object.assign(new Error('400'), { response: { status: 400, data: { Message: 'Invalid nominal' } } }) });
    await assert.rejects(() => kf.createQuote('row-q', String(QID), quoteBody), /KashFlow didn't create the quote: Invalid nominal/);
    assert.equal(q0().sentAt, undefined);
    assert.equal(q0().sendingAt, undefined);
  });

  it("doesn't send a form with problems, or a quote already sent or being sent", async () => {
    const posts = fakeKashflow();
    await assert.rejects(() => kf.createQuote('row-q', String(QID), { ...quoteBody, lines: [] }), (e) => e.status === 400 && Boolean(e.form));
    q0().sendingAt = new Date();
    await assert.rejects(() => kf.createQuote('row-q', String(QID), quoteBody), /already being created/);
    q0().sentAt = new Date();
    await assert.rejects(() => kf.createQuote('row-q', String(QID), quoteBody), /already created/);
    await assert.rejects(() => kf.createQuote('nope', String(QID), quoteBody), (e) => e.status === 404);
    await assert.rejects(() => kf.createQuote('row-q', String(VID), quoteBody), (e) => e.status === 404 && /no longer on this job/.test(e.message));
    assert.equal(posts.length, 0);
  });

  it('takes over a claim left behind by a crash', async () => {
    fakeKashflow();
    q0().sendingAt = new Date(Date.now() - 10 * 60 * 1000);
    const r = await kf.createQuote('row-q', String(QID), quoteBody);
    assert.equal(r.number, 900101);
  });

  it("still succeeds when hcs-sync can't be reached", async () => {
    fakeKashflow();
    hcsSyncService.pullEntity = async () => { throw new Error('down'); };
    const r = await kf.createQuote('row-q', String(QID), quoteBody);
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

  it("creates the project from the won job", async () => {
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

  it("won't create a project for a job that isn't won", async () => {
    const posts = fakeKashflow();
    await assert.rejects(() => kf.createProject('row-q'), /isn't won/);
    assert.equal(posts.length, 0);
  });
});

// ── Views ───────────────────────────────────────────────────────────────

describe('Create in KashFlow views', () => {
  const views = path.join(root, 'mongoose/views/tailwindcss/jobRegister');
  const render = (file, locals) => ejs.renderFile(path.join(views, file), { csrfToken: 't', ...locals });

  it("the quote page shows the quote's register value beside the lines and warns when they differ", async () => {
    const entry = quoteRow();
    const quote = { ...quoteOf(entry), value: 1000 };
    const values = quoteFormDefaults(entry, quoteOf(entry), { nominal: 4000 });
    const html = await render('kashflow-quote.ejs', {
      entry, quote, values, errors: {}, totals: quoteTotals(parseQuoteForm(values).lines),
      nominals: [{ code: 4000, name: 'Sales' }], defaultNominal: 4000, vatChoices: VAT_CHOICES, crumbs: [], title: 'Create quote',
    });
    assert.match(html, /Register value \(net\)/);
    assert.match(html, /£1,000\.00/);
    assert.match(html, /£1,250\.00/);
    assert.match(html, /data-price-differs/);
    assert.match(html, new RegExp(`action="/job-register/row-q/kashflow-quote/${QID}"`));
    assert.match(html, /name="action" value="create"/);
    assert.match(html, /name="_csrf"/);
    assert.doesNotMatch(html, /<script/);
    const won = await render('kashflow-quote.ejs', {
      entry: wonRow(), quote: quoteOf(wonRow(), VID), values, errors: {}, totals: quoteTotals(parseQuoteForm(values).lines),
      nominals: [], defaultNominal: null, vatChoices: VAT_CHOICES, crumbs: [], title: 'Create quote',
    });
    assert.match(won, /It goes on project <span class="font-mono">800201/);
  });

  it('the job page offers the project button only where it is missing and the user may', async () => {
    const job = wonRow();
    const locals = (over) => ({
      job, stage: stageOf(job), values: jobValues(job), match: matchJob(job, {}), next: {}, stageLabels: STAGE_LABELS,
      quoteStatuses: QUOTE_STATUSES, quoteStatusLabels: QUOTE_STATUS_LABELS, canEdit: true, editQuote: null, editInvoice: null, crumbs: [], title: 'Job', ...over,
    });
    const yes = await render('show.ejs', locals({ canCreate: { project: true, quotes: { [String(VID)]: true } } }));
    assert.match(yes, /action="\/job-register\/row-p\/kashflow-project"/);
    assert.match(yes, new RegExp(`/job-register/row-p/kashflow-quote/${VID}`));
    assert.doesNotMatch(yes, new RegExp(`kashflow-quote/${PQID}`), 'the quote sent already');
    const no = await render('show.ejs', locals({ canCreate: { project: false, quotes: {} } }));
    assert.doesNotMatch(no, /kashflow-quote|kashflow-project/);
    const sent = await render('show.ejs', locals({ job: { ...job, projectSentAt: d('2026-11-12') }, canCreate: { project: false, quotes: {} } }));
    assert.match(sent, /Created in KashFlow from here on 12\/11\/2026/);
  });
});
