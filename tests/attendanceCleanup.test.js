// Attendance clean-up: overtime, pay rate and break are gone; a
// subcontractor's record holds where and when only (no hours, no day rate:
// they're paid on CIS invoices); and the start-up step clears old values,
// keeping any real ones.
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import logger from '../services/loggerService.js';
import attendanceModel, {
  REMOVED_FIELDS, SUBCONTRACTOR_PAY_FIELDS, stripSubcontractorPay,
} from '../mongoose/models/mongoose/INTERNAL/attendance.js';
import { grossPayFromRecords } from '../mongoose/services/payrollCalculationService.js';
import cleanup, {
  CLEANUP_GROUPS, isRealValue, isClearable, planGroup,
} from '../mongoose/services/attendanceFieldCleanup.js';
import weeklyFlow from '../mongoose/services/weeklyFlowService.js';
import * as ctrl from '../mongoose/controllers/attendanceController.js';
import crudConfig from '../mongoose/config/CRUDControllerConfig.js';

const Attendance = mongoose.models.attendanceCleanupTest
  || mongoose.model('attendanceCleanupTest', attendanceModel.schema.clone());
const dec = (s) => mongoose.Types.Decimal128.fromString(String(s));
const oid = () => new mongoose.Types.ObjectId();
const LOC = oid();

describe('Payroll gross pay from attendance', () => {
  it('pays hours × the employee\'s hourly rate', () => {
    assert.equal(grossPayFromRecords([{ hoursWorked: 8 }, { hoursWorked: dec('7.5') }], { hourlyRate: 12 }), 186);
  });

  it('pays the day rate when the record has one', () => {
    assert.equal(grossPayFromRecords([{ dayRate: dec('150') }, { hoursWorked: 4 }], { hourlyRate: 10 }), 190);
  });

  it('ignores the removed pay rate and overtime on an old record', () => {
    const old = { hoursWorked: 8, payRate: dec('99'), overtimeHours: dec('2'), overtimeRate: dec('30'), breakMinutes: 30 };
    assert.equal(grossPayFromRecords([old], { hourlyRate: 12 }), 96);
  });

  it('is nothing with no hourly rate or records', () => {
    assert.equal(grossPayFromRecords([{ hoursWorked: 8 }], {}), 0);
    assert.equal(grossPayFromRecords([], { hourlyRate: 12 }), 0);
  });
});

describe('Attendance model', () => {
  it('no longer has the removed fields', () => {
    for (const f of REMOVED_FIELDS) assert.equal(attendanceModel.schema.path(f), undefined, f);
    for (const f of SUBCONTRACTOR_PAY_FIELDS) assert.ok(attendanceModel.schema.path(f), f);
  });

  it('drops hours and day rate from a subcontractor\'s record', async () => {
    const doc = new Attendance({ subcontractorId: oid(), date: new Date(), locationId: LOC, hoursWorked: 8 });
    await doc.validate();
    assert.equal(doc.hoursWorked, undefined);
    const rated = new Attendance({ subcontractorId: oid(), date: new Date(), locationId: LOC, dayRate: 150 });
    await rated.validate();
    assert.equal(rated.dayRate, undefined);
  });

  it('keeps an employee\'s hours', async () => {
    const doc = new Attendance({ employeeId: oid(), date: new Date(), locationId: LOC, hoursWorked: 8 });
    await doc.validate();
    assert.equal(doc.hoursWorked.toString(), '8');
  });

  it('no longer asks for an overtime rate', async () => {
    const doc = new Attendance({ employeeId: oid(), date: new Date(), locationId: LOC, overtimeHours: 4 });
    await doc.validate();
    assert.equal(doc.get('overtimeHours'), undefined);
  });

  it('stripSubcontractorPay drops them from plain data, for subcontractors only', () => {
    const sub = { subcontractorId: 'x', hoursWorked: 8, dayRate: 150, notes: 'n' };
    assert.deepEqual(stripSubcontractorPay(sub), { subcontractorId: 'x', notes: 'n' });
    const emp = { employeeId: 'y', hoursWorked: 8 };
    assert.deepEqual(stripSubcontractorPay(emp), { employeeId: 'y', hoursWorked: 8 });
  });
});

