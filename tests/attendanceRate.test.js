import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'test-key-for-unit-tests-only';
process.env.STAFFOLOGY_API_KEY = 'test-staffology-key';
process.env.STAFFOLOGY_EMPLOYER_ID = 'test-employer';

const mode = await import('../services/staffologyModeService.js');
const rates = (await import('../mongoose/services/attendanceRateService.js')).default;
const approval = (await import('../mongoose/services/attendanceApprovalService.js')).default;
const { grossPayFromRecords, hasEstimatedRate, savedHourlyRate } = await import('../mongoose/services/payrollCalculationService.js');
const labour = (await import('../mongoose/services/jobLabourService.js')).default;
const { summariseAttendance } = await import('../mongoose/services/payrollProviderService.js');

const on = () => mode._setFingerprintForTest(mode.fingerprint());
const off = () => mode._setFingerprintForTest(null);
const oid = () => new mongoose.Types.ObjectId();
const D = (n) => mongoose.Types.Decimal128.fromString(String(n));
const num = (v) => (v == null ? null : Number(v.toString()));

// ── A small in-memory stand-in for the models ───────────────────────────────

const get = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
function matches(row, filter = {}) {
  return Object.entries(filter).every(([k, cond]) => {
    const v = get(row, k);
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && !(cond instanceof mongoose.Types.ObjectId)) {
      if ('$ne' in cond) return cond.$ne === null ? v != null : String(v) !== String(cond.$ne);
      if ('$in' in cond) return cond.$in.some((x) => String(x) === String(v));
      if ('$nin' in cond) return !cond.$nin.some((x) => (x === null ? v == null : String(x) === String(v)));
      if ('$gt' in cond) return Number(v) > cond.$gt;
      if ('$gte' in cond || '$lt' in cond) return (!cond.$gte || v >= cond.$gte) && (!cond.$lt || v < cond.$lt);
      return false;
    }
    if (cond === null) return v == null;
    return String(v) === String(cond);
  });
}
function model(rows) {
  const calls = { bulk: [] };
  const query = (filter) => {
    const res = () => rows.filter((r) => matches(r, filter));
    const chain = { select: () => chain, lean: async () => res(), then: (a, b) => Promise.resolve(res()).then(a, b) };
    return chain;
  };
  return {
    rows,
    calls,
    find: query,
    findOne: (filter) => ({ lean: async () => rows.find((r) => matches(r, filter)) || null }),
    async findOneAndUpdate(filter, update) {
      const r = rows.find((x) => matches(x, filter));
      if (!r) return null;
      Object.assign(r, update);
      return r;
    },
    async updateMany(filter, update) {
      let n = 0;
      for (const r of rows) if (matches(r, filter)) { Object.assign(r, update); n++; }
      return { modifiedCount: n };
    },
    async bulkWrite(ops) {
      calls.bulk.push(ops);
      let n = 0;
      for (const { updateOne: { filter, update } } of ops) {
        const r = rows.find((x) => matches(x, filter));
        if (r) { Object.assign(r, update.$set); n++; }
      }
      return { modifiedCount: n };
    },
  };
}
const contractModel = () => ({ find: () => { const c = { select: () => c, lean: async () => [] }; return c; } });

const ADMIN = { _id: oid(), role: 'admin' };
const reqFor = (user) => ({ user, _projectScope: Promise.resolve({ contractIds: [], projectIds: [], projectNumbers: [], quoteIds: [], locationIds: [] }) });

// London: BST in June, so a London midnight is 23:00 UTC the day before.
const at = (iso) => new Date(iso);

