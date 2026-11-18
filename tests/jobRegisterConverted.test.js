import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import ejs from 'ejs';

/*
 * KashFlow deletes a quote when it's converted to an invoice, and the invoice
 * says nothing of the quote. The register treats a deleted KashFlow quote as
 * gone, looks for the invoice it became, and never creates it again. KashFlow
 * is never called: the synced records are in-memory stand-ins on mdb.REST.
 */
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import {
  isDeleted, sameCustomer, touchesProject, convertedCandidates, convertedInvoiceFor, matchConverted, matchJob,
  buildRegister, byProject, byProjectOrLine, customerInvoiceQuery, goneReason, jobTitle, stageOf, jobValues,
  STAGE_LABELS, STAGES, QUOTE_STATUSES, QUOTE_STATUS_LABELS,
} from '../mongoose/services/jobRegisterService.js';
import kf from '../mongoose/services/jobRegisterKashflowService.js';
import { createChoices } from '../mongoose/controllers/jobRegisterController.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const d = (s) => new Date(`${s}T12:00:00Z`);
const oid = () => new mongoose.Types.ObjectId();
const byNumber = (docs) => new Map(docs.map((r) => [Number(r.Number), r]));
const projectRec = (n, code) => ({ uuid: `p${n}`, Number: n, CustomerCode: code });

// Made-up records. The shape of the real case: quote 51770 (Test Customer, on
// job "Test Job", one line "This is a test", £0) became invoice 1776 (same
// customer and issue date, the same line on the same job, £0), and 51770 was
// deleted from KashFlow.
const PN = 40777;
const Q51770 = oid();
const testJob = () => ({
  uuid: 'tj', projectNumber: PN, site: 'Test Job', client: 'Test Customer', customerCode: 'TEST01',
  quotes: [{ _id: Q51770, number: 51770, date: d('2026-11-17'), value: 0, status: 'won' }], invoices: [],
});
const deletedQuote51770 = () => ({
  uuid: 'q51770', Number: 51770, Date: d('2026-11-17'), CustomerName: 'Test Customer', CustomerCode: 'TEST01', NetAmount: 0,
  ProjectNumber: PN, LineItems: [{ Description: 'This is a test', ProjectNumber: PN }], deletedAt: d('2026-11-18'),
});
const invoice1776 = () => ({
  uuid: 'i1776', Number: 1776, IssuedDate: d('2026-11-17'), CustomerName: 'Test Customer', CustomerCode: 'TEST01', NetAmount: 0,
  LineItems: [{ Description: 'This is a test', ProjectNumber: PN }],
});

// A valued job for the other cases
const vJob = (over = {}) => ({
  uuid: 'v', projectNumber: 41500, site: '1 Sample Row', client: 'Example Homes', customerCode: 'EX1',
  quotes: [{ _id: oid(), number: 52000, date: d('2026-10-01'), value: 1200, status: 'won' }], invoices: [], ...over,
});
const inv = (over = {}) => ({ uuid: `i${over.Number ?? 2000}`, Number: 2000, IssuedDate: d('2026-10-20'), CustomerCode: 'EX1', CustomerName: 'Example Homes', NetAmount: 1200, ProjectNumber: 41500, ...over });

describe('Deleted KashFlow records', () => {
  it('counts deletedAt (hcs-sync) or DeletedAt (KashFlow) set to a date as deleted, and nothing else', () => {
    assert.equal(isDeleted({ deletedAt: d('2026-11-18') }), true);
    assert.equal(isDeleted({ DeletedAt: '2026-11-18T10:00:00Z' }), true);
    assert.equal(isDeleted({ missingSince: d('2026-11-18') }), false, 'missing for a while is not deleted yet');
    assert.equal(isDeleted({ deletedAt: null, DeletedAt: '' }), false);
    assert.equal(isDeleted({ deletedAt: 'not a date' }), false);
    assert.equal(isDeleted(null), false);
  });

  it('compares customers by code where both have one, else by name', () => {
    assert.equal(sameCustomer({ code: 'ex1', name: 'A' }, { code: 'EX1 ', name: 'B' }), true);
    assert.equal(sameCustomer({ code: 'EX1' }, { code: 'EX2', name: 'Example Homes' }), false);
    assert.equal(sameCustomer({ name: 'Example  homes' }, { code: 'EX1', name: 'example homes' }), true);
    assert.equal(sameCustomer({}, {}), false);
  });

  it('puts an invoice on a project by its header or any line', () => {
    assert.equal(touchesProject({ ProjectNumber: 41500 }, 41500), true);
    assert.equal(touchesProject({ ProjectNumber: 0, LineItems: [{ ProjectNumber: 1 }, { ProjectNumber: 41500 }] }, 41500), true);
    assert.equal(touchesProject({ ProjectNumber: 41501 }, 41500), false);
    assert.deepEqual([...byProjectOrLine([{ Number: 1, ProjectNumber: 5, LineItems: [{ ProjectNumber: 6 }, { ProjectNumber: 5 }] }]).keys()], [5, 6]);
  });
});

