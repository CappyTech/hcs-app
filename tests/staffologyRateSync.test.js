import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'test-key-for-unit-tests-only';

const {
  rateFromStaffology, planRateUpdate, ratesLockedFor, applyPlan, describeSummary, d2n, RATE_SOURCE, RATE_FIELDS,
} = await import('../mongoose/services/staffologyRateSyncService.js');
const { applyRecordLocks } = await import('../mongoose/controllers/CRUDController.js');

const D = (n) => mongoose.Types.Decimal128.fromString(String(n));
const pe = (o = {}) => ({ PayrollCode: 'T001', PayBasis: 'Hourly', BaseHourlyRate: 0, BaseDailyRate: 0, ...o });
const emp = (o = {}) => ({ definedRate: 'weekly', hourlyRate: D(0), dailyRate: D(0), payroll: { payrollId: 'T001' }, ...o });

describe('staffologyRateSyncService: mapping', () => {
  it('Hourly basis → defined hourly at BaseHourlyRate', () => {
    assert.deepEqual(rateFromStaffology(pe({ BaseHourlyRate: 12.5 })), { definedRate: 'hourly', field: 'hourlyRate', value: 12.5 });
  });

  it('Daily basis → defined daily at BaseDailyRate', () => {
    assert.deepEqual(rateFromStaffology(pe({ PayBasis: 'Daily', BaseDailyRate: 140, BaseHourlyRate: 17.5 })), { definedRate: 'daily', field: 'dailyRate', value: 140 });
  });

  it('Daily basis with no day rate falls back to the hourly rate', () => {
    assert.equal(rateFromStaffology(pe({ PayBasis: 'Daily', BaseHourlyRate: 18 })).definedRate, 'hourly');
  });

  it('Monthly (or any other) basis → defined hourly when there is an hourly rate', () => {
    assert.deepEqual(rateFromStaffology(pe({ PayBasis: 'Monthly', BaseHourlyRate: 16.25, PayAmount: 2500 })), { definedRate: 'hourly', field: 'hourlyRate', value: 16.25 });
    assert.equal(rateFromStaffology(pe({ PayBasis: 'Monthly', PayAmount: 2500 })), null);
  });

  it('missing, zero or junk rates → null', () => {
    assert.equal(rateFromStaffology(pe()), null);
    assert.equal(rateFromStaffology(pe({ BaseHourlyRate: null })), null);
    assert.equal(rateFromStaffology(pe({ BaseHourlyRate: -3 })), null);
    assert.equal(rateFromStaffology(pe({ BaseHourlyRate: 'abc' })), null);
    assert.equal(rateFromStaffology(null), null);
  });

  it('accepts basis in any case and rates as strings or Decimal128', () => {
    assert.equal(rateFromStaffology(pe({ PayBasis: 'daily', BaseDailyRate: '99.999' })).value, 100);
    assert.equal(rateFromStaffology(pe({ BaseHourlyRate: D('11.12346') })).value, 11.1235);
  });
});

describe('staffologyRateSyncService: plan', () => {
  it('a changed rate is planned', () => {
    const plan = planRateUpdate(emp({ definedRate: 'hourly', hourlyRate: D(10) }), pe({ BaseHourlyRate: 12 }));
    assert.deepEqual(plan, { definedRate: 'hourly', field: 'hourlyRate', value: 12, provenanceOnly: false });
  });

  it('a changed defined rate kind is planned even when the value matches', () => {
    const plan = planRateUpdate(emp({ definedRate: 'weekly', hourlyRate: D(12) }), pe({ BaseHourlyRate: 12 }));
    assert.equal(plan.provenanceOnly, false);
  });

  it('unchanged and already from Staffology → no update', () => {
    const e = emp({ definedRate: 'hourly', hourlyRate: D('12.0000'), payroll: { payrollId: 'T001', rateSource: RATE_SOURCE } });
    assert.equal(planRateUpdate(e, pe({ BaseHourlyRate: 12 })), null);
    const d = emp({ definedRate: 'daily', dailyRate: D('150.00'), payroll: { rateSource: RATE_SOURCE } });
    assert.equal(planRateUpdate(d, pe({ PayBasis: 'Daily', BaseDailyRate: 150 })), null);
  });

  it('unchanged but not yet marked → provenance only', () => {
    const plan = planRateUpdate(emp({ definedRate: 'hourly', hourlyRate: D(12) }), pe({ BaseHourlyRate: 12 }));
    assert.equal(plan.provenanceOnly, true);
  });

  it('never writes a 0 over a real rate', () => {
    const e = emp({ definedRate: 'hourly', hourlyRate: D(14) });
    assert.equal(planRateUpdate(e, pe({ BaseHourlyRate: 0 })), null);
    assert.equal(planRateUpdate(e, pe({ PayBasis: 'Daily', BaseDailyRate: 0 })), null);
    assert.equal(planRateUpdate(e, pe({ Status: 'Former' })), null);
  });

  it('applyPlan sets the defined rate, the rate as Decimal128 and provenance', () => {
    const doc = { payroll: {}, set(k, v) { const [a, b] = k.split('.'); this[a][b] = v; } };
    const when = new Date('2026-11-01T10:00:00Z');
    applyPlan(doc, { definedRate: 'daily', field: 'dailyRate', value: 135.5, provenanceOnly: false }, when);
    assert.equal(doc.definedRate, 'daily');
    assert.equal(doc.dailyRate.toString(), '135.50');
    assert.equal(doc.payroll.rateSource, RATE_SOURCE);
    assert.equal(doc.payroll.ratesSyncedAt, when);
  });

  it('applyPlan with provenance only leaves the rates alone', () => {
    const doc = { definedRate: 'hourly', hourlyRate: D(9), payroll: {}, set(k, v) { const [a, b] = k.split('.'); this[a][b] = v; } };
    applyPlan(doc, { definedRate: 'hourly', field: 'hourlyRate', value: 9, provenanceOnly: true });
    assert.equal(d2n(doc.hourlyRate), 9);
    assert.equal(doc.payroll.rateSource, RATE_SOURCE);
  });
});

