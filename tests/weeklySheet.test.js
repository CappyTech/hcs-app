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
import jobRegisterService, { jobLabel, isOpenJob, jobTarget } from '../mongoose/services/jobRegisterService.js';
import attendanceModel from '../mongoose/models/mongoose/INTERNAL/attendance.js';
import mongoose from 'mongoose';
import fs from 'node:fs';
import dateService from '../services/dateService.js';
import { groupAttendanceByPerson } from '../mongoose/services/attendanceService.js';
import { notAttendedUpdate } from '../mongoose/services/attendanceApprovalService.js';

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
const JASMINE = '0000000000000000000000b1'; // a job on the Windsor contract
const OAK = '0000000000000000000000b2'; // a job with no contract, description or contact
const P_JASMINE = '0000000000000000000000d1'; // the synced KashFlow project 41299
const JOBS = [
  { _id: JASMINE, uuid: 'j1', projectNumber: 41299, site: '7 Jasmine Gardens, Liverpool', client: 'Plus Dane', contact: 'Ann', description: 'Gravel', contractId: WINDSOR },
  { _id: OAK, uuid: 'j2', projectNumber: 41300, site: 'Oak Court', client: 'Example Homes', contact: '', description: '' },
];

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
    jobs: JOBS,
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
    // A job-linked day carries the job's contract too: the job is the choice
    assert.equal(cellValueOf({ type: 'work', jobRegisterId: JASMINE, contractId: WINDSOR }), `job:${JASMINE}`);
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

  it('offers jobs, locations, Off and Sick, and no contracts', () => {
    const { choices } = buildSheet(fixture());
    assert.deepEqual(choices.map((c) => c.label), [
      '41300 Oak Court (Example Homes)',
      '41299 7 Jasmine Gardens, Liverpool (Gravel, Plus Dane, Ann)',
      'Office', 'Off', 'Sick',
    ]);
    assert.deepEqual(choices.map((c) => c.group), ['Jobs', 'Jobs', 'Locations', 'Other', 'Other']);
    assert.deepEqual(choices.slice(0, 2).map((c) => c.value), [`job:${OAK}`, `job:${JASMINE}`]);
    assert.ok(!choices.some((c) => c.value.startsWith('con:')));
    // For HTML: the number and site, then the small bracket part
    assert.deepEqual([choices[1].main, choices[1].detail], ['41299 7 Jasmine Gardens, Liverpool', 'Gravel, Plus Dane, Ann']);
  });

  it('labels a job with its empty parts left out', () => {
    assert.deepEqual(jobLabel({ projectNumber: 41300, site: 'Oak Court', client: 'Example Homes', description: '', contact: null }),
      { main: '41300 Oak Court', detail: 'Example Homes', text: '41300 Oak Court (Example Homes)' });
    assert.deepEqual(jobLabel({ projectNumber: 41301, site: 'Elm Road', client: '', description: '  ', contact: '' }),
      { main: '41301 Elm Road', detail: '', text: '41301 Elm Road' });
    assert.equal(jobLabel({ projectNumber: 41302, site: 'Ash Way', client: 'Acme', description: 'Fencing', contact: 'Bo' }).text, '41302 Ash Way (Fencing, Acme, Bo)');
  });

  it('shows a day on a job as that job, and one on a closed job as its own choice', () => {
    const attendance = [
      { _id: 'j1', date: at('2026-04-28'), type: 'work', status: 'planned', employeeId: E_OFFICE, jobRegisterId: OAK },
      { _id: 'j2', date: at('2026-04-29'), type: 'work', status: 'planned', employeeId: E_OFFICE, jobRegisterId: '0000000000000000000000b9', contractId: MAPLE },
    ];
    const otherJobs = [{ _id: '0000000000000000000000b9', projectNumber: 41001, site: 'Done Job', client: 'Old Client', completed: true }];
    const cells = rowOf(buildSheet(fixture({ attendance, otherJobs })), 'J Oldfield').cells;
    assert.equal(cells[1].value, `job:${OAK}`);
    assert.equal(cells[1].extra, null);
    assert.equal(cells[1].label, '41300 Oak Court (Example Homes)');
    assert.deepEqual(cells[2].extra, { value: 'job:0000000000000000000000b9', label: '41001 Done Job (Old Client)', group: 'Current' });
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

  it('keeps a record on a contract, even an open one, as its own choice', () => {
    const attendance = [{ _id: 'r8', date: at('2026-04-29'), type: 'work', status: 'pending', subcontractorId: SUB, contractId: WINDSOR }];
    const cell = rowOf(buildSheet(fixture({ attendance })), 'Dean Colton').cells[2];
    assert.ok(cell.editable);
    assert.equal(cell.value, `con:${WINDSOR}`);
    assert.deepEqual(cell.extra, { value: `con:${WINDSOR}`, label: 'Windsor', group: 'Current' });
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
      jobs: [{ uuid: 'j9', projectNumber: 41310, site: 'Birch Close', client: 'Plus Dane', description: 'Gravel', contact: '' }],
      vehicles: [{ uuid: 'v1', registrationNumber: 'RX 16 MTE', bodyType: 'Wagon', roadTaxExpiryDate: at('2026-06-01'), motExpiryDate: at('2026-06-30'), due: { tax: 'overdue', mot: 'overdue', insurance: null, breakdown: null } }],
      group: '', groups: GROUPS, addChoices: { employees: [], subcontractors: [{ value: 's:x', label: 'Bob Phenna' }] },
      dayLabels: ['Mon 27/4', 'Tue 28/4', 'Wed 29/4', 'Thu 30/4', 'Fri 1/5', 'Sat 2/5', 'Sun 3/5'],
    });
    assert.match(html, /J Oldfield/);
    assert.match(html, new RegExp(`name="cell\\[e:${E_OFFICE}\\]\\[2026-04-28\\]"`));
    assert.match(html, new RegExp(`name="was\\[e:${E_OFFICE}\\]\\[2026-04-27\\]" value="loc:${OFFICE}"`));
    assert.match(html, /2 entries/);
    assert.match(html, /On holiday/);
    assert.match(html, /Company day/);
    // Jobs for allocation: number, site, then the bracket part small (empty contact left out)
    assert.match(html, /41310<\/a>\s*<span[^>]*>Birch Close<\/span>\s*<small[^>]*>\(Gravel, Plus Dane\)<\/small>/);
    // Cell choices: jobs (plain text in an option), then locations, no contracts
    assert.match(html, /<optgroup label="Jobs">/);
    assert.match(html, new RegExp(`<option value="job:${JASMINE}" >41299 7 Jasmine Gardens, Liverpool \\(Gravel, Plus Dane, Ann\\)</option>`));
    assert.doesNotMatch(html, /<optgroup label="Sites">/);
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
      jobRegister: model(() => JOBS),
      employeeHoliday: model(() => []),
    };
    mdb.REST = { supplier: model(() => [{ _id: SUB, uuid: 's1', Name: 'Dean Colton' }]), project: model(() => [{ _id: P_JASMINE, Number: 41299 }]) };
  });
  after(() => { mdb.INTERNAL = savedINTERNAL; mdb.REST = savedREST; });

  it('creates, changes and clears days, and skips a cell changed since the form was drawn', async () => {
    saved = [];
    const existing = new FakeAttendance({ _id: 'r1', date: at('2026-04-27'), type: 'work', status: 'pending', employeeId: E_OFFICE, locationId: OFFICE });
    const offDay = new FakeAttendance({ _id: 'r2', date: at('2026-04-29'), type: 'off', status: 'pending', employeeId: E_OFFICE });
    store = [existing, offDay];
    const key = `e:${E_OFFICE}`;
    const result = await weeklySheet.saveSheet('2026-04-27', {
      cell: { [key]: { '2026-04-27': `job:${JASMINE}`, '2026-04-28': 'sick', '2026-04-29': '', '2026-04-30': 'off' } },
      // 30 April is blank, but this form was drawn showing Sick: someone else changed it, so skip
      was: { [key]: { '2026-04-27': `loc:${OFFICE}`, '2026-04-28': '', '2026-04-29': 'off', '2026-04-30': 'sick' } },
    });
    assert.deepEqual(result, { saved: 3, skipped: 1 });
    assert.equal(existing.type, 'work');
    // The job, with its contract and the synced project with its number
    assert.equal(existing.jobRegisterId, JASMINE);
    assert.equal(existing.contractId, WINDSOR);
    assert.equal(existing.projectId, P_JASMINE);
    assert.equal(existing.locationId, undefined);
    assert.equal(existing.hoursWorked, 8); // 40 hours over 5 days
    assert.equal(existing.status, 'pending', 'a confirmed day stays confirmed');
    const sick = store.find((r) => r.type === 'sick');
    assert.equal(sick.status, 'planned', 'a new day is planned');
    assert.equal(sick.employeeId, E_OFFICE);
    assert.ok(!store.includes(offDay));
  });

  it('moves a subcontractor without giving their day hours or a day rate, and clears any left', async () => {
    saved = [];
    const subDay = new FakeAttendance({ _id: 'r9', date: at('2026-04-27'), type: 'work', status: 'planned', subcontractorId: SUB, contractId: MAPLE, hoursWorked: 8, dayRate: 150 });
    store = [subDay];
    const key = `s:${SUB}`;
    const result = await weeklySheet.saveSheet('2026-04-27', {
      cell: { [key]: { '2026-04-27': `job:${OAK}` } },
      was: { [key]: { '2026-04-27': `con:${MAPLE}` } },
    });
    assert.deepEqual(result, { saved: 1, skipped: 0 });
    // A job with no contract and no synced project: just the job
    assert.equal(subDay.jobRegisterId, OAK);
    assert.equal('contractId' in subDay, false);
    assert.equal('projectId' in subDay, false);
    assert.equal('hoursWorked' in subDay, false);
    assert.equal('dayRate' in subDay, false);
  });

  it('leaves a day on a contract as it is when the rest of the week is saved', async () => {
    saved = [];
    const onContract = new FakeAttendance({ _id: 'r7', date: at('2026-04-27'), type: 'work', status: 'pending', employeeId: E_OFFICE, contractId: MAPLE, projectId: 'p7', hoursWorked: 8 });
    store = [onContract];
    const key = `e:${E_OFFICE}`;
    const result = await weeklySheet.saveSheet('2026-04-27', {
      cell: { [key]: { '2026-04-27': `con:${MAPLE}`, '2026-04-28': `loc:${OFFICE}` } },
      was: { [key]: { '2026-04-27': `con:${MAPLE}`, '2026-04-28': '' } },
    });
    assert.deepEqual(result, { saved: 1, skipped: 0 });
    assert.equal(saved.some((s) => s._id === 'r7'), false, 'the contract day was not saved again');
    assert.equal(onContract.contractId, MAPLE);
    assert.equal(onContract.projectId, 'p7');
    assert.equal(onContract.jobRegisterId, undefined);
    assert.equal(store.find((r) => r._id !== 'r7').locationId, OFFICE);
  });

  it('refuses a choice that was not on offer', async () => {
    saved = []; store = [];
    const key = `e:${E_OFFICE}`;
    const result = await weeklySheet.saveSheet('2026-04-27', {
      cell: { [key]: { '2026-04-28': 'con:0000000000000000000000ff', '2026-04-29': `con:${WINDSOR}`, '2026-04-30': 'job:0000000000000000000000bf' } },
      was: { [key]: { '2026-04-28': '', '2026-04-29': '', '2026-04-30': '' } },
    });
    // Contracts aren't offered any more, even open ones; nor is a job that isn't open
    assert.deepEqual(result, { saved: 0, skipped: 3 });
    assert.equal(store.length, 0);
  });
});