describe('Which invoice a gone quote became', () => {
  it('matches the 51770 → 1776 case: same customer, job, date, £0 with the same line', () => {
    assert.equal(convertedInvoiceFor(testJob().quotes[0], deletedQuote51770(), [invoice1776()], testJob())?.Number, 1776);
  });

  it('matches a valued quote missing from the sync on value, customer, project and date', () => {
    const job = vJob();
    assert.equal(convertedInvoiceFor(job.quotes[0], null, [inv()], job)?.Number, 2000);
    assert.equal(convertedInvoiceFor(job.quotes[0], null, [inv({ NetAmount: 1200.004 })], job)?.Number, 2000, 'to the penny');
    assert.equal(convertedInvoiceFor(job.quotes[0], null, [inv({ NetAmount: 1250 })], job), null, 'another value');
  });

  it("won't match an invoice issued before the quote, but will on the same London day", () => {
    const job = vJob();
    assert.equal(convertedInvoiceFor(job.quotes[0], null, [inv({ IssuedDate: d('2026-09-30') })], job), null);
    // 23:30 UTC on 30 September is 1 October in London (BST)
    assert.equal(convertedInvoiceFor(job.quotes[0], null, [inv({ IssuedDate: new Date('2026-09-30T23:30:00Z') })], job)?.Number, 2000);
    assert.equal(convertedInvoiceFor({ ...job.quotes[0], date: null }, null, [inv({ IssuedDate: d('2020-01-01') })], job)?.Number, 2000, 'no quote date: no guard');
  });

  it("won't match another customer's invoice", () => {
    const job = vJob();
    assert.equal(convertedInvoiceFor(job.quotes[0], null, [inv({ CustomerCode: 'EX2' })], job), null);
    // No codes: by name
    const named = vJob({ customerCode: undefined });
    assert.equal(convertedInvoiceFor(named.quotes[0], null, [inv({ CustomerCode: undefined, CustomerName: 'example homes' })], named)?.Number, 2000);
    assert.equal(convertedInvoiceFor(named.quotes[0], null, [inv({ CustomerCode: undefined, CustomerName: 'Other Ltd' })], named), null);
  });

  it('finds the project on a line when the header has none, and refuses an invoice off the job', () => {
    const job = vJob();
    assert.equal(convertedInvoiceFor(job.quotes[0], null, [inv({ ProjectNumber: 0, LineItems: [{ ProjectNumber: 41500 }] })], job)?.Number, 2000);
    assert.equal(convertedInvoiceFor(job.quotes[0], null, [inv({ ProjectNumber: 41999 })], job), null);
  });

  it('needs line descriptions for a quote worth nothing', () => {
    const job = testJob();
    const q = job.quotes[0];
    assert.equal(convertedInvoiceFor(q, null, [invoice1776()], job), null, 'missing entirely: no lines to compare');
    assert.equal(convertedInvoiceFor(q, { ...deletedQuote51770(), LineItems: [] }, [invoice1776()], job), null);
    assert.equal(convertedInvoiceFor(q, deletedQuote51770(), [{ ...invoice1776(), LineItems: [{ Description: 'Something else', ProjectNumber: PN }] }], job), null);
    assert.equal(convertedInvoiceFor(q, deletedQuote51770(), [{ ...invoice1776(), ProjectNumber: PN, LineItems: [{ Description: '  this IS a  test ' }] }], job)?.Number, 1776, 'normalised, project on the header');
  });

  it('on a job with no project number, needs the customer and a matching line too', () => {
    const job = { ...testJob(), projectNumber: null };
    assert.equal(convertedInvoiceFor(job.quotes[0], deletedQuote51770(), [{ ...invoice1776(), LineItems: [{ Description: 'This is a test' }] }], job)?.Number, 1776);
    const valued = vJob({ projectNumber: null });
    assert.equal(convertedInvoiceFor(valued.quotes[0], null, [inv()], valued), null, 'value alone is not enough without a project');
  });

  it('treats DeletedAt like deletedAt, and a live quote as not converted', () => {
    const job = testJob();
    const { deletedAt, ...live } = deletedQuote51770();
    assert.ok(deletedAt);
    assert.equal(convertedInvoiceFor(job.quotes[0], { ...live, DeletedAt: d('2026-11-18') }, [invoice1776()], job)?.Number, 1776);
    assert.equal(convertedInvoiceFor(job.quotes[0], live, [invoice1776()], job), null);
  });

  it('skips deleted invoices, and prefers one on the job here, then the closest date', () => {
    const job = vJob({ invoices: [{ _id: oid(), number: 2002 }] });
    const q = job.quotes[0];
    assert.equal(convertedInvoiceFor(q, null, [inv({ deletedAt: d('2026-11-01') })], job), null);
    const near = inv({ Number: 2001, IssuedDate: d('2026-10-02') });
    const far = inv({ Number: 2003, IssuedDate: d('2026-12-01') });
    assert.equal(convertedInvoiceFor(q, null, [far, near], job)?.Number, 2001);
    assert.deepEqual(convertedCandidates(q, null, [far, near, inv({ Number: 2002, IssuedDate: d('2026-12-20') })], job).map((c) => c.invoice.Number), [2002, 2001, 2003]);
  });

  it('lets each invoice explain one quote: the closest first, then the lower quote number', () => {
    const job = vJob({ quotes: [
      { _id: oid(), number: 52010, date: d('2026-10-01'), value: 500 },
      { _id: oid(), number: 52011, date: d('2026-10-15'), value: 500 },
      { _id: oid(), number: 52012, date: d('2026-10-15'), value: 500 },
    ] });
    const gone = job.quotes.map((quote, key) => ({ key, quote, record: null }));
    const one = matchConverted(job, gone, [inv({ Number: 2100, NetAmount: 500, IssuedDate: d('2026-10-16') })]);
    assert.deepEqual([...one.entries()].map(([k, v]) => [k, v.invoice.Number]), [[1, 2100]], 'closest date, then lower number');
    const two = matchConverted(job, gone, [inv({ Number: 2100, NetAmount: 500, IssuedDate: d('2026-10-16') }), inv({ Number: 2101, NetAmount: 500, IssuedDate: d('2026-10-16') })]);
    assert.deepEqual([...two.entries()].map(([k, v]) => [k, v.invoice.Number]).sort(), [[1, 2100], [2, 2101]]);
  });
});