describe('Writers never give a subcontractor hours or a day rate', () => {
  let savedINTERNAL; let savedREST;
  before(() => { savedINTERNAL = mdb.INTERNAL; savedREST = mdb.REST; });
  afterEach(() => { mdb.INTERNAL = savedINTERNAL; mdb.REST = savedREST; });

  const ADMIN = { _id: oid(), role: 'admin', username: 'admin' };
  const lean = (v) => ({ lean: async () => v, select: () => ({ lean: async () => v }) });
  const jsonRes = () => {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
  };

  it('the weekly flow records a subcontractor\'s days without the hours sent', async () => {
    const SUB = oid(); const EMP = oid(); const CON = oid();
    const week = (await import('../mongoose/services/attendanceService.js')).default.resolvePayrollWeek(2026, 30);
    let inserted = [];
    mdb.INTERNAL = {
      assignment: { findOne: () => lean({ _id: oid(), contractId: CON, weekStart: new Date(`${week.days[0]}T12:00:00Z`), assignedEmployees: [EMP], assignedSubcontractors: [SUB] }) },
      contract: { findById: () => lean({ _id: CON, locationId: LOC }) },
      holidayRequest: { find: () => lean([]) },
      attendance: {
        find: () => lean([]),
        insertMany: async (docs) => { inserted = docs; return docs; },
      },
    };
    const day = week.days[2];
    const r = await weeklyFlow.recordAttendance(2026, 30, {
      assignmentUuid: 'a1', isAdmin: true,
      days: { [`s:${SUB}`]: [day], [`e:${EMP}`]: [day] },
      hours: { [`s:${SUB}`]: 8, [`e:${EMP}`]: 8 },
    });
    assert.equal(r.created, 2);
    const sub = inserted.find((d) => d.subcontractorId);
    const emp = inserted.find((d) => d.employeeId);
    assert.equal('hoursWorked' in sub, false);
    assert.equal('dayRate' in sub, false);
    assert.equal(emp.hoursWorked, 8);
  });

  it('inline create drops a day rate sent for a subcontractor', async () => {
    const created = [];
    function Att(data) { Object.assign(this, data); this.uuid = 'u1'; created.push(data); }
    Att.prototype.save = async function save() {};
    mdb.INTERNAL = { attendance: Att };
    const res = jsonRes();
    await ctrl.inlineCreateAttendance(
      { user: ADMIN, body: { subcontractorId: String(oid()), date: '2026-11-04', type: 'work', dayRate: 150, hoursWorked: 8, locationId: String(LOC) } },
      res, (e) => { throw e; },
    );
    assert.equal(res.statusCode, 201);
    assert.equal('dayRate' in created[0], false);
    assert.equal('hoursWorked' in created[0], false);
    assert.equal(res.body.record.dayRate, null);
  });

  it('inline update ignores hours and a day rate for a subcontractor, and clears any left', async () => {
    let update = null;
    mdb.INTERNAL = {
      attendance: {
        findOne: () => ({ lean: async () => ({ uuid: 'u1', status: 'pending', subcontractorId: oid() }) }),
        findOneAndUpdate: async (_q, u) => { update = u; return { uuid: 'u1', type: 'work', status: 'pending' }; },
      },
    };
    const res = jsonRes();
    await ctrl.updateAttendance({ user: ADMIN, params: { uuid: 'u1' }, body: { type: 'work', dayRate: 150 } }, res, (e) => { throw e; });
    assert.equal(res.body.success, true);
    assert.equal('dayRate' in update, false);
    assert.equal('hoursWorked' in update, false);
    assert.deepEqual(update.$unset, { hoursWorked: 1, dayRate: 1 });
  });

  it('inline update still sets an employee\'s hours', async () => {
    let update = null;
    mdb.INTERNAL = {
      attendance: {
        findOne: () => ({ lean: async () => ({ uuid: 'u2', status: 'pending', employeeId: oid() }) }),
        findOneAndUpdate: async (_q, u) => { update = u; return { uuid: 'u2', type: 'work', status: 'pending', hoursWorked: 7 }; },
      },
    };
    const res = jsonRes();
    await ctrl.updateAttendance({ user: ADMIN, params: { uuid: 'u2' }, body: { hoursWorked: 7 } }, res, (e) => { throw e; });
    assert.equal(update.hoursWorked, 7);
    assert.equal(update.$unset, undefined);
  });

  it('the generic create drops them even for an admin', async () => {
    const data = { subcontractorId: oid(), hoursWorked: 8, dayRate: 150 };
    await crudConfig.attendance.beforeCreate(data, { user: ADMIN });
    assert.equal('hoursWorked' in data, false);
    assert.equal('dayRate' in data, false);
    assert.equal(crudConfig.attendance.useSave, true, 'generic update runs the model\'s pre-validate');
  });
});

// A small in-memory stand-in for the attendance collection, matching the
// query operators the clean-up uses.
function inList(v, list) {
  return list.some((a) => (a === null ? v == null : v != null && Number(String(v)) === a));
}
function matches(doc, q) {
  return Object.entries(q).every(([k, cond]) => {
    if (k === '$or') return cond.some((c) => matches(doc, c));
    if (k === '$and') return cond.every((c) => matches(doc, c));
    const v = doc[k];
    return Object.entries(cond).every(([op, arg]) => {
      if (op === '$ne') return arg === null ? v != null : v !== arg;
      if (op === '$in') return inList(v, arg);
      if (op === '$nin') return !inList(v, arg);
      if (op === '$exists') return (k in doc) === arg;
      throw new Error(`unexpected ${op}`);
    });
  });
}
function fakeCollection(docs) {
  const calls = { count: 0, updates: [] };
  return {
    calls,
    model: {
      countDocuments: async (q) => { calls.count++; return docs.filter((d) => matches(d, q)).length; },
      updateMany: async (q, u, opts) => {
        calls.updates.push({ q, u, opts });
        let modifiedCount = 0;
        for (const d of docs.filter((x) => matches(x, q))) {
          for (const f of Object.keys(u.$unset)) delete d[f];
          modifiedCount++;
        }
        return { modifiedCount };
      },
    },
  };
}

