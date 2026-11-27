import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'test-key-for-unit-tests-only';
process.env.STAFFOLOGY_API_KEY = 'test-staffology-key';
process.env.STAFFOLOGY_EMPLOYER_ID = 'test-employer';

const mode = await import('../services/staffologyModeService.js');
const { decodePayslip, payslipFor } = await import('../services/staffologyPayslipService.js');
const { ownsEntry } = await import('../mongoose/controllers/staffologyPayrollController.js');
const provider = (await import('../mongoose/services/payrollProviderService.js')).default;

const on = () => mode._setFingerprintForTest(mode.fingerprint());
const off = () => mode._setFingerprintForTest(null);

function fakeRes() {
  return {
    statusCode: 200, redirectedTo: null, body: undefined,
    status(c) { this.statusCode = c; return this; },
    redirect(to) { this.redirectedTo = to; return this; },
    json(b) { this.body = b; return this; },
  };
}
const req = (path, method = 'GET', headers = {}) => ({
  path, method, flashes: [], get: (h) => headers[h.toLowerCase()], flash(type, msg) { this.flashes.push([type, msg]); },
});

describe('Staffology mode switch', () => {
  beforeEach(off);

  it('is off until a test has passed for this key and employer', () => {
    assert.equal(mode.isStaffologyMode(), false);
    on();
    assert.equal(mode.isStaffologyMode(), true);
  });

  it('turns off when the key or employer changes', () => {
    on();
    process.env.STAFFOLOGY_EMPLOYER_ID = 'other-employer';
    assert.equal(mode.isStaffologyMode(), false);
    process.env.STAFFOLOGY_EMPLOYER_ID = 'test-employer';
    assert.equal(mode.isStaffologyMode(), true);
    process.env.STAFFOLOGY_API_KEY = '';
    assert.equal(mode.isStaffologyMode(), false);
    process.env.STAFFOLOGY_API_KEY = 'test-staffology-key';
  });

  it('never stores the key itself', () => {
    assert.ok(!mode.fingerprint().includes('test-staffology-key'));
  });

  it('records and reloads the test result through the store', async () => {
    const saved = {};
    const store = {
      record: async (name, v) => { saved[name] = { lastOutcome: v.outcome, lastResult: v.result }; },
      get: async (name) => saved[name] || null,
    };
    await mode.setVerified(true, store);
    off();
    await mode.load(store);
    assert.equal(mode.isStaffologyMode(), true);
    await mode.setVerified(false, store);
    await mode.load(store);
    assert.equal(mode.isStaffologyMode(), false);
  });
});

describe('What Staffology mode hides', () => {
  beforeEach(off);

  it('maps engine pages to their Staffology counterparts', () => {
    assert.equal(mode.hiddenRule('/payroll/run/abc')?.to, '/payroll/runs');
    assert.equal(mode.hiddenRule('/payroll/run/abc/fps/submit')?.to, '/payroll/runs');
    assert.equal(mode.hiddenRule('/payroll/runs/create')?.to, '/payroll/runs');
    assert.equal(mode.hiddenRule('/payroll/submissions')?.to, '/payroll/dashboard');
    assert.equal(mode.hiddenRule('/payroll/hmrc/eps/2026/3/download')?.to, '/payroll/dashboard');
    assert.equal(mode.hiddenRule('/settings/payroll/tax-rates')?.to, '/admin/config/staffology');
    assert.equal(mode.hiddenRule('/payrollrun/read/abc')?.to, '/payroll/dashboard');
    assert.equal(mode.hiddenRule('/overview/payrollsubmission')?.to, '/overview/payroll');
  });

  it('keeps the pages that switch to Staffology', () => {
    for (const p of ['/payroll/dashboard', '/payroll/runs', '/payroll/employee/abc', '/payroll/staffology', '/payroll/staffology/payslip/x', '/overview/payroll']) {
      assert.equal(mode.hiddenRule(p), null, p);
    }
  });

  it('hides engine paths and models only in Staffology mode, and My pay only outside it', () => {
    assert.equal(mode.hidesPath('/payroll/submissions'), false);
    assert.equal(mode.hidesModel('payrollRun'), false);
    assert.equal(mode.hidesPath('/my-pay'), true);
    on();
    assert.equal(mode.hidesPath('/payroll/submissions'), true);
    assert.equal(mode.hidesModel('payrollrun'), true);
    assert.equal(mode.hidesModel('employee'), false);
    assert.equal(mode.hidesPath('/my-pay'), false);
  });
});

