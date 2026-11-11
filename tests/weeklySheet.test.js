import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import weeklySheet from '../mongoose/services/weeklySheetService.js';
import rbac from '../mongoose/config/rolePermissionsConfig.js';
import accessGroups from '../mongoose/config/accessGroupsConfig.js';
import {
  GROUPS, addDays, mondayOf, resolveWeek, cellValueOf, holidayLeft, dueState, buildSheet, changedCells,
} from '../mongoose/services/weeklySheetService.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (day) => new Date(`${day}T00:00:00Z`);

// The week on the WEEKLY ATTENDANCE sheet: Monday 27 April to Sunday 3 May 2026
const WEEK = resolveWeek('2026-04-29', '2026-04-29');
const E_OFFICE = '0000000000000000000000e1';
const E_SITE = '0000000000000000000000e2';
const E_HOL = '0000000000000000000000e3';
const SUB = '0000000000000000000000a1';
const WINDSOR = '0000000000000000000000c1';
const MAPLE = '0000000000000000000000c2';
const OFFICE = '0000000000000000000000f1';

function fixture(over = {}) {
  return {
    week: WEEK,
    employees: [
      { _id: E_OFFICE, uuid: 'e1', name: 'J Oldfield', department: 'Office', contract: { hoursPerWeek: 40, workingDaysPerWeek: 5 } },
      { _id: E_SITE, uuid: 'e2', name: 'Martin', department: 'Landscaping' },
      { _id: E_HOL, uuid: 'e3', name: 'Warren', department: 'Landscaping' },
    ],
    subcontractors: [{ _id: SUB, uuid: 's1', Name: 'Dean Colton' }],
    attendance: [
      { _id: 'r1', date: at('2026-04-27'), type: 'work', status: 'pending', employeeId: E_OFFICE, locationId: OFFICE },
      { _id: 'r2', date: at('2026-04-27'), type: 'work', status: 'approved', employeeId: E_SITE, contractId: MAPLE },
      { _id: 'r3', date: at('2026-04-28'), type: 'work', status: 'pending', employeeId: E_SITE, contractId: WINDSOR },
      { _id: 'r4', date: at('2026-04-28'), type: 'work', status: 'pending', employeeId: E_SITE, contractId: MAPLE },
      { _id: 'r5', date: at('2026-04-30'), type: 'off', status: 'pending', employeeId: E_HOL },
    ],
    contracts: [
      { _id: WINDSOR, uuid: 'c1', title: 'Windsor', status: 'In Progress', startDate: at('2026-01-01') },
      { _id: MAPLE, uuid: 'c2', title: 'Maple House', status: 'In Progress' },
    ],
    locations: [{ _id: OFFICE, uuid: 'l1', name: 'Office' }],
    leave: [{ uuid: 'h1', employeeId: E_HOL, startDate: at('2026-04-27'), endDate: at('2026-04-29'), leaveType: 'annual' }],
    closures: new Map([['2026-05-04', 'Early May bank holiday']]),
    ...over,
  };
}
const rowOf = (sheet, name) => sheet.sections.flatMap((s) => s.rows).find((r) => r.name === name);

describe('Weekly sheet weeks', () => {
  it('runs Monday to Sunday, from any day in the week', () => {
    assert.equal(mondayOf('2026-05-03'), '2026-04-27');
    assert.deepEqual(WEEK.days, ['2026-04-27', '2026-04-28', '2026-04-29', '2026-04-30', '2026-05-01', '2026-05-02', '2026-05-03']);
    assert.equal(WEEK.previous, '2026-04-20');
    assert.equal(WEEK.next, '2026-05-04');
    assert.equal(addDays('2026-03-28', 2), '2026-03-30'); // across the clock change
  });

  it('falls back to this week on a bad date', () => {
    assert.equal(resolveWeek('2026-02-30', '2026-11-11').monday, '2026-11-09');
    assert.equal(resolveWeek('nonsense', '2026-11-11').monday, '2026-11-09');
  });
});