describe('saving the rate on approval', () => {
  it('stampFor uses the current hourly rate and says where it came from', () => {
    const now = at('2026-06-10T12:00:00Z');
    const s = rates.stampFor({ hourlyRate: D('15.5'), payroll: { rateSource: 'staffology' } }, { now });
    assert.equal(num(s.hourly), 15.5);
    assert.equal(s.source, 'staffology');
    assert.equal(s.estimated, false);
    assert.equal(s.at, now);
    assert.equal(rates.stampFor({ hourlyRate: D(12) }).source, 'hcs-app');
    assert.equal(rates.stampFor({ hourlyRate: D(0) }), null, 'no rate, nothing saved');
  });

  it('only approved employee days without a pay run rate are stamped', () => {
    const e = oid();
    assert.equal(rates.shouldStampOnApproval({ employeeId: e, status: 'approved' }), true);
    assert.equal(rates.shouldStampOnApproval({ employeeId: e, status: 'approved', savedRate: { source: 'hcs-app' } }), true);
    assert.equal(rates.shouldStampOnApproval({ employeeId: e, status: 'approved', savedRate: { source: 'staffology-payrun' } }), false);
    assert.equal(rates.shouldStampOnApproval({ employeeId: e, status: 'site-approved' }), false);
    assert.equal(rates.shouldStampOnApproval({ subcontractorId: oid(), status: 'approved' }), false, 'subcontractors are paid on CIS invoices');
  });

  it('approveOne (admin) saves the employee rate on the day', async () => {
    const emp = { _id: oid(), hourlyRate: D(14), payroll: { rateSource: 'staffology' } };
    const day = { _id: oid(), uuid: 'a1', employeeId: emp._id, status: 'pending', type: 'work', hoursWorked: D(8), date: at('2026-06-08T23:00:00Z') };
    const db = { INTERNAL: { attendance: model([day]), employee: model([emp]), contract: contractModel() } };
    const res = await approval.approveOne(reqFor(ADMIN), 'a1', db);
    assert.equal(res.ok, true);
    assert.equal(day.status, 'approved');
    assert.equal(num(day.savedRate.hourly), 14);
    assert.equal(day.savedRate.source, 'staffology');
  });

  it('approveRange stamps every approved employee day, never a subcontractor day, never over a pay run rate', async () => {
    const emp = { _id: oid(), hourlyRate: D(20) };
    const sub = oid();
    const paid = { hourly: D(18), source: 'staffology-payrun', at: at('2026-06-01T00:00:00Z'), estimated: false };
    const rows = [
      { _id: oid(), uuid: 'r1', employeeId: emp._id, status: 'pending', type: 'work', hoursWorked: D(8), date: at('2026-06-08T23:00:00Z') },
      { _id: oid(), uuid: 'r2', employeeId: emp._id, status: 'pending', type: 'work', hoursWorked: D(8), date: at('2026-06-09T23:00:00Z'), savedRate: { ...paid } },
      { _id: oid(), uuid: 'r3', subcontractorId: sub, status: 'pending', type: 'work', date: at('2026-06-08T23:00:00Z') },
    ];
    const db = { INTERNAL: { attendance: model(rows), employee: model([emp]), contract: contractModel() } };
    const { counts } = await approval.approveRange(reqFor(ADMIN), new Date(0), new Date(), db);
    assert.equal(counts.approved, 3);
    assert.equal(num(rows[0].savedRate.hourly), 20);
    assert.equal(rows[0].savedRate.source, 'hcs-app');
    assert.equal(num(rows[1].savedRate.hourly), 18, 'the pay run rate stays');
    assert.equal(rows[1].savedRate.source, 'staffology-payrun');
    assert.equal(rows[2].savedRate, undefined);
  });

  it('a stamping failure never fails the approval', async () => {
    const day = { _id: oid(), uuid: 'f1', employeeId: oid(), status: 'pending', type: 'work', date: at('2026-06-08T23:00:00Z') };
    const broken = { find: () => { throw new Error('boom'); } };
    const db = { INTERNAL: { attendance: model([day]), employee: broken, contract: contractModel() } };
    const res = await approval.approveOne(reqFor(ADMIN), 'f1', db);
    assert.equal(res.ok, true);
    assert.equal(day.status, 'approved');
  });

  it('the CRUD form never writes the saved rate, and an admin approving there stamps it', async () => {
    const cfg = (await import('../mongoose/config/CRUDControllerConfig.js')).default.attendance;
    for (const f of ['savedRate.hourly', 'savedRate.source', 'savedRate.at', 'savedRate.estimated']) assert.ok(cfg.readOnly.includes(f), f);
    assert.equal(typeof cfg.afterCreate, 'function');
    assert.equal(typeof cfg.afterUpdate, 'function');
  });
});

// ── From the pay run ─────────────────────────────────────────────────────────

const entry = (o = {}) => ({
  PayrollCode: 'T001', IsClosed: true, BaseHourlyRate: 16,
  StartDate: at('2026-06-06T23:00:00Z'), EndDate: at('2026-06-12T23:00:00Z'), // 7–13 June, London
  ...o,
});

