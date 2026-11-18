import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import ejs from 'ejs';
import mongoose from 'mongoose';

import mdb from '../mongoose/services/mongooseDatabaseService.js';
import svc from '../mongoose/services/personAttendanceService.js';
import { groups, PROJECT_SCOPE_ROUTES } from '../mongoose/config/accessGroupsConfig.js';
import rbac from '../mongoose/config/rolePermissionsConfig.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.join(__dirname, '..', 'mongoose', 'views', 'tailwindcss', 'attendance');

const admin = { user: { role: 'admin', customPermissions: {} } };
const empId = new mongoose.Types.ObjectId();
const supId = new mongoose.Types.ObjectId();

let finds = [];
let records = [];
let groupsOut = [];
function chain(result) {
  const c = { select: () => c, populate: () => c, sort: () => c, lean: () => Promise.resolve(result) };
  return c;
}
function patch() {
  finds = [];
  mdb.INTERNAL = {
    ...mdb.INTERNAL,
    employee: {
      findOne: ({ uuid }) => chain(uuid === 'e-1' ? { _id: empId, uuid: 'e-1', name: 'Jane Doe', position: 'Labourer' } : null),
      find: () => chain([{ _id: empId, uuid: 'e-1', name: 'Jane Doe' }]),
      findById: () => chain({ uuid: 'e-1' }),
    },
    attendance: {
      find: (filter) => { finds.push(filter); return chain(records); },
      aggregate: async () => groupsOut,
    },
  };
  mdb.REST = {
    ...mdb.REST,
    supplier: {
      findOne: ({ uuid }) => chain(uuid === 's-1' ? { _id: supId, uuid: 's-1', Name: 'Acme Groundworks', Code: 'ACME' } : null),
      find: () => chain([{ _id: supId, uuid: 's-1', Name: 'Acme Groundworks' }]),
      findById: () => chain({ uuid: 's-1' }),
    },
  };
}

const day = (ymd, extra = {}) => ({ uuid: `a-${ymd}`, date: new Date(`${ymd}T09:00:00Z`), type: 'work', status: 'approved', ...extra });

describe('attendance by person: the period', () => {
  const now = new Date('2026-11-18T12:00:00Z'); // a Wednesday

  it('defaults to the last 13 weeks, Monday to the end of this week', () => {
    const r = svc.rangeFrom({}, now);
    assert.equal(r.preset, '13w');
    assert.equal(r.from, '2026-08-24'); // this week and the 12 before it
    assert.equal(r.to, '2026-11-22');
  });

  it('offers 4 weeks and the tax year, which starts on 6 April', () => {
    assert.equal(svc.rangeFrom({ preset: '4w' }, now).from, '2026-10-26');
    assert.equal(svc.rangeFrom({ preset: 'tax' }, now).from, '2026-04-06');
    assert.equal(svc.rangeFrom({ preset: 'tax' }, new Date('2027-03-01T12:00:00Z')).from, '2026-04-06');
  });

  it('takes a from/to range over a preset, swapped if back to front, and ignores junk', () => {
    const r = svc.rangeFrom({ from: '2026-10-31', to: '2026-10-01', preset: '4w' }, now);
    assert.deepEqual([r.from, r.to, r.preset], ['2026-10-01', '2026-10-31', null]);
    assert.equal(svc.rangeFrom({ from: 'nope' }, now).preset, '13w');
  });
});

