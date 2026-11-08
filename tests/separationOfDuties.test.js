import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import sod from '../mongoose/services/separationOfDutiesService.js';
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import { countEnteredBy, numbersEnteredBy } from '../mongoose/controllers/paymentController.js';

const src = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const director = { _id: 'u-dir', role: 'employee', roles: ['director'] };

describe('separationOfDutiesService', () => {
  it('applies to job roles, not to the legacy admin and accountant', () => {
    assert.equal(sod.applies(director), true);
    assert.equal(sod.applies({ _id: 'a', role: 'admin' }), false);
    assert.equal(sod.applies({ _id: 'b', role: 'accountant', roles: ['director'] }), false);
    assert.equal(sod.applies(null), false);
  });

  it('recognises the same person from an id, a user or a { userId } stamp', () => {
    assert.equal(sod.isSamePerson(director, 'u-dir'), true);
    assert.equal(sod.isSamePerson(director, { _id: 'u-dir' }), true);
    assert.equal(sod.isSamePerson(director, { userId: 'u-dir', name: 'x' }), true);
    assert.equal(sod.isSamePerson(director, 'u-other'), false);
    assert.equal(sod.isSamePerson(director, null), false);
    assert.equal(sod.isSamePerson({ role: 'employee' }, 'u-dir'), false);
  });

  it('blocks only when the rule applies and it was the same person', () => {
    assert.equal(sod.blocks(director, { userId: 'u-dir' }), true);
    assert.equal(sod.blocks(director, { userId: 'u-other' }), false);
    assert.equal(sod.blocks({ _id: 'u-dir', role: 'admin' }, 'u-dir'), false);
  });

  it('payment message counts the invoices', () => {
    assert.match(sod.MESSAGES.payPurchases(1), /1 of these invoice,.*pays it/);
    assert.match(sod.MESSAGES.payPurchases(3), /3 of these invoices,.*pays them/);
  });
});

describe('bulk payments: purchases the payer entered', () => {
  const saved = mdb.PAPERLESS;
  afterEach(() => { mdb.PAPERLESS = saved; });

  it('counts OCR entries this user saved for the selected purchase numbers', async () => {
    let query;
    mdb.PAPERLESS = { OcrDocument: { countDocuments: async (q) => { query = q; return 2; } } };
    assert.equal(await countEnteredBy(director, [101, '102']), 2);
    assert.deepEqual(query.kashflowPurchaseNumber, { $in: [101, 102] });
    assert.equal(query['entry.savedBy.userId'], 'u-dir');
  });

  it('skips the lookup for admin and accountant, and for an empty selection', async () => {
    mdb.PAPERLESS = { OcrDocument: { countDocuments: async () => { throw new Error('should not query'); } } };
    assert.equal(await countEnteredBy({ _id: 'a', role: 'admin' }, [1]), 0);
    assert.equal(await countEnteredBy({ _id: 'b', role: 'accountant' }, [1]), 0);
    assert.equal(await countEnteredBy(director, []), 0);
  });
});