describe('pay run windows and plan (pure)', () => {
  it('leaves out open entries, entries without the new fields and zero rates', () => {
    const w = rates.payRunWindows([
      entry(),
      entry({ IsClosed: false }),
      entry({ BaseHourlyRate: undefined }),
      { PayrollCode: 'T001', IsClosed: true, StartDate: at('2026-06-06T23:00:00Z'), EndDate: at('2026-06-12T23:00:00Z') },
      entry({ BaseHourlyRate: 0 }),
      entry({ StartDate: null }),
    ]);
    assert.deepEqual(w, [{ from: '2026-06-07', to: '2026-06-13', rate: 16 }]);
  });

  it('uses Europe/London day boundaries, inclusive at both ends', () => {
    const w = rates.payRunWindows([entry()]);
    const day = (iso) => ({ _id: iso, date: at(iso) });
    const plan = rates.planPayRunRates(w, [
      day('2026-06-06T22:30:00Z'), // 6 June 23:30 London: before
      day('2026-06-06T23:30:00Z'), // 7 June 00:30 London: first day
      day('2026-06-13T22:59:00Z'), // 13 June 23:59 London: last day
      day('2026-06-13T23:00:00Z'), // 14 June London: after
    ]);
    assert.deepEqual(plan.updates.map((u) => u._id), ['2026-06-06T23:30:00Z', '2026-06-13T22:59:00Z']);
    assert.equal(plan.matched, 2);
  });

  it('two entries over the same day with different rates: a conflict, left alone', () => {
    const w = rates.payRunWindows([entry(), entry({ BaseHourlyRate: 17, StartDate: at('2026-06-09T23:00:00Z'), EndDate: at('2026-06-16T23:00:00Z') })]);
    const plan = rates.planPayRunRates(w, [
      { _id: 'a', date: at('2026-06-08T23:00:00Z') }, // 9 June: only the first
      { _id: 'b', date: at('2026-06-10T23:00:00Z') }, // 11 June: both
      { _id: 'c', date: at('2026-06-15T23:00:00Z') }, // 16 June: only the second
    ]);
    assert.deepEqual(plan.updates, [{ _id: 'a', rate: 16 }, { _id: 'c', rate: 17 }]);
    assert.deepEqual(plan.conflicts.map((d) => d._id), ['b']);
  });

  it('two entries with the same rate are no conflict; an up-to-date day needs no update', () => {
    const w = rates.payRunWindows([entry(), entry({ Ordinal: 2 })]);
    const plan = rates.planPayRunRates(w, [
      { _id: 'a', date: at('2026-06-08T23:00:00Z'), savedRate: { hourly: D('16.0000'), source: 'staffology-payrun', estimated: false } },
      { _id: 'b', date: at('2026-06-08T23:00:00Z'), savedRate: { hourly: D(16), source: 'hcs-app' } },
    ]);
    assert.deepEqual(plan.updates, [{ _id: 'b', rate: 16 }]);
    assert.equal(plan.unchanged, 1);
    assert.equal(plan.conflicts.length, 0);
  });
});

function payrunDb({ entries, employees, days }) {
  return {
    INTERNAL: { employee: model(employees), attendance: model(days) },
    STAFFOLOGY: { payrollpayrunentry: model(entries) },
  };
}

