import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchEmployees, comparePeriod, summariseAttendance, periodKey, parsePeriodKey, employeesByPayrollCode,
} from '../mongoose/services/payrollProviderService.js';

// A Staffology weekly period, Saturday to Friday, paid the following Friday.
const at = (day, time = '00:00:00') => new Date(`${day}T${time}Z`);
const E1 = '0000000000000000000000e1';
const E2 = '0000000000000000000000e2';
const E3 = '0000000000000000000000e3';

const employees = [
  { _id: E1, uuid: 'u1', name: 'Alex Example', hourlyRate: 20, payroll: { payrollId: 'P001' } },
  { _id: E2, uuid: 'u2', name: 'Sam Sample', hourlyRate: 15, payroll: { payrollId: ' p002 ' } },
  { _id: E3, uuid: 'u3', name: 'Jo Nobody', hourlyRate: 10, payroll: {} },
];

function entry(overrides = {}) {
  return {
    ExternalId: 'x1', PayrollCode: 'P001', EmployeeName: 'Alex Example',
    TaxYear: 2026, PayPeriod: 'Weekly', Period: 30, Ordinal: 1,
    StartDate: at('2026-10-24'), EndDate: at('2026-10-30'), PaymentDate: at('2026-11-06'),
    IsClosed: false, SyncedAt: at('2026-11-06', '12:00:00'),
    Totals: { Gross: 320, Tax: 20, EmployeeNi: 10, EmployerNi: 16, NetPay: 290, TotalCost: 336 },
    ...overrides,
  };
}

const work = (employeeId, day, status = 'approved', extra = {}) => ({
  employeeId, date: at(day), type: 'work', status, hoursWorked: 8, updatedAt: at(day, '18:00:00'), ...extra,
});

const flagsFor = (result, name) => result.rows.find((r) => r.name === name)?.flags;