describe('matchJob with converted quotes', () => {
  it('shows 51770 as converted to 1776, offered as an extra to add, not missing', () => {
    const job = testJob();
    const m = matchJob(job, {
      project: projectRec(PN, 'TEST01'), quotesByNumber: byNumber([deletedQuote51770()]), invoicesByNumber: new Map(),
      onJob: { quotes: [], invoices: [] }, invoiceCandidates: [invoice1776()],
    });
    assert.equal(m.quotes[0].state, 'converted');
    assert.deepEqual(m.quotes[0].invoice, { number: 1776, id: 'i1776', onJob: false });
    assert.equal(m.quotes[0].deleted, true);
    assert.equal(m.missing, false);
    assert.deepEqual(m.extras.invoices.map((r) => [r.Number, r.fromQuote]), [[1776, 51770]], 'line-only project: added to extras');
    assert.equal(m.differs, true, 'until the invoice is on the job');
  });

  it('marks the extra that is already listed, and is settled once the invoice is on the job', () => {
    const job = vJob();
    const i = inv();
    const listed = matchJob(job, { quotesByNumber: new Map(), invoicesByNumber: new Map(), onJob: { invoices: [i] } });
    assert.equal(listed.quotes[0].state, 'converted');
    assert.deepEqual(listed.extras.invoices.map((r) => [r.Number, r.fromQuote]), [[2000, 52000]]);
    const done = matchJob({ ...job, invoices: [{ _id: oid(), number: 2000, value: 1200 }] }, { project: projectRec(41500, 'EX1'), quotesByNumber: new Map(), invoicesByNumber: byNumber([i]), onJob: { invoices: [i] } });
    assert.equal(done.quotes[0].state, 'converted');
    assert.equal(done.quotes[0].invoice.onJob, true);
    assert.equal(done.differs, false);
    assert.equal(done.missing, false);
  });

  it('keeps a deleted quote with no invoice as missing, with its record and deleted: true; a live one is ok', () => {
    const job = vJob();
    const rec = { uuid: 'q', Number: 52000, NetAmount: 1200, CustomerCode: 'EX1', ProjectNumber: 41500 };
    const gone = matchJob(job, { quotesByNumber: byNumber([{ ...rec, DeletedAt: d('2026-11-01') }]) });
    assert.equal(gone.quotes[0].state, 'missing');
    assert.equal(gone.quotes[0].deleted, true);
    assert.equal(gone.quotes[0].record.uuid, 'q');
    assert.equal(gone.missing, true);
    const live = matchJob(job, { quotesByNumber: byNumber([rec]), onJob: { invoices: [inv()] } });
    assert.equal(live.quotes[0].state, 'ok', 'a live quote is never converted');
    const onProject = matchJob(job, { onJob: { quotes: [{ Number: 52999, ProjectNumber: 41500, deletedAt: d('2026-11-01') }] } });
    assert.deepEqual(onProject.extras.quotes, [], 'a deleted quote is not on the job in KashFlow');
    const absent = matchJob(job, {});
    assert.equal(absent.quotes[0].state, 'missing');
    assert.equal(absent.quotes[0].deleted, false);
  });

  it('builds the register with invoices found by line project, and by customer for an enquiry', () => {
    const enquiry = { ...testJob(), uuid: 'enq', projectNumber: null };
    const lineOnly = invoice1776();
    const reg = buildRegister({
      entries: [testJob(), enquiry],
      quotesByNumber: byNumber([deletedQuote51770()]), projectsByNumber: byNumber([projectRec(PN, 'TEST01')]), invoicesByNumber: new Map(),
      invoicesByProject: byProject([lineOnly]), invoicesTouching: byProjectOrLine([lineOnly]),
      customerInvoices: [{ ...lineOnly, LineItems: [{ Description: 'This is a test' }] }],
    });
    const byUuid = Object.fromEntries(reg.rows.map((r) => [r.entry.uuid, r.match]));
    assert.equal(byUuid.tj.quotes[0].state, 'converted');
    assert.equal(byUuid.enq.quotes[0].state, 'converted');
    assert.deepEqual(byUuid.enq.extras.invoices, [], "an enquiry has no project, so no extras");
    assert.equal(reg.counts.unmatched, 0);
  });

  it('asks for customer invoices only for deleted quotes with lines on jobs with no project number', () => {
    const enquiry = { ...testJob(), projectNumber: null };
    const q = customerInvoiceQuery([enquiry, testJob()], byNumber([deletedQuote51770()]));
    assert.deepEqual(q.$and[0], { CustomerCode: { $in: ['TEST01'] } });
    assert.ok(q.$and[1].$nor, 'not deleted');
    assert.ok(q.$and[2].IssuedDate.$gte < d('2026-11-17'));
    assert.equal(customerInvoiceQuery([testJob()], byNumber([deletedQuote51770()])), null, 'a job with a project uses its project');
    assert.equal(customerInvoiceQuery([enquiry], new Map()), null, 'missing entirely: no lines to match');
  });
});

