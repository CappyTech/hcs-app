import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isWeekday, contractRunsInWeek, defaultDailyHours, buildWeekFlow, personKey } from '../mongoose/services/weeklyFlowService.js';

// A payroll week runs Saturday to Friday
const DAYS = ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];
const at = (day) => new Date(`${day}T00:00:00Z`);

const oid = (n) => ({ _id: `00000000000000000000000${n}`, toString() { return this._id; } });
const E1 = '0000000000000000000000e1';
const E2 = '0000000000000000000000e2';
const S1 = '0000000000000000000000a1';
const C1 = '0000000000000000000000c1';
const C2 = '0000000000000000000000c2';
const P1 = '0000000000000000000000b1';

function fixture(overrides = {}) {
  return {
    days: DAYS,
    contracts: [
      { _id: C1, uuid: 'c1', title: 'Alpha', status: 'In Progress', startDate: at('2026-04-01'), projectId: P1 },
      { _id: C2, uuid: 'c2', title: 'Beta', status: 'Planned', startDate: at('2026-10-20') },
    ],
    projectsById: new Map([[P1, { _id: P1, uuid: 'p1', Number: 1, Name: 'Job' }]]),
    assignments: [
      { _id: 'a1', uuid: 'a1', title: 'Site work', contractId: C1, assignedEmployees: [E1, E2], assignedSubcontractors: [S1] },
    ],
    attendance: [
      { uuid: 'r1', date: at('2026-10-26'), type: 'work', status: 'pending', employeeId: E1, contractId: C1 },
      { uuid: 'r2', date: at('2026-10-27'), type: 'work', status: 'approved', employeeId: E1, contractId: C1 },
    ],
    employeesById: new Map([
      [E1, { _id: E1, uuid: 'e1', name: 'Emp One', contract: { hoursPerWeek: 40, workingDaysPerWeek: 5 } }],
      [E2, { _id: E2, uuid: 'e2', name: 'Emp Two', contract: {} }],
    ]),
    suppliersById: new Map([[S1, { _id: S1, uuid: 's1', Name: 'Sub One' }]]),
    ...overrides,
  };
}

describe('weeklyFlowService helpers', () => {
  it('treats Monday to Friday as weekdays', () => {
    assert.deepEqual(DAYS.map(isWeekday), [false, false, true, true, true, true, true]);
  });

  it('runs a contract only when open and its dates overlap the week', () => {
    const c = (o) => ({ status: 'In Progress', ...o });
    assert.equal(contractRunsInWeek(c({}), DAYS[0], DAYS[6]), true);
    assert.equal(contractRunsInWeek(c({ status: 'Completed' }), DAYS[0], DAYS[6]), false);
    assert.equal(contractRunsInWeek(c({ startDate: at('2026-10-31') }), DAYS[0], DAYS[6]), false);
    assert.equal(contractRunsInWeek(c({ endDate: at('2026-10-23') }), DAYS[0], DAYS[6]), false);
    assert.equal(contractRunsInWeek(c({ startDate: at('2026-10-30'), endDate: at('2026-10-30') }), DAYS[0], DAYS[6]), true);
  });

  it('derives a day\'s hours from contract terms, or none', () => {
    assert.equal(defaultDailyHours({ contract: { hoursPerWeek: 40, workingDaysPerWeek: 5 } }), 8);
    assert.equal(defaultDailyHours({ contract: { hoursPerWeek: 37.5, workingDaysPerWeek: 5 } }), 7.5);
    assert.equal(defaultDailyHours({ contract: { hoursPerWeek: 20, workingDaysPerWeek: 3 } }), 6.75);
    assert.equal(defaultDailyHours({ contract: { hoursPerWeek: null } }), null);
    assert.equal(defaultDailyHours(undefined), null);
  });
});