describe('staffologyRateSyncService: locking and summary', () => {
  it('locks only in Staffology mode with a usable Staffology rate', () => {
    assert.equal(ratesLockedFor(pe({ BaseHourlyRate: 12 }), true), true);
    assert.equal(ratesLockedFor(pe({ BaseHourlyRate: 12 }), false), false);
    assert.equal(ratesLockedFor(pe(), true), false);
    assert.equal(ratesLockedFor(null, true), false);
  });

  it('applyRecordLocks makes locked fields read-only with the note', () => {
    const schema = { hourlyRate: { label: 'Hourly Rate', readOnly: false }, name: { label: 'Name', readOnly: false } };
    applyRecordLocks(schema, { fields: RATE_FIELDS, note: 'From Staffology' });
    assert.equal(schema.hourlyRate.readOnly, true);
    assert.equal(schema.hourlyRate.label, 'Hourly Rate (From Staffology)');
    assert.equal(schema.name.readOnly, false);
    assert.equal(schema.dailyRate, undefined);
  });

  it('describes a summary in plain words', () => {
    assert.match(describeSummary({ checked: 3, updated: 1, skipped: 2, failed: 0 }), /^Checked 3 linked employees, 1 updated/);
    assert.match(describeSummary({ checked: 1, updated: 0, skipped: 0, failed: 1 }), /could not be saved/);
    assert.match(describeSummary({ checked: 0, updated: 0, skipped: 0, failed: 0, reason: 'Not in Staffology mode' }), /not in staffology mode/);
  });
});

describe('staffologyRateSyncService: with the employee schema', async () => {
  const { default: employeeDef } = await import('../mongoose/models/mongoose/INTERNAL/employee.js');
  const Employee = mongoose.models.TestRateSyncEmployee || mongoose.model('TestRateSyncEmployee', employeeDef.schema);
  const existing = (o = {}) => Employee.hydrate({
    _id: new mongoose.Types.ObjectId(), uuid: 'test-uuid', name: 'Test Person',
    definedRate: 'weekly', weeklyRate: D(500), hourlyRate: D(12.5), dailyRate: D(100),
    contract: { hoursPerWeek: 40, workingDaysPerWeek: 5 }, payroll: { payrollId: 'T001' }, ...o,
  });

  it('an hourly rate from Staffology derives the other rates through the validate hook', async () => {
    const doc = existing();
    applyPlan(doc, planRateUpdate(doc, pe({ BaseHourlyRate: 15 })));
    await doc.validate();
    assert.equal(doc.definedRate, 'hourly');
    assert.equal(d2n(doc.hourlyRate), 15);
    assert.equal(d2n(doc.weeklyRate), 600);
    assert.equal(d2n(doc.dailyRate), 120);
    assert.equal(doc.payroll.rateSource, RATE_SOURCE);
  });

  it('a daily rate from Staffology derives the hourly rate', async () => {
    const doc = existing();
    applyPlan(doc, planRateUpdate(doc, pe({ PayBasis: 'Daily', BaseDailyRate: 160 })));
    await doc.validate();
    assert.equal(doc.definedRate, 'daily');
    assert.equal(d2n(doc.dailyRate), 160);
    assert.equal(d2n(doc.hourlyRate), 20);
  });
});