describe('Weekly sheet cells', () => {
  it('reads a record as the choice it was made with', () => {
    assert.equal(cellValueOf({ type: 'work', contractId: WINDSOR }), `con:${WINDSOR}`);
    assert.equal(cellValueOf({ type: 'work', locationId: OFFICE }), `loc:${OFFICE}`);
    assert.equal(cellValueOf({ type: 'sick' }), 'sick');
    assert.equal(cellValueOf({ type: 'holiday' }), null);
  });

  it('groups people as on the spreadsheet', () => {
    const sheet = buildSheet(fixture());
    assert.deepEqual(sheet.sections.map((s) => s.label), ['Office', 'Landscaping', 'Sub-contract']);
    assert.deepEqual(sheet.counts, { office: 1, landscaping: 2, other: 0, sub: 1 });
    assert.deepEqual(GROUPS.map((g) => g.key), ['office', 'landscaping', 'other', 'sub']);
  });

  it('filters to one group', () => {
    const sheet = buildSheet(fixture({ group: 'sub' }));
    assert.deepEqual(sheet.sections.map((s) => s.label), ['Sub-contract']);
    assert.equal(sheet.group, 'sub');
    assert.equal(buildSheet(fixture({ group: 'bogus' })).group, '');
  });

  it('offers sites, locations, Off and Sick', () => {
    const { choices } = buildSheet(fixture());
    assert.deepEqual(choices.map((c) => c.label), ['Maple House', 'Windsor', 'Office', 'Off', 'Sick']);
  });

  it('fills cells from records, and leaves alone what it must not change', () => {
    const sheet = buildSheet(fixture());
    const office = rowOf(sheet, 'J Oldfield').cells;
    assert.equal(office[0].value, `loc:${OFFICE}`);
    assert.ok(office[0].editable);
    assert.ok(office[1].editable && office[1].value === '');

    const martin = rowOf(sheet, 'Martin').cells;
    assert.equal(martin[0].editable, false); // approved
    assert.equal(martin[0].label, 'Maple House');
    assert.equal(martin[0].tone, 'approved');
    assert.equal(martin[1].editable, false); // two records
    assert.equal(martin[1].label, '2 entries');

    const warren = rowOf(sheet, 'Warren').cells;
    assert.equal(warren[0].label, 'On holiday'); // approved holiday request
    assert.equal(warren[0].editable, false);
    assert.equal(warren[3].value, 'off');
  });

  it('locks days in a locked payroll period, except for an admin', () => {
    const locked = new Set(['2026-04-27']);
    assert.equal(rowOf(buildSheet(fixture({ lockedDays: locked })), 'J Oldfield').cells[0].editable, false);
    assert.equal(rowOf(buildSheet(fixture({ lockedDays: locked, isAdmin: true })), 'J Oldfield').cells[0].editable, true);
  });

  it('keeps a record on a closed contract as its own choice', () => {
    const contracts = [...fixture().contracts, { _id: '0000000000000000000000c9', uuid: 'c9', title: 'Old job', status: 'Completed' }];
    const attendance = [{ _id: 'r9', date: at('2026-04-29'), type: 'work', status: 'pending', subcontractorId: SUB, contractId: '0000000000000000000000c9' }];
    const cell = rowOf(buildSheet(fixture({ contracts, attendance })), 'Dean Colton').cells[2];
    assert.ok(cell.editable);
    assert.deepEqual(cell.extra, { value: 'con:0000000000000000000000c9', label: 'Old job', group: 'Current' });
  });
});

describe('Weekly sheet saving', () => {
  it('picks out only the cells that changed, for this week', () => {
    const key = `e:${E_OFFICE}`;
    const changes = changedCells({
      cell: { [key]: { '2026-04-27': `loc:${OFFICE}`, '2026-04-28': `con:${WINDSOR}`, '2026-06-01': 'off' }, 'x:bad': { '2026-04-27': 'off' } },
      was: { [key]: { '2026-04-27': `loc:${OFFICE}`, '2026-04-28': '' } },
    }, WEEK.days);
    assert.deepEqual(changes, [{ key, day: '2026-04-28', value: `con:${WINDSOR}`, before: '' }]);
  });
});