describe('buildWeekFlow', () => {
  it('lists running contracts with their project and flags the unlinked one', () => {
    const flow = buildWeekFlow(fixture());
    assert.deepEqual(flow.contracts.map((r) => r.contract.title), ['Alpha', 'Beta']);
    assert.equal(flow.contracts[0].project.Name, 'Job');
    assert.equal(flow.contracts[1].project, null);
    assert.ok(flow.contracts[1].warnings.includes('No KashFlow project linked'));
    assert.ok(flow.contracts[1].warnings.includes('Still marked Planned but has started'));
    const noProject = flow.checks.find((c) => c.key === 'noProject');
    assert.deepEqual(noProject.items.map((i) => i.label), ['Beta']);
  });

  it('flags contracts with nobody assigned', () => {
    const flow = buildWeekFlow(fixture());
    assert.deepEqual(flow.checks.find((c) => c.key === 'noAssignment').items.map((i) => i.label), ['Beta']);
  });

  it('builds a day grid per assignment that never offers a recorded day', () => {
    const flow = buildWeekFlow(fixture());
    const [row] = flow.assignments;
    assert.equal(row.grid.length, 3);
    const emp1 = row.grid.find((g) => g.person.key === personKey('employee', E1));
    assert.equal(emp1.person.defaultHours, 8);
    const monday = emp1.cells.find((c) => c.day === '2026-10-26');
    assert.equal(monday.canFill, false);
    assert.equal(monday.records.length, 1);
    assert.equal(emp1.cells.find((c) => c.day === '2026-10-28').canFill, true);
  });

  it('lists assigned people with no weekday attendance', () => {
    const flow = buildWeekFlow(fixture());
    const missing = flow.checks.find((c) => c.key === 'assignedNoAttendance').items.map((i) => i.label);
    assert.deepEqual(missing.sort(), ['Emp Two', 'Sub One']);
  });

  it('flags attendance from people not on an assignment, and work with no contract', () => {
    const E3 = '0000000000000000000000e3';
    const f = fixture();
    f.employeesById.set(E3, { _id: E3, uuid: 'e3', name: 'Emp Three' });
    f.attendance.push({ uuid: 'r3', date: at('2026-10-28'), type: 'work', status: 'pending', employeeId: E3 });
    f.attendance.push({ uuid: 'r4', date: at('2026-10-29'), type: 'sick', status: 'pending', employeeId: E3 });
    const flow = buildWeekFlow(f);
    assert.deepEqual(flow.checks.find((c) => c.key === 'notAssigned').items.map((i) => i.label), ['Emp Three']);
    // Sick days need no contract; only the work day is flagged
    assert.deepEqual(flow.checks.find((c) => c.key === 'noContract').items.map((i) => i.label), ['Emp Three, 2026-10-28']);
    assert.deepEqual(flow.unassignedPeople.map((p) => p.name), ['Emp Three']);
  });

  it('counts records by status and marks steps done', () => {
    const flow = buildWeekFlow(fixture());
    assert.deepEqual(flow.counts, { pending: 1, approved: 1, rejected: 0, total: 2 });
    const done = Object.fromEntries(flow.steps.map((s) => [s.key, s.done]));
    assert.deepEqual(done, { contracts: false, assignments: false, attendance: false, review: false });
  });

  it('completes every step when the week is planned, recorded and approved', () => {
    const f = fixture({
      contracts: [{ _id: C1, uuid: 'c1', title: 'Alpha', status: 'In Progress', projectId: P1 }],
      assignments: [{ _id: 'a1', uuid: 'a1', title: 'Site work', contractId: C1, assignedEmployees: [E1], assignedSubcontractors: [] }],
      attendance: [{ uuid: 'r1', date: at('2026-10-26'), type: 'work', status: 'approved', employeeId: E1, contractId: C1 }],
    });
    const flow = buildWeekFlow(f);
    assert.deepEqual(flow.openChecks, []);
    assert.ok(flow.steps.every((s) => s.done));
  });

  it('flags assignments on contracts that are not running this week', () => {
    const f = fixture();
    f.contracts.push({ _id: oid(9)._id, uuid: 'c9', title: 'Done job', status: 'Completed' });
    f.assignments.push({ _id: 'a9', uuid: 'a9', title: 'Leftover', contractId: oid(9)._id, assignedEmployees: [], assignedSubcontractors: [] });
    const flow = buildWeekFlow(f);
    assert.deepEqual(flow.checks.find((c) => c.key === 'closedContract').items.map((i) => i.label), ['Leftover (Done job)']);
  });
});