describe('Won jobs not yet completed', () => {
  it('are those with a project number, not cancelled, completed or invoiced', () => {
    assert.equal(isOpenJob({ projectNumber: 41000 }), true);
    assert.equal(isOpenJob({ projectNumber: 41000, won: true, contractId: 'c' }), true);
    assert.equal(isOpenJob({ quoteNumber: 51000, won: true }), false); // won, no project number yet
    assert.equal(isOpenJob({ projectNumber: 41000, cancelled: true }), false);
    assert.equal(isOpenJob({ projectNumber: 41000, completed: true }), false);
    assert.equal(isOpenJob({ projectNumber: 41000, invoiceNumber: 1001 }), false);
    assert.deepEqual(jobRegisterService.OPEN_JOB_FILTER, {
      projectNumber: { $type: 'number' }, cancelled: { $ne: true }, completed: { $ne: true }, invoiceNumber: { $not: { $type: 'number' } },
    });
  });

  it('link an attendance day to the job, its contract and its project', () => {
    assert.deepEqual(jobTarget(JOBS[0], { projectId: P_JASMINE }), { jobRegisterId: JASMINE, contractId: WINDSOR, projectId: P_JASMINE });
    assert.deepEqual(jobTarget(JOBS[0], { contract: { projectId: 'pc' } }), { jobRegisterId: JASMINE, contractId: WINDSOR, projectId: 'pc' });
    assert.deepEqual(jobTarget(JOBS[1]), { jobRegisterId: OAK });
  });

  describe('for allocation', () => {
    let savedINTERNAL; let filters;
    before(() => {
      savedINTERNAL = mdb.INTERNAL;
      filters = {};
      mdb.INTERNAL = {
        jobRegister: { find: (f) => { filters.job = f; return query(JOBS.filter((j) => !j.contractId)); } },
        attendance: { distinct: async (field, f) => { filters.attendance = { field, f }; return [OAK]; } },
      };
    });
    after(() => { mdb.INTERNAL = savedINTERNAL; });

    it('are open jobs with no contract and no attendance booked on them', async () => {
      assert.deepEqual(await jobRegisterService.jobsForAllocation(), []);
      assert.deepEqual(filters.job, { ...jobRegisterService.OPEN_JOB_FILTER, contractId: { $in: [null] } });
      assert.equal(filters.attendance.field, 'jobRegisterId');
      mdb.INTERNAL.attendance.distinct = async () => [];
      assert.deepEqual((await jobRegisterService.jobsForAllocation()).map((j) => j.projectNumber), [41300]);
    });
  });
});