describe('Weekly sheet side panels', () => {
  it('holiday left counts carry-over and what has been taken', () => {
    assert.equal(holidayLeft({ entitlementType: 'days', entitlementDays: 28, carryOverDays: 2, takenDays: 17 }), 13);
    assert.equal(holidayLeft({ entitlementType: 'days', accrualMethod: 'per-day', accruedDays: 6.5, takenDays: 0 }), 6.5);
    assert.equal(holidayLeft({ entitlementType: 'hours', entitlementHours: 100 }), null);
  });

  it('flags vehicle dates past due or within 30 days', () => {
    assert.equal(dueState(at('2026-06-30'), '2026-11-11'), 'overdue');
    assert.equal(dueState(at('2026-12-01'), '2026-11-11'), 'soon');
    assert.equal(dueState(at('2027-03-16'), '2026-11-11'), 'ok');
    assert.equal(dueState(null, '2026-11-11'), null);
  });
});

describe('Weekly sheet access', () => {
  it('opens for the same people as the weekly flow', () => {
    assert.deepEqual(rbac.routeAccess['/weekly-sheet'], rbac.routeAccess['/weekly-flow']);
    assert.ok(accessGroups.groups.siteOps.routes.edit.includes('/weekly-sheet'));
    assert.ok(accessGroups.groups.payroll.routes.view.includes('/weekly-sheet'));
  });
});

describe('Weekly sheet page', () => {
  it('draws one row per person and a select per open cell', async () => {
    const sheet = buildSheet(fixture());
    const html = await ejs.renderFile(path.join(root, 'mongoose/views/tailwindcss/attendance/weekly-sheet.ejs'), {
      title: 't', csrfToken: 'c', crumbs: [], week: WEEK, sheet, closures: new Map([['2026-04-29', 'Company day']]),
      running: sheet.running.map((c) => ({ ...c, project: c.title === 'Windsor' ? { Number: 41250 } : null })),
      jobs: [{ uuid: 'j1', projectNumber: 41299, site: '7 Jasmine Gardens', client: 'Plus Dane', description: 'Gravel' }],
      vehicles: [{ uuid: 'v1', registrationNumber: 'RX 16 MTE', bodyType: 'Wagon', roadTaxExpiryDate: at('2026-06-01'), motExpiryDate: at('2026-06-30'), due: { tax: 'overdue', mot: 'overdue', insurance: null, breakdown: null } }],
      group: '', groups: GROUPS, addSubcontractor: null, subcontractorChoices: [{ _id: 'x', Name: 'Bob Phenna' }],
      dayLabels: ['Mon 27/4', 'Tue 28/4', 'Wed 29/4', 'Thu 30/4', 'Fri 1/5', 'Sat 2/5', 'Sun 3/5'],
    });
    assert.match(html, /J Oldfield/);
    assert.match(html, new RegExp(`name="cell\\[e:${E_OFFICE}\\]\\[2026-04-28\\]"`));
    assert.match(html, new RegExp(`name="was\\[e:${E_OFFICE}\\]\\[2026-04-27\\]" value="loc:${OFFICE}"`));
    assert.match(html, /2 entries/);
    assert.match(html, /On holiday/);
    assert.match(html, /Company day/);
    assert.match(html, /41299/);
    assert.match(html, /RX 16 MTE/);
    assert.match(html, /Bob Phenna/);
    assert.match(html, /action="\/weekly-sheet\/2026-04-27"/);
    assert.match(html, /name="_csrf"/);
    assert.doesNotMatch(html, /<script/);
  });
});

// ── Saving through the service, with the database replaced by fakes ──