describe('attendance by person: one person', () => {
  beforeEach(patch);
  const range = svc.rangeFrom({ from: '2026-11-02', to: '2026-11-15' });

  it("groups an employee's days by week, newest first, with hours and approval totals", async () => {
    records = [
      day('2026-11-02', { hoursWorked: mongoose.Types.Decimal128.fromString('8'), contractId: { title: 'High Street' } }),
      day('2026-11-03', { hoursWorked: '7.5', status: 'pending' }),
      day('2026-11-04', { type: 'sick', status: 'site-approved' }),
      day('2026-11-10', { hoursWorked: '8', status: 'planned', jobRegisterId: { projectNumber: 512, site: 'Mill Lane' } }),
      day('2026-11-11', { type: 'off', status: 'rejected', rejectionReason: 'Not on site' }),
    ];
    const r = await svc.personHistory(admin, 'employee', 'e-1', range);
    assert.equal(r.person.name, 'Jane Doe');
    assert.equal(r.recordHref, '/employee/read/e-1');
    assert.deepEqual(r.weeks.map((w) => w.monday), ['2026-11-09', '2026-11-02']);
    const first = r.weeks[1];
    assert.deepEqual([first.totals.worked, first.totals.hours, first.totals.approved, first.totals.waiting], [2, 15.5, 1, 2]);
    assert.equal(first.days[0].site, 'High Street');
    assert.equal(r.weeks[0].days[0].site, '512 Mill Lane');
    assert.deepEqual(
      [r.totals.days, r.totals.worked, r.totals.approved, r.totals.waiting, r.totals.planned, r.totals.rejected],
      [5, 3, 1, 2, 1, 1],
    );
    assert.deepEqual(r.totals.byType, { work: 3, sick: 1, off: 1 });
    // The query is the person and the period
    assert.deepEqual(finds[0].employeeId, empId);
    assert.ok(finds[0].date.$gte instanceof Date && finds[0].date.$lte instanceof Date);
  });

  it('shows no hours for a subcontractor (paid on CIS invoices) and queries by supplier', async () => {
    records = [day('2026-11-02', { hoursWorked: '8' })];
    const r = await svc.personHistory(admin, 'subcontractor', 's-1', range);
    assert.equal(r.showHours, false);
    assert.equal(r.weeks[0].days[0].hours, null);
    assert.equal(r.recordHref, '/supplier/read/s-1');
    assert.deepEqual(finds[0].subcontractorId, supId);
  });

  it('says not found for an unknown person or kind', async () => {
    assert.deepEqual(await svc.personHistory(admin, 'employee', 'nobody', range), { notFound: true });
    assert.deepEqual(await svc.personHistory(admin, 'client', 'e-1', range), { notFound: true });
  });

  it('adds the viewer\'s scope to the query, so an employee only reads their own days', async () => {
    records = [];
    const employee = { user: { role: 'employee', employeeId: empId, customPermissions: {} } };
    await svc.personHistory(employee, 'employee', 'e-1', range);
    assert.ok(Array.isArray(finds[0].$and), 'person filter AND scope');
  });
});

describe('attendance by person: the picker', () => {
  beforeEach(patch);

  it('lists everyone with days in the period, by name, with approved and waiting counts', async () => {
    groupsOut = [
      { _id: { s: supId }, days: 4, waiting: 1, approved: 3, last: new Date('2026-11-12T09:00:00Z') },
      { _id: { e: empId }, days: 5, waiting: 0, approved: 5, last: new Date('2026-11-13T09:00:00Z') },
    ];
    const people = await svc.peopleInRange(admin, svc.rangeFrom({}));
    assert.deepEqual(people.map((p) => [p.name, p.kind, p.days, p.waiting]), [
      ['Acme Groundworks', 'subcontractor', 4, 1],
      ['Jane Doe', 'employee', 5, 0],
    ]);
  });

  it("sends an employee or subcontractor to their own page", async () => {
    assert.equal(await svc.ownPersonPath({ employeeId: empId }), '/attendance/person/employee/e-1');
    assert.equal(await svc.ownPersonPath({ subcontractorId: supId }), '/attendance/person/subcontractor/s-1');
    assert.equal(await svc.ownPersonPath({}), null);
  });
});

describe('attendance by person: access', () => {
  it('opens to the roles that read /daily, and to Site Ops view including site-only grants', () => {
    for (const r of ['admin', 'accountant', 'employee', 'subcontractor']) assert.ok(rbac.canAccessRoute([r], '/attendance/person', {}), r);
    assert.ok(!rbac.canAccessRoute(['hmrc'], '/attendance/person', {}));
    assert.ok(groups.siteOps.routes.view.includes('/attendance/person'));
    assert.ok(PROJECT_SCOPE_ROUTES.has('/attendance/person'));
  });
});

describe('attendance by person: pages render', () => {
  beforeEach(patch);

  it('renders a person page and the picker without errors', async () => {
    records = [day('2026-11-02', { hoursWorked: '8', notes: 'Kerbs' }), day('2026-11-03', { status: 'rejected', rejectionReason: 'Duplicate' })];
    const range = svc.rangeFrom({ preset: '4w' });
    const r = await svc.personHistory(admin, 'employee', 'e-1', range);
    const html = await ejs.renderFile(path.join(VIEWS, 'person.ejs'), {
      ...r, range, rangeQuery: '?preset=4w', basePath: '/attendance/person/employee/e-1',
      typeLabels: svc.TYPE_LABELS, statusLabels: svc.STATUS_LABELS, canPick: true,
    });
    assert.match(html, /Jane Doe/);
    assert.match(html, /Rejected: Duplicate/);
    assert.match(html, /href="\/daily\/2026-11-02"/);

    const index = await ejs.renderFile(path.join(VIEWS, 'personIndex.ejs'), {
      people: [{ kind: 'employee', uuid: 'e-1', name: 'Jane Doe', label: 'Employee', days: 2, approved: 1, waiting: 1, last: '2026-11-03' }],
      range, rangeQuery: '?preset=4w',
    });
    assert.match(index, /href="\/attendance\/person\/employee\/e-1\?preset=4w"/);
  });
});