describe('Never creating a gone quote again', () => {
  const query = (rows) => ({ select: () => query(rows), sort: () => query(rows), limit: () => query(rows), lean: async () => rows });
  const fakeRest = ({ quote = null, invoices = [] }) => ({
    quote: { findOne: () => query(quote) },
    invoice: { find: () => query(invoices) },
  });
  let saved;
  before(() => { saved = { REST: mdb.REST, INTERNAL: mdb.INTERNAL, auto: process.env.JOB_REGISTER_KASHFLOW_AUTO }; });
  after(() => {
    mdb.REST = saved.REST;
    mdb.INTERNAL = saved.INTERNAL;
    if (saved.auto === undefined) delete process.env.JOB_REGISTER_KASHFLOW_AUTO; else process.env.JOB_REGISTER_KASHFLOW_AUTO = saved.auto;
  });

  it('says why: converted, or deleted; nothing for a quote simply not there', async () => {
    const job = testJob();
    assert.equal(goneReason(job.quotes[0], { deleted: true, invoice: invoice1776() }), "Quote 51770 was converted to invoice 1776 in KashFlow, so it won't be created again.");
    assert.equal(goneReason(job.quotes[0], { deleted: true, invoice: null }), "Quote 51770 was deleted in KashFlow, so it won't be created again.");
    assert.equal(goneReason(job.quotes[0], null), null);

    mdb.REST = fakeRest({ quote: deletedQuote51770(), invoices: [invoice1776()] });
    assert.match(await kf.quoteGoneReason(job, job.quotes[0]), /converted to invoice 1776/);
    mdb.REST = fakeRest({ quote: deletedQuote51770(), invoices: [] });
    assert.match(await kf.quoteGoneReason(job, job.quotes[0]), /deleted in KashFlow/);
    mdb.REST = fakeRest({ quote: null, invoices: [invoice1776()] });
    assert.equal(await kf.quoteGoneReason(job, job.quotes[0]), null, 'missing at £0 with no lines: can still be created');
    const live = deletedQuote51770();
    delete live.deletedAt;
    mdb.REST = fakeRest({ quote: live, invoices: [invoice1776()] });
    assert.equal(await kf.quoteGoneReason(job, job.quotes[0]), null);
    mdb.REST = { quote: { findOne: () => { throw new Error('down'); } }, invoice: {} };
    assert.equal(await kf.quoteGoneReason(job, job.quotes[0]), null, "can't tell: KashFlow's own number check still runs");
  });

  it('Create quote refuses a converted quote before calling KashFlow', async () => {
    const job = { ...vJob(), uuid: 'cv' };
    mdb.INTERNAL = { ...(saved.INTERNAL || {}), jobRegister: { findOne: () => query(job) } };
    mdb.REST = fakeRest({ quote: null, invoices: [inv()] });
    const body = { date: '2026-10-01', lines: [{ description: 'Work', quantity: '1', rate: '1200', vat: '20', nominal: '4000' }] };
    await assert.rejects(() => kf.createQuote('cv', String(job.quotes[0]._id), body), (e) => e.status === 400 && e.code === 'gone' && /converted to invoice 2000/.test(e.message));
  });

  it('the automatic create skips a converted quote', async () => {
    process.env.JOB_REGISTER_KASHFLOW_AUTO = 'true';
    const job = { ...vJob(), uuid: 'cv' };
    mdb.INTERNAL = { ...(saved.INTERNAL || {}), jobRegister: { findOne: () => query(job) } };
    mdb.REST = fakeRest({ quote: null, invoices: [inv()] });
    const r = await kf.autoCreateQuote(job, job.quotes[0]);
    assert.deepEqual(r.notices, []);
    assert.match(r.skipped, /converted to invoice 2000/);
  });

  it('offers no Create quote for a converted or deleted quote', () => {
    const job = testJob();
    const admin = { user: { role: 'admin' } };
    const id = String(Q51770);
    assert.equal(createChoices(admin, job).quotes[id], true);
    assert.equal(createChoices(admin, job, { quotes: [{ id, state: 'converted' }] }).quotes[id], false);
    assert.equal(createChoices(admin, job, { quotes: [{ id, state: 'missing', deleted: true }] }).quotes[id], false);
    assert.equal(createChoices(admin, job, { quotes: [{ id, state: 'missing', deleted: false }] }).quotes[id], true);
  });
});