const query = (rows) => {
  const q = { select: () => q, sort: () => q, lean: () => q, populate: () => q, then: (ok, bad) => Promise.resolve(rows).then(ok, bad) };
  return q;
};
const model = (rows, extra = {}) => ({ find: () => query(rows()), findOne: () => query(null), distinct: async () => [], ...extra });

describe('Weekly sheet save', () => {
  let saved; let store; let savedINTERNAL; let savedREST;
  const office = { _id: E_OFFICE, uuid: 'e1', name: 'J Oldfield', department: 'Office', status: 'active', contract: { hoursPerWeek: 40, workingDaysPerWeek: 5 } };

  class FakeAttendance {
    constructor(fields) { Object.assign(this, fields); }
    set(k, v) { if (v === undefined) delete this[k]; else this[k] = v; }
    async save() { if (!this._id) { this._id = `new${store.length}`; store.push(this); } saved.push({ ...this }); }
    async deleteOne() { store = store.filter((r) => r !== this); saved.push({ deleted: this._id }); }
  }
  FakeAttendance.find = () => query(store);
  FakeAttendance.findById = async (rid) => store.find((r) => r._id === rid) || null;
  FakeAttendance.distinct = async () => [];

  before(() => {
    savedINTERNAL = mdb.INTERNAL; savedREST = mdb.REST;
    mdb.INTERNAL = {
      employee: model(() => [office]),
      attendance: FakeAttendance,
      contract: model(() => fixture().contracts),
      location: model(() => fixture().locations),
      holidayRequest: model(() => []),
      holiday: model(() => []),
      holidayCustom: model(() => []),
      payrollRun: model(() => []),
      vehicle: model(() => []),
      jobRegister: model(() => []),
      employeeHoliday: model(() => []),
    };
    mdb.REST = { supplier: model(() => []), project: model(() => []) };
  });
  after(() => { mdb.INTERNAL = savedINTERNAL; mdb.REST = savedREST; });

  it('creates, changes and clears days, and skips a cell changed since the form was drawn', async () => {
    saved = [];
    const existing = new FakeAttendance({ _id: 'r1', date: at('2026-04-27'), type: 'work', status: 'pending', employeeId: E_OFFICE, locationId: OFFICE });
    const offDay = new FakeAttendance({ _id: 'r2', date: at('2026-04-29'), type: 'off', status: 'pending', employeeId: E_OFFICE });
    store = [existing, offDay];
    const key = `e:${E_OFFICE}`;
    const result = await weeklySheet.saveSheet('2026-04-27', {
      cell: { [key]: { '2026-04-27': `con:${WINDSOR}`, '2026-04-28': 'sick', '2026-04-29': '', '2026-04-30': 'off' } },
      // 30 April is blank, but this form was drawn showing Sick: someone else changed it, so skip
      was: { [key]: { '2026-04-27': `loc:${OFFICE}`, '2026-04-28': '', '2026-04-29': 'off', '2026-04-30': 'sick' } },
    });
    assert.deepEqual(result, { saved: 3, skipped: 1 });
    assert.equal(existing.type, 'work');
    assert.equal(existing.contractId, WINDSOR);
    assert.equal(existing.locationId, undefined);
    assert.equal(existing.hoursWorked, 8); // 40 hours over 5 days
    const sick = store.find((r) => r.type === 'sick');
    assert.equal(sick.status, 'pending');
    assert.equal(sick.employeeId, E_OFFICE);
    assert.ok(!store.includes(offDay));
  });

  it('refuses a choice that was not on offer', async () => {
    saved = []; store = [];
    const key = `e:${E_OFFICE}`;
    const result = await weeklySheet.saveSheet('2026-04-27', {
      cell: { [key]: { '2026-04-28': 'con:0000000000000000000000ff' } }, was: { [key]: { '2026-04-28': '' } },
    });
    assert.deepEqual(result, { saved: 0, skipped: 1 });
    assert.equal(store.length, 0);
  });
});