describe('Staffology mode gate', () => {
  beforeEach(off);

  it('passes everything through when off, except My pay (404)', () => {
    let called = null;
    mode.gate(req('/payroll/submissions'), fakeRes(), (e) => { called = e ?? 'next'; });
    assert.equal(called, 'next');
    mode.gate(req('/my-pay'), fakeRes(), (e) => { called = e; });
    assert.equal(called.statusCode, 404);
  });

  it('redirects engine GETs, flashes on POST, and answers JSON with 409', () => {
    on();
    const r1 = fakeRes();
    mode.gate(req('/payroll/run/abc'), r1, () => assert.fail('should not continue'));
    assert.equal(r1.redirectedTo, '/payroll/runs');

    const q2 = req('/payroll/run/abc/lock', 'POST');
    const r2 = fakeRes();
    mode.gate(q2, r2, () => assert.fail('should not continue'));
    assert.equal(r2.redirectedTo, '/payroll/dashboard');
    assert.match(q2.flashes[0][1], /Staffology/);

    const r3 = fakeRes();
    mode.gate(req('/payroll/run/abc/entry/x', 'PATCH', { 'content-type': 'application/json' }), r3, () => assert.fail('should not continue'));
    assert.equal(r3.statusCode, 409);

    let next = false;
    mode.gate(req('/payroll/dashboard'), fakeRes(), () => { next = true; });
    assert.ok(next);
  });
});

describe('Payslips', () => {
  const pdf = Buffer.from('%PDF-1.4 test');

  it('decodes the octet-stream wrapper in its different shapes', () => {
    assert.deepEqual(decodePayslip({ content: 'p.pdf', stream: pdf.toString('base64') }), pdf);
    assert.deepEqual(decodePayslip(Buffer.from(JSON.stringify({ stream: pdf.toString('base64') }))), pdf);
    assert.deepEqual(decodePayslip({ stream: [...pdf] }), pdf);
    assert.deepEqual(decodePayslip(pdf), pdf);
    assert.equal(decodePayslip({ stream: Buffer.from('not a pdf').toString('base64') }), null);
    assert.equal(decodePayslip(null), null);
  });

  it('asks Staffology for the entry’s payslip report', async () => {
    let seen;
    const http = { get: async (url, opts) => { seen = { url, opts }; return { data: Buffer.from(JSON.stringify({ content: 'Payslip.pdf', stream: pdf.toString('base64') })) }; } };
    const out = await payslipFor({ ExternalId: 'entry-1', TaxYear: 2026, PayPeriod: 'Weekly', Period: 3, Ordinal: 1 }, http);
    assert.equal(seen.url, 'https://api.staffology.co.uk/employers/test-employer/reports/Year2026/Weekly/3/entry-1/payslip');
    assert.equal(seen.opts.headers.Accept, 'application/octet-stream');
    assert.equal(seen.opts.auth.password, 'test-staffology-key');
    assert.deepEqual(out.pdf, pdf);
    assert.equal(out.filename, 'Payslip.pdf');
  });

  it('refuses an entry without a Staffology reference', async () => {
    await assert.rejects(payslipFor({ TaxYear: 2026 }, { get: async () => ({}) }), /payslip reference/);
  });

  it('My pay only serves the user’s own entries', () => {
    assert.equal(ownsEntry('P1', { PayrollCode: 'p1 ' }), true);
    assert.equal(ownsEntry('P1', { PayrollCode: 'P2' }), false);
    assert.equal(ownsEntry(null, { PayrollCode: 'P1' }), false);
    assert.equal(ownsEntry('P1', null), false);
  });
});

describe('Staffology pay summaries', () => {
  const e = (code, paid, gross, extra = {}) => ({ PayrollCode: code, TaxYear: 2026, PayPeriod: 'Weekly', Period: 1, Ordinal: 1, PaymentDate: new Date(paid), Totals: { Gross: gross, Tax: 1, NetPay: gross - 1 }, ...extra });

  it('adds totals', () => {
    const t = provider.addTotals([e('A', '2026-04-10', 100), e('B', '2026-04-10', 50.555)]);
    assert.equal(t.Gross, 150.56);
    assert.equal(t.Tax, 2);
  });

  it('groups by tax month from the payment date (6th to 5th)', () => {
    const months = provider.groupByTaxMonth([
      e('A', '2026-04-06T12:00:00Z', 10),
      e('A', '2026-05-05T12:00:00Z', 10, { Period: 5 }),
      e('A', '2026-05-06T12:00:00Z', 10, { Period: 6 }),
      e('A', '2027-04-05T12:00:00Z', 10, { Period: 52 }),
      e('A', '2026-04-05T12:00:00Z', 10, { Period: 99 }), // previous tax year
    ], 2026);
    assert.deepEqual(months.map((m) => [m.taxMonth, m.runs]), [[1, 2], [2, 1], [12, 1]]);
  });

  it('groups entries by tax year, newest first', () => {
    const years = provider.groupByTaxYear([e('A', '2026-04-10', 10), e('A', '2025-12-01', 5, { TaxYear: 2025 })]);
    assert.deepEqual(years.map((y) => y.taxYear), [2026, 2025]);
    assert.equal(years[0].totals.Gross, 10);
  });
});