describe('wiring', () => {
  it('payroll: lock stamps lockedBy, unlock clears it, and the three submit steps refuse the locker', () => {
    const s = src('mongoose/controllers/payrollController.js');
    assert.match(s, /run\.status = 'locked';\s*run\.lockedBy = req\.user\?\._id/);
    assert.match(s, /run\.status = 'draft';\s*run\.lockedBy = null;/);
    for (const fn of ['postJournal', 'submitFPS']) {
      assert.match(s, new RegExp(`export const ${fn} = async[\\s\\S]{0,80}refuseIfLocker\\(req, res\\)`), fn);
    }
    assert.match(s, /export const submitPension[\s\S]*?sod\.blocks\(req\.user, run\.lockedBy\)[\s\S]*?submitViaAPI/);
  });

  it('payroll run model records who locked it', () => {
    assert.match(src('mongoose/models/mongoose/INTERNAL/payrollRun.js'), /lockedBy: \{ type: mongoose\.Schema\.Types\.ObjectId, ref: 'user'/);
  });

  it('documents: sending refuses whoever saved the entry, except on a dry run', () => {
    const s = src('mongoose/controllers/paperlessController.js');
    assert.match(s, /select\('documentType processingState excludedReason entry\.savedBy'\)/);
    assert.match(s, /!dryRun && typed && sod\.blocks\(req\.user, typed\.entry\?\.savedBy\) \? sod\.MESSAGES\.sendInvoice/);
  });

  it('bank: sign-off passes separateDuties for job roles', () => {
    assert.match(src('mongoose/controllers/bankController.js'), /separateDuties: sod\.applies\(req\.user\)/);
  });

  it('payments: preview and confirm both check what the payer entered', () => {
    const s = src('mongoose/controllers/paymentController.js');
    assert.equal((s.match(/await countEnteredBy\(req\.user, items\.map/g) || []).length, 2);
  });

  it('bank and payments guards take Finance manage', () => {
    for (const f of ['mongoose/routes/bankRoutes.js', 'mongoose/routes/paymentRoutes.js']) {
      assert.match(src(f), /authService\.ensureGroup\('finance', 'manage', 'admin', 'accountant'\)/, f);
    }
  });
});

describe('blocked buttons are disabled with the reason', () => {
  const saved = mdb.PAPERLESS;
  afterEach(() => { mdb.PAPERLESS = saved; });
  const view = (p) => fileURLToPath(new URL(`../mongoose/views/tailwindcss/${p}.ejs`, import.meta.url));

  it('numbersEnteredBy lists the purchases this user entered, and nothing for admin', async () => {
    let query;
    mdb.PAPERLESS = { OcrDocument: { distinct: async (f, q) => { query = q; assert.equal(f, 'kashflowPurchaseNumber'); return [102]; } } };
    assert.deepEqual(await numbersEnteredBy(director, [101, 102]), [102]);
    assert.equal(query['entry.savedBy.userId'], 'u-dir');
    mdb.PAPERLESS = { OcrDocument: { distinct: async () => { throw new Error('should not query'); } } };
    assert.deepEqual(await numbersEnteredBy({ _id: 'a', role: 'admin' }, [1]), []);
  });

  it('bulk payments: a row the payer entered cannot be ticked and says why', async () => {
    const row = (Number) => ({ Number, SupplierName: 'S', GrossAmount: 10, TotalPaidAmount: 0, outstanding: 10 });
    const html = await ejs.renderFile(view('payments/bulk'), {
      title: 't', csrfToken: 'c', filters: { supplierId: '', search: '', from: '', to: '', pageSize: 50 },
      suppliers: [], bankAccounts: [], suggestions: {}, todayIso: '2026-11-08',
      rows: [row(101), row(102)], page: 1, pages: 1, total: 2, enteredByMe: [102],
    }, { async: true });
    assert.match(html, /name="selected" value="101"/);
    assert.doesNotMatch(html, /name="selected" value="102"/);
    assert.match(html, /disabled aria-disabled="true" title="You entered this invoice, so someone else pays it\."/);
    assert.match(html, /You entered this, so someone else pays it/);
  });

  it('bank sign-off states the rule to a Director only', async () => {
    const render = (sodApplies) => ejs.renderFile(view('bank/signoff'), {
      title: 't', csrfToken: 'c', user: { role: 'admin' }, accounts: [], signOffs: [], sodApplies,
      slimDateTime: () => '', fmtDate: () => '', formatCurrency: (n) => String(n),
    }, { async: true });
    assert.match(await render(true), /id="sod-signoff-note"/);
    assert.doesNotMatch(await render(false), /id="sod-signoff-note"/);
  });

  it('payroll run: the locker sees Post Journal, Submit FPS and Submit Pension disabled with the reason', () => {
    const s = src('mongoose/controllers/payrollController.js');
    assert.match(s, /sodBlocked: sod\.blocks\(req\.user, run\.lockedBy\)/);
    const v = src('mongoose/views/tailwindcss/payroll/run.ejs');
    assert.equal((v.match(/locals\.sodBlocked \? `disabled title="\$\{sodMessage\}"/g) || []).length, 3);
    assert.match(v, /<%= sodMessage %> Posting the journal/);
  });

  it('KashFlow draft: whoever entered it gets a locked dry run and the reason', () => {
    assert.match(src('mongoose/controllers/paperlessController.js'), /sodBlocked: sod\.blocks\(req\.user, doc\.entry\?\.savedBy\)/);
    const v = src('mongoose/views/tailwindcss/paperless/draft.ejs');
    assert.match(v, /<% if \(locals\.sodBlocked\) \{ %>\s*<input type="hidden" name="dryRun" value="true">/);
    assert.match(v, /<input type="checkbox" checked disabled/);
    assert.match(v, /<%= sodMessage %> You can still do a dry run/);
  });
});