describe('correctFromPayRuns', () => {
  beforeEach(on);
  after(off);

  it('does nothing outside Staffology mode', async () => {
    off();
    const s = await rates.correctFromPayRuns({ db: payrunDb({ entries: [], employees: [], days: [] }) });
    assert.match(s.reason, /Staffology mode/);
  });

  it('sets the paid rate on the person\'s days in the period, matched by payroll code ignoring case', async () => {
    const emp = { _id: oid(), payroll: { payrollId: ' t001 ' } };
    const other = { _id: oid(), payroll: { payrollId: 'T002' } };
    const days = [
      { _id: oid(), employeeId: emp._id, status: 'approved', date: at('2026-06-07T23:00:00Z'), savedRate: { hourly: D(15), source: 'hcs-app' } },
      { _id: oid(), employeeId: emp._id, status: 'pending', date: at('2026-06-10T23:00:00Z') },
      { _id: oid(), employeeId: emp._id, status: 'approved', date: at('2026-06-14T23:00:00Z') }, // after the period
      { _id: oid(), employeeId: other._id, status: 'approved', date: at('2026-06-07T23:00:00Z') },
    ];
    const db = payrunDb({ entries: [entry({ BaseHourlyRate: 16.25 })], employees: [emp, other], days });
    const s = await rates.correctFromPayRuns({ db });
    assert.equal(s.fromPayRun, 2);
    assert.equal(s.conflicts, 0);
    assert.equal(num(days[0].savedRate.hourly), 16.25);
    assert.equal(days[0].savedRate.source, 'staffology-payrun');
    assert.equal(days[0].savedRate.estimated, false);
    assert.equal(days[1].savedRate.source, 'staffology-payrun');
    assert.equal(days[2].savedRate, undefined);
    assert.equal(days[3].savedRate, undefined);

    const again = await rates.correctFromPayRuns({ db });
    assert.equal(again.fromPayRun, 0, 'idempotent');
    assert.equal(again.matched, 2);
  });

  it('skips entries without the new fields and counts conflicting days', async () => {
    const emp = { _id: oid(), payroll: { payrollId: 'T001' } };
    const days = [{ _id: oid(), employeeId: emp._id, status: 'approved', date: at('2026-06-10T23:00:00Z') }];
    const entries = [
      { PayrollCode: 'T001', IsClosed: true, StartDate: at('2026-06-06T23:00:00Z'), EndDate: at('2026-06-12T23:00:00Z') },
      entry({ BaseHourlyRate: 16 }),
      entry({ BaseHourlyRate: 18 }),
    ];
    const s = await rates.correctFromPayRuns({ db: payrunDb({ entries, employees: [emp], days }) });
    assert.equal(s.conflicts, 1);
    assert.equal(s.fromPayRun, 0);
    assert.equal(days[0].savedRate, undefined);
  });
});

describe('backfill', () => {
  beforeEach(on);
  after(off);

  it('pay run rate where there is one, the current rate (estimated) elsewhere, conflicts and no-rate people left alone', async () => {
    const emp = { _id: oid(), hourlyRate: D(15), payroll: { payrollId: 'T001' } };
    const noRate = { _id: oid(), hourlyRate: D(0), payroll: {} };
    const days = [
      { _id: oid(), employeeId: emp._id, status: 'approved', date: at('2026-06-07T23:00:00Z') }, // in the pay run
      { _id: oid(), employeeId: emp._id, status: 'approved', date: at('2026-05-01T23:00:00Z') }, // no pay run
      { _id: oid(), employeeId: emp._id, status: 'pending', date: at('2026-05-02T23:00:00Z') }, // not approved
      { _id: oid(), employeeId: emp._id, status: 'approved', date: at('2026-05-03T23:00:00Z'), savedRate: { hourly: D(13), source: 'hcs-app' } },
      { _id: oid(), employeeId: noRate._id, status: 'approved', date: at('2026-05-01T23:00:00Z') },
      { _id: oid(), employeeId: emp._id, status: 'approved', date: at('2026-06-20T23:00:00Z') }, // conflict
    ];
    const entries = [
      entry({ BaseHourlyRate: 16 }),
      entry({ BaseHourlyRate: 16, StartDate: at('2026-06-19T23:00:00Z'), EndDate: at('2026-06-21T23:00:00Z') }),
      entry({ BaseHourlyRate: 19, StartDate: at('2026-06-19T23:00:00Z'), EndDate: at('2026-06-21T23:00:00Z') }),
    ];
    const db = payrunDb({ entries, employees: [emp, noRate], days });
    const s = await rates.backfill({ db });
    assert.deepEqual(s, { stamped: 2, fromPayRun: 1, estimated: 1, conflicts: 1, skipped: 2 });
    assert.equal(days[0].savedRate.source, 'staffology-payrun');
    assert.equal(num(days[1].savedRate.hourly), 15);
    assert.equal(days[1].savedRate.estimated, true);
    assert.equal(days[1].savedRate.source, 'hcs-app');
    assert.equal(days[2].savedRate, undefined);
    assert.equal(num(days[3].savedRate.hourly), 13, 'a saved rate is kept');
    assert.equal(days[4].savedRate, undefined);
    assert.equal(days[5].savedRate, undefined);

    const again = await rates.backfill({ db });
    assert.equal(again.stamped, 0, 'safe to run again');
  });

  it('outside Staffology mode it still fills approved days with the current rate', async () => {
    off();
    const emp = { _id: oid(), hourlyRate: D(12), payroll: {} };
    const days = [{ _id: oid(), employeeId: emp._id, status: 'approved', date: at('2026-05-01T23:00:00Z') }];
    const s = await rates.backfill({ db: payrunDb({ entries: [entry()], employees: [emp], days }) });
    assert.equal(s.estimated, 1);
    assert.equal(s.fromPayRun, 0);
  });

  it('describes a pay run pass in plain words', () => {
    assert.match(rates.describePayRun({ fromPayRun: 3, conflicts: 1 }), /3 attendance days .* 1 day left alone/);
    assert.equal(rates.describePayRun({ reason: 'Not in Staffology mode' }), '');
  });
});