describe('Converted quotes on the pages', () => {
  const converted = () => matchJob(testJob(), {
    quotesByNumber: byNumber([deletedQuote51770()]), onJob: { quotes: [], invoices: [] }, invoiceCandidates: [invoice1776()],
  });

  const showView = path.join(root, 'mongoose/views/tailwindcss/jobRegister/show.ejs');
  const show = (job, match, can = true) => ejs.renderFile(showView, {
    csrfToken: 'c', crumbs: [], title: jobTitle(job), job, stage: stageOf(job), values: jobValues(job), match, next: {},
    stageLabels: STAGE_LABELS, quoteStatuses: QUOTE_STATUSES, quoteStatusLabels: QUOTE_STATUS_LABELS,
    canEdit: true, canCreate: { project: false, quotes: { [String(job.quotes[0]._id)]: can } }, editQuote: null, editInvoice: null,
  });

  it('the job page shows the quote converted, links the invoice, ties it to Add to job, and offers no Create', async () => {
    const html = await show(testJob(), converted());
    assert.match(html, /Quote 51770 → <a href="\/invoice\/read\/i1776"[^>]*>invoice 1776<\/a>/);
    assert.match(html, /title="Converted to invoice 1776 in KashFlow"/);
    assert.match(html, /isn't on this job here yet: <a href="#kashflow-extras"/);
    assert.match(html, /Quote 51770 became this invoice/);
    assert.match(html, /name="number" value="1776"/, 'Add to job for the invoice');
    assert.doesNotMatch(html, /kashflow-quote\//);
    assert.doesNotMatch(html, /<script/);
  });

  it('the job page says a deleted quote with no invoice was deleted, with no Create', async () => {
    const job = testJob();
    const html = await show(job, matchJob(job, { quotesByNumber: byNumber([deletedQuote51770()]) }));
    assert.match(html, /Deleted in KashFlow/);
    assert.match(html, /so it won't be created again/);
    assert.doesNotMatch(html, /kashflow-quote\//);
  });

  it('the job page still offers Create for a quote that is simply not in KashFlow', async () => {
    const job = testJob();
    const html = await show(job, matchJob(job, {}));
    assert.match(html, /Not entered yet, deleted, or converted before it was synced/);
    assert.match(html, new RegExp(`kashflow-quote/${Q51770}`));
  });

  it('the register shows Quote → Invoice, the deleted and missing wording, and the legend', async () => {
    const view = path.join(root, 'mongoose/views/tailwindcss/jobRegister/index.ejs');
    const deleted = { ...vJob(), uuid: 'del' };
    const missing = { ...vJob({ projectNumber: 41600 }), uuid: 'mis', quotes: [{ _id: oid(), number: 52100, value: 10, status: 'won' }] };
    const lineOnly = invoice1776();
    const reg = buildRegister({
      entries: [testJob(), deleted, missing],
      quotesByNumber: byNumber([deletedQuote51770(), { uuid: 'qd', Number: 52000, NetAmount: 1200, CustomerCode: 'EX1', ProjectNumber: 41500, deletedAt: d('2026-11-01') }]),
      projectsByNumber: new Map(), invoicesByNumber: new Map(),
      invoicesByProject: byProject([lineOnly]), invoicesTouching: byProjectOrLine([lineOnly]),
    });
    const html = await ejs.renderFile(view, {
      title: 'Job Register', csrfToken: 'c', crumbs: [], contracts: [], stageLabels: STAGE_LABELS, stages: STAGES, form: {},
      next: {}, unregistered: { year: 2026, quoteCount: 0, projectCount: 0, quotes: [], projects: [] }, ...reg,
    });
    assert.match(html, /title="Converted to invoice 1776 in KashFlow"><i class="bi bi-check-circle-fill" aria-hidden="true"><\/i>Quote 51770 → Invoice 1776/);
    assert.match(html, /Invoice 1776 is on this job in KashFlow, not here \(quote 51770 became it\)/);
    assert.match(html, /Quote 52000 deleted/);
    assert.match(html, /title="Quote 52100: not in KashFlow \(not entered yet, deleted, or converted before it was synced\)"/);
    assert.match(html, /Quote → Invoice: converted to that invoice in KashFlow/);
    assert.match(html, /Deleted in KashFlow, no invoice found for it/);
  });
});