describe('payrollProviderService', () => {
  it('matches by payroll code, ignoring case and spaces', () => {
    const byCode = employeesByPayrollCode(employees);
    assert.equal(byCode.get('p002').uuid, 'u2');
    assert.equal(byCode.size, 2);
  });

  it('suggests an unlinked employee by exact name when the code does not match', () => {
    const matches = matchEmployees([
      { PayrollCode: 'P001', FirstName: 'Alex', LastName: 'Example' },
      { PayrollCode: 'P009', FirstName: 'Jo', LastName: 'Nobody' },
      { PayrollCode: 'P010', FirstName: 'Someone', LastName: 'Else' },
    ], employees);
    assert.equal(matches[0].employee.uuid, 'u1');
    assert.equal(matches[1].employee, null);
    assert.equal(matches[1].suggestion.uuid, 'u3');
    assert.equal(matches[2].suggestion, null);
  });

  it('suggests by first name or short form when hcs-app only has a first name', () => {
    const staff = [
      { _id: 'a', uuid: 'ua', name: 'Dan', payroll: {} },
      { _id: 'b', uuid: 'ub', name: 'Bev', payroll: {}, status: 'inactive' },
      { _id: 'c', uuid: 'uc', name: 'Sam', payroll: {} },
    ];
    const m = matchEmployees([
      { PayrollCode: 'X1', FirstName: 'Daniel', LastName: 'Example' },
      { PayrollCode: 'X2', FirstName: 'Beverley', LastName: 'Example' },
      { PayrollCode: 'X3', FirstName: 'Michael', LastName: 'Example' },
    ], staff);
    assert.equal(m[0].suggestion.uuid, 'ua');
    assert.equal(m[1].suggestion.uuid, 'ub');
    assert.equal(m[2].suggestion, null);
    // Pick-list: suggestion first, then active before inactive.
    assert.deepEqual(m[0].candidates.map((c) => c.uuid), ['ua', 'uc', 'ub']);
    assert.deepEqual(m[2].candidates.map((c) => c.uuid), ['ua', 'uc', 'ub']);
  });

  it('does not suggest one employee for two Staffology people', () => {
    const staff = [{ _id: 'a', uuid: 'ua', name: 'Sam', payroll: {} }];
    const m = matchEmployees([
      { PayrollCode: 'X1', FirstName: 'Samuel', LastName: 'One' },
      { PayrollCode: 'X2', FirstName: 'Samantha', LastName: 'Two' },
    ], staff);
    assert.equal(m[0].suggestion, null);
    assert.equal(m[1].suggestion, null);
    assert.equal(m[0].candidates.length, 1);
  });

  it('ignores prefixes shorter than three letters and linked employees', () => {
    const staff = [
      { _id: 'a', uuid: 'ua', name: 'Al', payroll: {} },
      { _id: 'b', uuid: 'ub', name: 'Chris', payroll: { payrollId: 'X9' } },
    ];
    const m = matchEmployees([
      { PayrollCode: 'X1', FirstName: 'Alan', LastName: 'Example' },
      { PayrollCode: 'X2', FirstName: 'Christopher', LastName: 'Example' },
    ], staff);
    assert.equal(m[0].suggestion, null);
    assert.equal(m[1].suggestion, null);
    assert.deepEqual(m[1].candidates.map((c) => c.uuid), ['ua']);
  });

  it('a week paid as approved has no flags', () => {
    const res = comparePeriod({ entries: [entry()], employees, attendance: [work(E1, '2026-10-26'), work(E1, '2026-10-27')] });
    const row = res.rows[0];
    assert.equal(row.approvedHours, 16);
    assert.equal(row.expectedGross, 320);
    assert.equal(row.difference, 0);
    assert.deepEqual(row.flags, []);
    assert.equal(res.flagged, 0);
  });

  it('within £1 is rounding; above it is flagged', () => {
    const att = [work(E1, '2026-10-26'), work(E1, '2026-10-27')];
    assert.deepEqual(comparePeriod({ entries: [entry({ Totals: { Gross: 320.9 } })], employees, attendance: att }).rows[0].flags, []);
    assert.deepEqual(comparePeriod({ entries: [entry({ Totals: { Gross: 400 } })], employees, attendance: att }).rows[0].flags, ['gross-differs']);
  });

  it('uses the day rate where a record has one', () => {
    const s = summariseAttendance([work(E1, '2026-10-26', 'approved', { dayRate: 150 })], employees[0]);
    assert.equal(s.expectedGross, 150);
  });

  it('flags pay with no approved attendance, and pending days', () => {
    const res = comparePeriod({ entries: [entry()], employees, attendance: [work(E1, '2026-10-26', 'pending')] });
    assert.deepEqual(res.rows[0].flags, ['paid-no-attendance', 'unapproved-days']);
    assert.deepEqual(res.rows[0].unapprovedDays, ['2026-10-26']);
  });

  it('only counts attendance inside the entry window', () => {
    const res = comparePeriod({
      entries: [entry()], employees,
      attendance: [work(E1, '2026-10-23'), work(E1, '2026-10-31'), work(E1, '2026-10-26'), work(E1, '2026-10-27')],
    });
    assert.equal(res.rows[0].approvedDays, 2);
  });

  it('ignores holiday and other non-work records', () => {
    const res = comparePeriod({
      entries: [entry({ Totals: { Gross: 0 } })], employees,
      attendance: [{ employeeId: E1, date: at('2026-10-26'), type: 'holiday', status: 'approved', hoursWorked: 8 }],
    });
    assert.deepEqual(res.rows[0].flags, []);
  });

  it('flags an entry nobody in hcs-app matches', () => {
    const res = comparePeriod({ entries: [entry({ PayrollCode: 'P404', EmployeeName: 'Unknown Person' })], employees, attendance: [] });
    assert.deepEqual(flagsFor(res, 'Unknown Person'), ['unmatched']);
  });

  it('adds people with approved attendance but no pay entry', () => {
    const res = comparePeriod({ entries: [entry()], employees, attendance: [work(E1, '2026-10-26'), work(E1, '2026-10-27'), work(E2, '2026-10-28')] });
    const row = res.rows.find((r) => r.name === 'Sam Sample');
    assert.equal(row.entry, null);
    assert.deepEqual(row.flags, ['attendance-not-paid']);
    assert.equal(row.expectedGross, 120);
    assert.equal(row.difference, -120);
  });

  it('skips people Staffology pays on another schedule', () => {
    const res = comparePeriod({
      entries: [entry()], employees,
      attendance: [work(E1, '2026-10-26'), work(E1, '2026-10-27'), work(E2, '2026-10-28')],
      payrollEmployees: [{ PayrollCode: 'P002', PayPeriod: 'Monthly' }],
    });
    assert.equal(res.rows.find((r) => r.name === 'Sam Sample'), undefined);
  });

  it('flags attendance changed after a closed run was paid', () => {
    const att = [work(E1, '2026-10-26'), work(E1, '2026-10-27', 'approved', { updatedAt: at('2026-11-10') })];
    const closed = comparePeriod({ entries: [entry({ IsClosed: true })], employees, attendance: att });
    assert.deepEqual(closed.rows[0].flags, ['changed-after-close']);
    const open = comparePeriod({ entries: [entry({ IsClosed: false })], employees, attendance: att });
    assert.deepEqual(open.rows[0].flags, []);
  });

  it('round-trips the period key', () => {
    const key = periodKey({ TaxYear: 2026, PayPeriod: 'Weekly', Period: 30, Ordinal: 1 });
    assert.equal(key, '2026-Weekly-30-1');
    assert.deepEqual(parsePeriodKey(key), { TaxYear: 2026, PayPeriod: 'Weekly', Period: 30, Ordinal: 1 });
    assert.equal(parsePeriodKey('nope'), null);
    assert.equal(parsePeriodKey('2026-Weekly-30-1;drop'), null);
  });
});