describe('Other pages showing a day on a job', () => {
  const job = { _id: JASMINE, uuid: 'j1', projectNumber: 41299, site: '7 Jasmine Gardens, Liverpool', client: 'Plus Dane' };

  it('the daily page shows the job number and site', async () => {
    const html = await ejs.renderFile(path.join(root, 'mongoose/views/tailwindcss/attendance/daily.ejs'), {
      title: 'Daily', csrfToken: 't', fmtDate: dateService.fmtDate, date: '2026-04-27', canGroup: () => false,
      attendance: [{ uuid: 'a1', status: 'planned', type: 'work', jobRegisterId: job }],
    }, { async: false });
    assert.match(html, /<span class="font-mono text-xs">41299<\/span> 7 Jasmine Gardens, Liverpool/);
  });

  it('the weekly attendance table gives the day the job number and site', () => {
    const { groupedAttendance } = groupAttendanceByPerson(
      [{ _id: 'a1', uuid: 'a1', date: at('2026-04-28'), type: 'work', status: 'pending', hoursWorked: 8, employeeId: { _id: E_SITE, uuid: 'e2', name: 'Martin' }, jobRegisterId: job }],
      at('2026-04-25'), at('2026-05-01'), [{ _id: E_SITE, uuid: 'e2', name: 'Martin' }], [],
    );
    const day = Object.values(groupedAttendance.Martin.dailyRecords['2026-04-28'])[0];
    assert.deepEqual(day.job, { uuid: 'j1', label: '41299 7 Jasmine Gardens, Liverpool' });
  });

  it('the weekly flow does not flag a job day as work without a contract', () => {
    const src = fs.readFileSync(path.join(root, 'mongoose/services/weeklyFlowService.js'), 'utf8');
    assert.match(src, /!rec\.contractId && !rec\.jobRegisterId/);
  });

  it('marking a day not attended clears its job too', () => {
    assert.equal(notAttendedUpdate({ notes: '' }, 'u').$unset.jobRegisterId, 1);
  });
});

describe('Attendance on a job', () => {
  const Attendance = mongoose.models.attendanceJobTest || mongoose.model('attendanceJobTest', attendanceModel.schema);
  const oid = () => new mongoose.Types.ObjectId();

  it('is valid work with only a job', async () => {
    await new Attendance({ date: new Date(), type: 'work', employeeId: oid(), jobRegisterId: oid() }).validate();
  });

  it('still needs somewhere: a location, project, contract or job', async () => {
    await assert.rejects(new Attendance({ date: new Date(), type: 'work', employeeId: oid() }).validate(), /location, project, contract or job/);
  });

  it('is indexed by job and date', () => {
    assert.ok(attendanceModel.schema.indexes().some(([keys]) => JSON.stringify(keys) === JSON.stringify({ jobRegisterId: 1, date: 1 })));
  });
});
