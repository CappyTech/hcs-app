import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crudConfig, { scopeAttendanceCreateToCaller } from '../mongoose/config/CRUDControllerConfig.js';

/**
 * The generic POST /attendance route is open to employees and
 * subcontractors. Its create handler used to save whatever the form sent,
 * so a worker could file an approved record against another worker with a
 * chosen rate. The attendance beforeCreate hook now applies the same rules
 * as the self-service submit form.
 */

const EMP = '64b000000000000000000001';
const OTHER = '64b000000000000000000002';
const SUB = '64b000000000000000000003';

const reqFor = (user) => ({ user });

const forbidden = (fn) => {
  let err;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, 'expected the hook to throw');
  assert.equal(err.statusCode, 403);
  return err;
};

describe('scopeAttendanceCreateToCaller', () => {
  it('is wired into the attendance beforeCreate hook', async () => {
    const data = { date: '2026-10-01', employeeId: OTHER, status: 'approved' };
    await assert.rejects(
      crudConfig.attendance.beforeCreate(data, reqFor({ role: 'employee', employeeId: EMP })),
      (e) => e.statusCode === 403,
    );
  });

  it('leaves an admin submission alone', () => {
    const data = { employeeId: OTHER, status: 'approved', payRate: 20 };
    scopeAttendanceCreateToCaller(data, reqFor({ role: 'admin' }));
    assert.deepEqual(data, { employeeId: OTHER, status: 'approved', payRate: 20 });
  });

  it('forces an employee record onto the caller, pending, without pay fields', () => {
    const data = {
      date: '2026-10-01',
      status: 'approved',
      hoursWorked: 8,
      payRate: 99,
      overtimeHours: 4,
      overtimeRate: 50,
      dayRate: 150,
      notes: 'n',
    };
    scopeAttendanceCreateToCaller(data, reqFor({ role: 'employee', employeeId: EMP }));
    assert.deepEqual(data, {
      date: '2026-10-01',
      status: 'pending',
      hoursWorked: 8,
      dayRate: 150,
      notes: 'n',
      employeeId: EMP,
    });
  });

  it('accepts the caller naming their own employee record', () => {
    const data = { employeeId: EMP };
    scopeAttendanceCreateToCaller(data, reqFor({ role: 'employee', employeeId: EMP }));
    assert.equal(data.employeeId, EMP);
    assert.equal(data.status, 'pending');
  });

  it('refuses an employee naming another employee', () => {
    forbidden(() => scopeAttendanceCreateToCaller({ employeeId: OTHER }, reqFor({ role: 'employee', employeeId: EMP })));
  });

  it('refuses an employee naming a subcontractor', () => {
    forbidden(() => scopeAttendanceCreateToCaller({ subcontractorId: SUB }, reqFor({ role: 'employee', employeeId: EMP })));
  });

  it('refuses a subcontractor naming an employee', () => {
    forbidden(() => scopeAttendanceCreateToCaller({ employeeId: EMP }, reqFor({ role: 'subcontractor', subcontractorId: SUB })));
  });

  it('scopes a subcontractor to their own record and drops hoursWorked', () => {
    const data = { hoursWorked: 8, dayRate: 150, status: 'approved' };
    scopeAttendanceCreateToCaller(data, reqFor({ role: 'subcontractor', subcontractorId: SUB }));
    assert.deepEqual(data, { dayRate: 150, status: 'pending', subcontractorId: SUB });
  });

  it('refuses a caller with no linked record', () => {
    forbidden(() => scopeAttendanceCreateToCaller({}, reqFor({ role: 'employee' })));
    forbidden(() => scopeAttendanceCreateToCaller({}, reqFor({ role: 'subcontractor' })));
  });

  it('refuses any other non-admin role', () => {
    forbidden(() => scopeAttendanceCreateToCaller({}, reqFor({ role: 'accountant' })));
    forbidden(() => scopeAttendanceCreateToCaller({}, reqFor(undefined)));
  });

  it('compares ObjectId-like owners by string value', () => {
    const data = { employeeId: EMP };
    scopeAttendanceCreateToCaller(data, reqFor({ role: 'employee', employeeId: { toString: () => EMP } }));
    assert.equal(String(data.employeeId), EMP);
  });
});