// ── Costing ──────────────────────────────────────────────────────────────────

describe('costing uses the saved rate', () => {
  const employee = { hourlyRate: D(20) };
  const saved = (h, extra = {}) => ({ hourly: D(h), source: 'staffology-payrun', estimated: false, ...extra });
  const records = [
    { hoursWorked: D(8), savedRate: saved(15) },        // 120 at the saved rate
    { hoursWorked: D(8) },                              // 160 at the current rate
    { dayRate: D(150), savedRate: saved(15) },          // 150, day rate wins
    { hoursWorked: D(4), savedRate: saved(0) },         // 80: a 0 saved rate counts as none
  ];

  it('grossPayFromRecords mixes saved and current rates; day rates unchanged', () => {
    assert.equal(grossPayFromRecords(records, employee), 120 + 160 + 150 + 80);
    assert.equal(savedHourlyRate(records[0]), 15);
    assert.equal(savedHourlyRate(records[1]), null);
  });

  it('estimated: hourly days with no saved rate or an estimated one', () => {
    assert.equal(hasEstimatedRate(records[0]), false);
    assert.equal(hasEstimatedRate(records[1]), true);
    assert.equal(hasEstimatedRate(records[2]), false, 'day rate days are not estimated');
    assert.equal(hasEstimatedRate({ hoursWorked: D(8), savedRate: saved(15, { estimated: true }) }), true);
  });

  it('jobLabour groups and cost match grossPayFromRecords', () => {
    const e = oid();
    const job = oid();
    const rows = records.map((r, i) => ({ ...r, employeeId: e, jobRegisterId: job, status: 'approved', type: 'work', date: at(`2026-06-0${i + 1}T09:00:00Z`) }));
    const [g] = labour.groupRecords(rows);
    assert.equal(g.savedRateCost, 120);
    assert.equal(g.hourlyHours, 12);
    assert.equal(g.estimatedRateDays, 2);
    assert.equal(labour.groupCost(g, employee), grossPayFromRecords(records, employee));

    const out = labour.labourForJob([g], { employeesById: new Map([[String(e), { name: 'Test Person', hourlyRate: D(20) }]]) });
    assert.equal(out.employees.cost, 510);
    assert.equal(out.employees.estimatedRateDays, 2);
    assert.equal(out.people[0].estimatedRateDays, 2);
  });

  it('groupsPipeline sums the saved rate cost separately from the current-rate hours', () => {
    const group = labour.groupsPipeline({})[1].$group;
    assert.ok(group.savedRateCost);
    assert.ok(group.hourlyHours);
    assert.ok(group.estimatedRateDays);
  });

  it('pay vs attendance expected gross uses the saved rate', () => {
    const s = summariseAttendance([
      { type: 'work', status: 'approved', hoursWorked: D(8), savedRate: saved(15), date: at('2026-06-08T09:00:00Z') },
      { type: 'work', status: 'approved', hoursWorked: D(8), date: at('2026-06-09T09:00:00Z') },
    ], employee);
    assert.equal(s.expectedGross, 280);
  });
});

describe('jobRegistry', () => {
  it('imports and registers its jobs without a database', async () => {
    const scheduler = (await import('../mongoose/services/jobSchedulerService.js')).default;
    const registry = (await import('../mongoose/services/jobRegistry.js')).default;
    scheduler._reset();
    registry.registerAll();
    const jobs = new Map(scheduler.getStatus().map((j) => [j.name, j]));
    assert.ok(jobs.has('staffology-rate-sync'));
    assert.equal(jobs.get('attendance-rate-backfill')?.intervalMs, null, 'manual only');
    scheduler._reset();
  });
});
