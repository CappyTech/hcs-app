import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import ejs from 'ejs';

import approval from '../mongoose/services/attendanceApprovalService.js';
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import ctrl from '../mongoose/controllers/attendanceController.js';
import dateService from '../services/dateService.js';

/**
 * The planned stage ahead of approval:
 *   planned (weekly sheet) → pending (person confirms, or Site Manager marks attended)
 *   → site-approved → approved
 * Nothing planned for a day still to come can be approved or confirmed.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const oid = () => new mongoose.Types.ObjectId();

const C_MANAGED = oid();
const C_OTHER = oid();
const P_MANAGED = oid();
const sets = { contractIds: [C_MANAGED], projectIds: [P_MANAGED], projectNumbers: [], quoteIds: [], locationIds: [] };
const noSites = { contractIds: [], projectIds: [], projectNumbers: [], quoteIds: [], locationIds: [] };

const EMP = oid();
const SUB = oid();
const SM = { _id: oid(), role: 'none', roles: ['siteManager'] };
const CM = { _id: oid(), role: 'none', roles: ['contractsManager'] };
const ADMIN = { _id: oid(), role: 'admin' };
const WORKER = { _id: oid(), role: 'employee', employeeId: EMP };
const SUBBIE = { _id: oid(), role: 'subcontractor', subcontractorId: SUB };

const NOW = new Date(2026, 10, 16, 12, 0, 0); // Mon 16 Nov 2026, noon local
const TODAY = new Date(2026, 10, 16);
const TOMORROW = new Date(2026, 10, 17);
const YESTERDAY = new Date(2026, 10, 15);

const reqFor = (user, scope = sets) => ({ user, _projectScope: Promise.resolve(scope) });

function contractModel(managed = [{ _id: C_MANAGED, projectId: P_MANAGED }]) {
  return { find: () => { const chain = { select: () => chain, lean: async () => managed }; return chain; } };
}
const ctxOf = (user, records, scope) => approval.contextFor(reqFor(user, scope), records, { INTERNAL: { contract: contractModel() } });

const rec = (over = {}) => ({
  _id: oid(), uuid: `u-${Math.random()}`, status: 'planned', type: 'work',
  contractId: C_MANAGED, employeeId: EMP, date: YESTERDAY, ...over,
});

describe('isDue / isOwner', () => {
  it('a day is due from its own day onwards', () => {
    assert.equal(approval.isDue({ date: YESTERDAY }, NOW), true);
    assert.equal(approval.isDue({ date: TODAY }, NOW), true);
    assert.equal(approval.isDue({ date: TOMORROW }, NOW), false);
    assert.equal(approval.isDue({}, NOW), false);
  });

  it('the owner is the linked employee or subcontractor', () => {
    assert.equal(approval.isOwner(WORKER, rec()), true);
    assert.equal(approval.isOwner(SUBBIE, rec({ employeeId: undefined, subcontractorId: SUB })), true);
    assert.equal(approval.isOwner(SUBBIE, rec()), false);
    assert.equal(approval.isOwner({ role: 'employee' }, rec()), false, 'an unlinked account owns nothing');
  });
});

describe('approving a planned day (marking it attended)', () => {
  it('Site Manager marks a planned day on their site attended: straight to site-approved', async () => {
    const r = rec();
    assert.deepEqual(approval.decideApprove(await ctxOf(SM, [r]), r, NOW), { ok: true, next: 'site-approved' });
    assert.equal(approval.approveLabelFor(r, 'site-approved'), 'Attended (approve for the site)');
  });

  it('nobody approves a planned day that has not come yet, not even admin', async () => {
    const r = rec({ date: TOMORROW });
    for (const user of [SM, CM, ADMIN]) {
      const d = approval.decideApprove(await ctxOf(user, [r], user === CM ? noSites : sets), r, NOW);
      assert.equal(d.ok, false);
      assert.match(d.reason, /hasn't come yet/);
    }
  });

  it('Contracts Manager approves a planned day directly where no site manager is named', async () => {
    const r = rec({ contractId: C_OTHER });
    assert.deepEqual(approval.decideApprove(await ctxOf(CM, [r], noSites), r, NOW), { ok: true, next: 'approved' });
  });
});

describe('not attended', () => {
  it('Site Manager may mark a due planned or pending work day on their site not attended', async () => {
    const planned = rec();
    const pending = rec({ status: 'pending' });
    const ctx = await ctxOf(SM, [planned, pending]);
    assert.equal(approval.decideNotAttended(ctx, planned, NOW).ok, true);
    assert.equal(approval.decideNotAttended(ctx, pending, NOW).ok, true);
  });

  it('not for a future day, an Off day, a signed-off day, or another site', async () => {
    const future = rec({ date: TOMORROW });
    const off = rec({ type: 'off' });
    const done = rec({ status: 'site-approved' });
    const elsewhere = rec({ contractId: oid() });
    const ctx = await ctxOf(SM, [future, off, done, elsewhere]);
    for (const r of [future, off, done, elsewhere]) assert.equal(approval.decideNotAttended(ctx, r, NOW).ok, false);
  });

  it('turns the day into Off, pending, with the site and pay cleared and a note', () => {
    const u = approval.notAttendedUpdate({ notes: 'Planned' }, SM._id, NOW);
    assert.deepEqual(u.$set.type, 'off');
    assert.deepEqual(u.$set.status, 'pending');
    assert.match(u.$set.notes, /^Planned\nNot attended/);
    for (const k of ['contractId', 'locationId', 'projectId', 'hoursWorked', 'dayRate', 'siteApprovedBy']) assert.equal(u.$unset[k], 1, k);
  });
});

describe('confirm (the person)', () => {
  it('the person confirms their own planned day once it has come', async () => {
    const ctx = { user: WORKER };
    assert.equal(approval.decideConfirm(ctx, rec(), NOW).ok, true);
    assert.equal(approval.decideConfirm(ctx, rec({ date: TODAY }), NOW).ok, true);
  });

  it('not a future day, not someone else\'s, not one already confirmed', () => {
    assert.match(approval.decideConfirm({ user: WORKER }, rec({ date: TOMORROW }), NOW).reason, /hasn't come yet/);
    assert.match(approval.decideConfirm({ user: SUBBIE }, rec(), NOW).reason, /your own/);
    assert.match(approval.decideConfirm({ user: WORKER }, rec({ status: 'pending' }), NOW).reason, /not planned/);
  });

  it('confirmOne moves planned to pending, re-checking the status in the update', async () => {
    const r = rec();
    const updates = [];
    const db = { INTERNAL: { attendance: {
      findOne: () => ({ lean: async () => r }),
      async findOneAndUpdate(filter, update) { updates.push({ filter, update }); return { ...r, ...update }; },
    } } };
    const res = await approval.confirmOne({ user: WORKER }, r.uuid, db);
    assert.equal(res.ok, true);
    assert.deepEqual(updates[0], { filter: { _id: r._id, status: 'planned' }, update: { status: 'pending' } });
    const refused = await approval.confirmOne({ user: SUBBIE }, r.uuid, db);
    assert.equal(refused.status, 403);
  });
});

describe('actionsFor with planned days', () => {
  it('the person sees Confirm on their due planned day, and nothing to approve', async () => {
    const mine = rec();
    const future = rec({ date: TOMORROW });
    const ctx = await approval.contextFor(reqFor(WORKER), [mine, future], { INTERNAL: { contract: contractModel() } });
    const actions = approval.actionsFor(ctx, [mine, future], NOW);
    assert.equal(actions[mine.uuid].confirm, true);
    assert.equal(actions[mine.uuid].approve, false);
    assert.equal(actions[mine.uuid].waiting, null);
    assert.equal(actions[future.uuid], undefined, 'no buttons before the day');
  });

  it('the Site Manager sees Attended and Not attended on a due planned day', async () => {
    const r = rec();
    const actions = approval.actionsFor(await ctxOf(SM, [r]), [r], NOW);
    assert.deepEqual(actions[r.uuid], {
      approve: true, approveLabel: 'Attended (approve for the site)', reject: true, notAttended: true, confirm: false, waiting: null,
    });
  });
});

describe('approveRange includes planned days that have come', () => {
  it('marks due planned days attended and leaves future ones (not counted as waiting)', async () => {
    const due = rec({ date: new Date(Date.now() - 864e5) });
    const future = rec({ date: new Date(Date.now() + 3 * 864e5) });
    const rows = [due, future];
    const Att = {
      find(filter) {
        const res = rows.filter((r) => (filter.status?.$in ? filter.status.$in.includes(r.status)
          : filter._id.$in.some((id) => String(id) === String(r._id)) && r.status === filter.status));
        const p = Promise.resolve(res); p.lean = async () => res; return p;
      },
      async updateMany(filter, update) {
        let n = 0;
        for (const r of rows) if (filter._id.$in.some((id) => String(id) === String(r._id)) && r.status === filter.status) { Object.assign(r, update); n++; }
        return { modifiedCount: n };
      },
    };
    const db = { INTERNAL: { attendance: Att, contract: contractModel() } };
    const { counts } = await approval.approveRange(reqFor(SM), new Date(0), new Date(Date.now() + 7 * 864e5), db);
    assert.deepEqual(counts, { 'site-approved': 1, approved: 0, waiting: 0 });
    assert.equal(due.status, 'site-approved');
    assert.equal(future.status, 'planned');
  });
});

describe('recordDay over a planned day', () => {
  let savedINTERNAL;
  afterEach(() => { mdb.INTERNAL = savedINTERNAL; });

  it('records over the plan instead of adding a second record', async () => {
    savedINTERNAL = mdb.INTERNAL;
    const plannedDoc = {
      uuid: 'p1', fields: { status: 'planned', locationId: oid() }, saved: false,
      set(k, v) { if (typeof k === 'object') Object.assign(this.fields, k); else this.fields[k] = v; },
      async save() { this.saved = true; },
    };
    let created = 0;
    function Attendance() { created++; }
    Attendance.prototype.save = async () => {};
    Attendance.find = () => ({ limit: async () => [plannedDoc] });
    mdb.INTERNAL = {
      attendance: Attendance,
      contract: { findById: (id) => ({ select: () => ({ lean: async () => ({ _id: id, projectId: P_MANAGED, status: 'In Progress' }) }) }) },
    };
    const flashes = [];
    let redirected = null;
    const req = { ...reqFor(ADMIN), params: { date: '2026-11-04' }, body: { person: `e:${EMP}`, contractId: String(C_MANAGED), type: 'work', hoursWorked: '8' }, flash: (t, m) => flashes.push([t, m]) };
    await ctrl.recordDay(req, { redirect: (to) => { redirected = to; } }, (e) => { throw e; });
    assert.equal(redirected, '/daily/2026-11-04');
    assert.match(flashes[0][1], /over the plan/);
    assert.equal(created, 0);
    assert.equal(plannedDoc.saved, true);
    assert.equal(plannedDoc.fields.status, 'pending');
    assert.equal(String(plannedDoc.fields.contractId), String(C_MANAGED));
    assert.equal(plannedDoc.fields.locationId, undefined, 'the old planned site is cleared');
    assert.equal(plannedDoc.fields.hoursWorked, 8);
  });
});

describe('daily view buttons', () => {
  const VIEW = path.join(ROOT, 'mongoose/views/tailwindcss/attendance/daily.ejs');
  const render = (locals) => ejs.renderFile(VIEW, {
    title: 'Daily', csrfToken: 't', fmtDate: dateService.fmtDate, date: '2026-11-04',
    canGroup: () => false, attendance: [], ...locals,
  }, { async: false });

  it('renders Confirm and Not attended from approvalActions, and a planned badge', async () => {
    const html = await render({
      attendance: [{ uuid: 'p1', status: 'planned', type: 'work' }, { uuid: 'p2', status: 'planned', type: 'work' }],
      approvalActions: {
        p1: { approve: false, approveLabel: 'Approve', reject: false, notAttended: false, confirm: true, waiting: null },
        p2: { approve: true, approveLabel: 'Attended (approve for the site)', reject: true, notAttended: true, confirm: false, waiting: null },
      },
    });
    assert.match(html, /action="\/attendance\/p1\/confirm"/);
    assert.doesNotMatch(html, /action="\/attendance\/p2\/confirm"/);
    assert.match(html, /action="\/attendance\/p2\/not-attended"/);
    assert.match(html, /data-confirm="Mark this day not attended\?/);
    assert.match(html, /title="Attended \(approve for the site\)"/);
    assert.match(html, />\s*planned\s*</);
  });
});