describe('Start-up attendance field clean-up', () => {
  const [REMOVED, SUBS] = CLEANUP_GROUPS;
  let warnings; let savedWarn; let savedInfo;
  before(() => {
    savedWarn = logger.warn; savedInfo = logger.info;
    logger.warn = (m) => { warnings.push(m); };
    logger.info = () => {};
  });
  after(() => { logger.warn = savedWarn; logger.info = savedInfo; });

  it('counts only non-null, non-zero values as real', () => {
    assert.equal(isRealValue(null), false);
    assert.equal(isRealValue(undefined), false);
    assert.equal(isRealValue(0), false);
    assert.equal(isRealValue(dec('0.00')), false);
    assert.equal(isRealValue(12.5), true);
    assert.equal(isRealValue(dec('150')), true);
  });

  it('keeps a document with any real value in its group, clears the rest', () => {
    assert.equal(isClearable({ breakMinutes: 0 }, REMOVED_FIELDS), true);
    assert.equal(isClearable({ breakMinutes: 0, payRate: null }, REMOVED_FIELDS), true);
    assert.equal(isClearable({ breakMinutes: 0, payRate: dec('15') }, REMOVED_FIELDS), false);
    assert.equal(isClearable({ dayRate: 150 }, SUBCONTRACTOR_PAY_FIELDS), false);
  });

  it('plans: nothing, clear, or clear with a warning naming the kept fields', () => {
    assert.deepEqual(planGroup(REMOVED, { present: 0 }), { clear: false, kept: {}, warning: null });
    assert.deepEqual(planGroup(REMOVED, { present: 40, real: { breakMinutes: 0 } }), { clear: true, kept: {}, warning: null });
    const p = planGroup(REMOVED, { present: 40, real: { payRate: 3, overtimeHours: 1 } });
    assert.deepEqual(p.kept, { overtimeHours: 1, payRate: 3 });
    assert.match(p.warning, /overtimeHours on 1 record\(s\), payRate on 3 record\(s\)/);
  });

  it('clears empty fields without touching updatedAt, and leaves real values alone', async () => {
    warnings = [];
    const SUB = oid();
    const docs = [
      { _id: 1, employeeId: oid(), breakMinutes: 0, hoursWorked: 8 },
      { _id: 2, employeeId: oid(), breakMinutes: 0, payRate: dec('15') },
      { _id: 3, subcontractorId: SUB, breakMinutes: 0, hoursWorked: 0 },
      { _id: 4, subcontractorId: SUB, dayRate: dec('150') },
      { _id: 5, employeeId: oid(), hoursWorked: 8 },
    ];
    const { model, calls } = fakeCollection(docs);
    const out = await cleanup.cleanupAttendanceFields({ INTERNAL: { attendance: model } });

    assert.deepEqual(out.removed, { cleared: 2, kept: { payRate: 1 } });
    assert.deepEqual(out.subcontractor, { cleared: 1, kept: { dayRate: 1 } });
    assert.deepEqual(docs[0], { _id: 1, employeeId: docs[0].employeeId, hoursWorked: 8 }, 'an employee keeps their hours');
    assert.equal(docs[1].payRate.toString(), '15', 'a real pay rate is kept');
    assert.equal(docs[1].breakMinutes, 0, 'and its document left alone');
    assert.deepEqual(Object.keys(docs[2]).sort(), ['_id', 'subcontractorId']);
    assert.equal(docs[3].dayRate.toString(), '150', 'a real subcontractor day rate is kept');
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /payRate on 1 record/);
    assert.match(warnings[1], /dayRate on 1 record/);
    for (const u of calls.updates) assert.deepEqual(u.opts, { timestamps: false, strict: false });
  });

  it('is one count per group when there is nothing to do', async () => {
    warnings = [];
    const { model, calls } = fakeCollection([{ _id: 1, employeeId: oid(), hoursWorked: 8 }, { _id: 2, subcontractorId: oid() }]);
    const out = await cleanup.cleanupAttendanceFields({ INTERNAL: { attendance: model } });
    assert.equal(calls.count, 2);
    assert.equal(calls.updates.length, 0);
    assert.deepEqual(out.removed, { cleared: 0, kept: {} });
    assert.deepEqual(warnings, []);
  });

  it('is idempotent', async () => {
    warnings = [];
    const docs = [{ _id: 1, employeeId: oid(), breakMinutes: 0, overtimeHours: null }];
    const { model, calls } = fakeCollection(docs);
    await cleanup.cleanupAttendanceFields({ INTERNAL: { attendance: model } });
    assert.deepEqual(Object.keys(docs[0]).sort(), ['_id', 'employeeId']);
    const before2 = calls.updates.length;
    await cleanup.cleanupAttendanceFields({ INTERNAL: { attendance: model } });
    assert.equal(calls.updates.length, before2, 'nothing more to clear');
  });

  it('does nothing without the model', async () => {
    assert.deepEqual(await cleanup.cleanupAttendanceFields({ INTERNAL: {} }), {});
  });
});
