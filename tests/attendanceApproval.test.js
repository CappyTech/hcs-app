import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import ejs from 'ejs';

import approval from '../mongoose/services/attendanceApprovalService.js';
import crudConfig from '../mongoose/config/CRUDControllerConfig.js';
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import ctrl from '../mongoose/controllers/attendanceController.js';
import dateService from '../services/dateService.js';

/**
 * Permission groups phase 3b: two-stage week approval.
 *   pending → site-approved (Site Manager, on their sites)
 *   site-approved → approved (Contracts Manager, not the site approver)
 *   admin approves in one step; sites with no site manager skip the site step.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const oid = () => new mongoose.Types.ObjectId();

const C_MANAGED = oid();     // a contract naming a site manager
const C_OTHER = oid();       // a contract naming nobody
const P_MANAGED = oid();
const sets = { contractIds: [C_MANAGED], projectIds: [P_MANAGED], projectNumbers: [], quoteIds: [], locationIds: [] };
const noSites = { contractIds: [], projectIds: [], projectNumbers: [], quoteIds: [], locationIds: [] };

const SM = { _id: oid(), role: 'none', roles: ['siteManager'] };
const SUP = { _id: oid(), role: 'none', roles: ['supervisor'] };
const CM = { _id: oid(), role: 'none', roles: ['contractsManager'] };
const ADMIN = { _id: oid(), role: 'admin' };

const reqFor = (user, scope = sets) => ({ user, _projectScope: Promise.resolve(scope) });

// contract.find(...).select().lean() → the managed contracts among those asked for
function contractModel(managed = [{ _id: C_MANAGED, projectId: P_MANAGED }]) {
  return {
    find(filter) {
      assert.deepEqual(filter['siteManagers.0'], { $exists: true });
      const chain = { select: () => chain, lean: async () => managed };
      return chain;
    },
  };
}

const rec = (over = {}) => ({ _id: oid(), uuid: `u-${Math.random()}`, status: 'pending', contractId: C_MANAGED, ...over });

describe('decideApprove', () => {
  const ctxOf = async (user, records, scope) => approval.contextFor(reqFor(user, scope), records, { INTERNAL: { contract: contractModel() } });

  it('Site Manager moves a pending record on their site to site-approved', async () => {
    const r = rec();
    const d = approval.decideApprove(await ctxOf(SM, [r]), r);
    assert.deepEqual(d, { ok: true, next: 'site-approved' });
  });

  it('Site Manager cannot touch another site, nor give the final approval', async () => {
    const elsewhere = rec({ contractId: oid() });
    assert.equal(approval.decideApprove(await ctxOf(SM, [elsewhere]), elsewhere).ok, false);
    const siteDone = rec({ status: 'site-approved', siteApprovedBy: oid() });
    const d = approval.decideApprove(await ctxOf(SM, [siteDone]), siteDone);
    assert.equal(d.ok, false);
    assert.match(d.reason, /contracts manager/i);
  });

  it('Contracts Manager waits for the site step where the site names a site manager', async () => {
    const r = rec();
    const d = approval.decideApprove(await ctxOf(CM, [r], noSites), r);
    assert.equal(d.ok, false);
    assert.match(d.reason, /site manager/i);
  });

  it('Contracts Manager gives the final approval after the site step', async () => {
    const r = rec({ status: 'site-approved', siteApprovedBy: SM._id });
    assert.deepEqual(approval.decideApprove(await ctxOf(CM, [r], noSites), r), { ok: true, next: 'approved' });
  });

  it('Contracts Manager approves directly where no site manager is named, or there is no site', async () => {
    const other = rec({ contractId: C_OTHER });
    const sick = rec({ contractId: undefined, type: 'sick' });
    const ctx = await ctxOf(CM, [other, sick], noSites);
    assert.deepEqual(approval.decideApprove(ctx, other), { ok: true, next: 'approved' });
    assert.deepEqual(approval.decideApprove(ctx, sick), { ok: true, next: 'approved' });
  });

  it('a project-only record is judged by its project', async () => {
    const r = rec({ contractId: undefined, projectId: P_MANAGED });
    const ctx = await ctxOf(CM, [r], noSites);
    assert.equal(approval.decideApprove(ctx, r).ok, false);
  });

  it('the site approver cannot also give the final approval', async () => {
    // A Contracts Manager who is also named as site manager on the contract
    const both = { ...CM, roles: ['contractsManager', 'siteManager'] };
    const r = rec();
    const ctx = await ctxOf(both, [r]);
    assert.deepEqual(approval.decideApprove(ctx, r), { ok: true, next: 'site-approved' });
    const after = { ...r, status: 'site-approved', siteApprovedBy: both._id };
    const d = approval.decideApprove(ctx, after);
    assert.equal(d.ok, false);
    assert.match(d.reason, /someone else/i);
  });

  it('admin approves in one step from either state', async () => {
    const ctx = await ctxOf(ADMIN, [rec()]);
    assert.deepEqual(approval.decideApprove(ctx, rec()), { ok: true, next: 'approved' });
    assert.deepEqual(approval.decideApprove(ctx, rec({ status: 'site-approved' })), { ok: true, next: 'approved' });
  });

  it('nothing moves a record that is approved or rejected', async () => {
    const ctx = await ctxOf(ADMIN, []);
    for (const status of ['approved', 'rejected']) {
      assert.equal(approval.decideApprove(ctx, rec({ status })).ok, false);
      assert.equal(approval.decideReject(ctx, rec({ status })).ok, false);
    }
  });

  it('a Supervisor (edit only) has no approval context to act with', async () => {
    const r = rec();
    const ctx = await ctxOf(SUP, [r]);
    assert.equal(ctx.siteFilter, null);
    assert.equal(approval.decideApprove(ctx, r).ok, false);
    assert.equal(approval.decideReject(ctx, r).ok, false);
  });
});

describe('decideReject and actionsFor', () => {
  it('Site Manager can reject on their sites, including a week they site-approved', async () => {
    const pending = rec();
    const siteDone = rec({ status: 'site-approved' });
    const elsewhere = rec({ contractId: oid() });
    const ctx = await approval.contextFor(reqFor(SM), [pending, siteDone, elsewhere], { INTERNAL: { contract: contractModel() } });
    assert.equal(approval.decideReject(ctx, pending).ok, true);
    assert.equal(approval.decideReject(ctx, siteDone).ok, true);
    assert.equal(approval.decideReject(ctx, elsewhere).ok, false);

    const actions = approval.actionsFor(ctx, [pending, siteDone, elsewhere]);
    assert.deepEqual(actions[pending.uuid], { approve: true, approveLabel: 'Approve for the site', reject: true, waiting: null });
    assert.equal(actions[siteDone.uuid].approve, false);
    assert.equal(actions[siteDone.uuid].reject, true);
    assert.match(actions[siteDone.uuid].waiting, /contracts manager/i);
    assert.equal(actions[elsewhere.uuid], undefined, 'no buttons off their sites');
  });

  it('stamps who and when on each step, and why on a rejection', () => {
    const at = new Date('2026-11-07T10:00:00Z');
    assert.deepEqual(approval.approvalUpdate('site-approved', SM._id, at), { status: 'site-approved', siteApprovedBy: SM._id, siteApprovedAt: at });
    assert.deepEqual(approval.approvalUpdate('approved', CM._id, at), { status: 'approved', approvedBy: CM._id, approvedAt: at });
    assert.deepEqual(approval.rejectionUpdate(CM._id, '  wrong site  ', at), { status: 'rejected', rejectedBy: CM._id, rejectedAt: at, rejectionReason: 'wrong site' });
    assert.equal('rejectionReason' in approval.rejectionUpdate(CM._id, '', at), false);
  });
});

describe('approveOne / approveRange', () => {
  function attendanceModel(rows) {
    const calls = { updates: [] };
    return {
      calls,
      findOne: ({ uuid }) => ({ lean: async () => rows.find((r) => r.uuid === uuid) || null }),
      async findOneAndUpdate(filter, update) {
        calls.updates.push({ filter, update });
        const r = rows.find((x) => String(x._id) === String(filter._id) && (x.status || 'pending') === filter.status);
        if (!r) return null;
        Object.assign(r, update);
        return r;
      },
      find(filter) {
        const res = rows.filter((r) => (filter.status?.$in ? filter.status.$in.includes(r.status)
          : filter._id?.$in ? filter._id.$in.some((id) => String(id) === String(r._id)) && r.status === filter.status : true));
        const p = Promise.resolve(res);
        p.lean = async () => res;
        return p;
      },
      async updateMany(filter, update) {
        calls.updates.push({ filter, update });
        let n = 0;
        for (const r of rows) {
          if (filter._id.$in.some((id) => String(id) === String(r._id)) && r.status === filter.status) { Object.assign(r, update); n++; }
        }
        return { modifiedCount: n };
      },
    };
  }

  it('approveOne re-checks the status in the update (no double approval)', async () => {
    const r = rec();
    const Att = attendanceModel([r]);
    const db = { INTERNAL: { attendance: Att, contract: contractModel() } };
    const first = await approval.approveOne(reqFor(SM), r.uuid, db);
    assert.equal(first.ok, true);
    assert.equal(first.next, 'site-approved');
    assert.deepEqual(Att.calls.updates[0].filter, { _id: r._id, status: 'pending' });
    assert.equal(String(r.siteApprovedBy), String(SM._id));
    // The same Site Manager trying again is now refused (waiting for the CM)
    const again = await approval.approveOne(reqFor(SM), r.uuid, db);
    assert.equal(again.ok, false);
    assert.equal(again.status, 403);
  });

  it('approveOne: 404 for an unknown record', async () => {
    const db = { INTERNAL: { attendance: attendanceModel([]), contract: contractModel() } };
    const res = await approval.approveOne(reqFor(SM), 'missing', db);
    assert.equal(res.status, 404);
  });

  it('approveRange moves each record as far as the viewer may, and counts the rest', async () => {
    const pendingManaged = rec();
    const pendingOther = rec({ contractId: C_OTHER });
    const siteDone = rec({ status: 'site-approved', siteApprovedBy: SM._id });
    const rows = [pendingManaged, pendingOther, siteDone];
    const db = { INTERNAL: { attendance: attendanceModel(rows), contract: contractModel() } };
    const { counts, approved } = await approval.approveRange(reqFor(CM, noSites), new Date(0), new Date(), db);
    assert.deepEqual(counts, { 'site-approved': 0, approved: 2, waiting: 1 });
    assert.deepEqual(approved.map((r) => r.uuid).sort(), [pendingOther.uuid, siteDone.uuid].sort());
    assert.equal(pendingManaged.status, 'pending', 'waits for the site manager');
  });

  it('approveRange for a Site Manager only site-approves their own sites', async () => {
    const mine = rec();
    const notMine = rec({ contractId: C_OTHER });
    const rows = [mine, notMine];
    const db = { INTERNAL: { attendance: attendanceModel(rows), contract: contractModel() } };
    const { counts, approved } = await approval.approveRange(reqFor(SM), new Date(0), new Date(), db);
    assert.deepEqual(counts, { 'site-approved': 1, approved: 0, waiting: 0 });
    assert.equal(approved.length, 0, 'no holiday accrual before the final step');
    assert.equal(mine.status, 'site-approved');
    assert.equal(notMine.status, 'pending');
  });
});

describe('write scope', () => {
  it('admin, accountant and Site Ops edit over all records are unrestricted', async () => {
    assert.equal(await approval.writeScopeFor(reqFor(ADMIN)), null);
    assert.equal(await approval.writeScopeFor(reqFor({ _id: oid(), role: 'accountant' })), null);
    assert.equal(await approval.writeScopeFor(reqFor(CM)), null);
  });

  it('a Supervisor writes only on contracts that name them', async () => {
    const scope = await approval.writeScopeFor(reqFor(SUP));
    assert.equal(approval.contractInScope(scope, C_MANAGED), true);
    assert.equal(approval.contractInScope(scope, String(C_MANAGED)), true);
    assert.equal(approval.contractInScope(scope, C_OTHER), false);
    assert.equal(approval.contractInScope(scope, null), false);
  });
});

describe('recordDay (POST /daily/:date/record)', () => {
  const saved = [];
  let savedINTERNAL;
  const setup = () => {
    savedINTERNAL = mdb.INTERNAL;
    saved.length = 0;
    function Attendance(data) { this.data = data; }
    Attendance.prototype.save = async function save() { saved.push(this.data); };
    mdb.INTERNAL = {
      attendance: Attendance,
      contract: { findById: (id) => ({ select: () => ({ lean: async () => ({ _id: id, projectId: P_MANAGED, status: 'In Progress' }) }) }) },
    };
  };
  afterEach(() => { mdb.INTERNAL = savedINTERNAL; });

  const call = async (user, body, date = '2026-11-04') => {
    const flashes = [];
    const req = { ...reqFor(user), params: { date }, body, flash: (t, m) => flashes.push([t, m]) };
    let redirected = null;
    const res = { redirect: (to) => { redirected = to; } };
    await ctrl.recordDay(req, res, (e) => { throw e; });
    return { flashes, redirected };
  };

  it('a Supervisor records a pending day on their site, project taken from the contract', async () => {
    setup();
    const emp = oid();
    const { flashes, redirected } = await call(SUP, { person: `e:${emp}`, contractId: String(C_MANAGED), type: 'work', hoursWorked: '8' });
    assert.equal(redirected, '/daily/2026-11-04');
    assert.equal(flashes[0][0], 'success');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].status, 'pending');
    assert.equal(String(saved[0].employeeId), String(emp));
    assert.equal(String(saved[0].projectId), String(P_MANAGED));
    assert.equal(saved[0].hoursWorked, 8);
    assert.equal('dayRate' in saved[0], false);
  });

  it('refuses a contract off their sites, and bad input', async () => {
    setup();
    const emp = oid();
    let r = await call(SUP, { person: `e:${emp}`, contractId: String(C_OTHER) });
    assert.match(r.flashes[0][1], /isn't one of your sites/);
    r = await call(SUP, { person: 'x:1', contractId: String(C_MANAGED) });
    assert.match(r.flashes[0][1], /who worked/);
    r = await call(SUP, { person: `e:${emp}`, contractId: String(C_MANAGED), hoursWorked: '30' });
    assert.match(r.flashes[0][1], /between 0 and 24/);
    r = await call(SUP, { person: `e:${emp}`, contractId: String(C_MANAGED) }, '2026-02-30');
    assert.match(r.flashes[0][1], /Invalid date/);
    assert.equal(saved.length, 0);
  });
});

describe('generic create can\'t skip the approval chain', () => {
  it('Site Ops edit (non-admin) always creates pending, without approval stamps', async () => {
    const data = { status: 'approved', approvedBy: oid(), siteApprovedBy: oid(), employeeId: oid() };
    await crudConfig.attendance.beforeCreate(data, { user: CM });
    assert.equal(data.status, 'pending');
    assert.equal('approvedBy' in data, false);
    assert.equal('siteApprovedBy' in data, false);
  });

  it('admin may still create a record in any state', async () => {
    const data = { status: 'approved' };
    await crudConfig.attendance.beforeCreate(data, { user: ADMIN });
    assert.equal(data.status, 'approved');
  });

  it('accepts site-approved as a status', () => {
    assert.equal(crudConfig.attendance.validators.status('site-approved'), true);
  });
});

describe('daily view', () => {
  const VIEW = path.join(ROOT, 'mongoose/views/tailwindcss/attendance/daily.ejs');
  const render = (locals) => ejs.renderFile(VIEW, {
    title: 'Daily', csrfToken: 't', fmtDate: dateService.fmtDate, date: '2026-11-04',
    canGroup: () => false, attendance: [], ...locals,
  }, { async: false });

  it('renders per-record buttons from approvalActions, and the waiting reason', async () => {
    const a = { uuid: 'a1', status: 'pending', type: 'work' };
    const b = { uuid: 'b1', status: 'site-approved', type: 'work' };
    const html = await render({
      attendance: [a, b],
      approvalActions: {
        a1: { approve: true, approveLabel: 'Approve for the site', reject: true, waiting: null },
        b1: { approve: false, approveLabel: 'Approve', reject: true, waiting: 'Waiting for a contracts manager to approve.' },
      },
      recordForm: { sitesOnly: true, contracts: [{ _id: 'c1', title: 'Job' }], people: [{ value: 'e:1', label: 'Person' }] },
    });
    assert.match(html, /action="\/attendance\/a1\/approve"/);
    assert.match(html, /title="Approve for the site"/);
    assert.doesNotMatch(html, /action="\/attendance\/b1\/approve"/);
    assert.match(html, /action="\/attendance\/b1\/reject"/);
    assert.match(html, /site approved/);
    assert.match(html, /Waiting for a contracts manager to approve\./);
    // Site-limited viewer: the record form, not the generic create/edit links
    assert.match(html, /action="\/daily\/2026-11-04\/record"/);
    assert.doesNotMatch(html, /\/attendance\/create\?date=/);
    assert.doesNotMatch(html, /\/attendance\/update\/a1/);
  });

  it('renders without the new locals (no buttons, no form)', async () => {
    const html = await render({ attendance: [{ uuid: 'a1', status: 'pending' }] });
    assert.doesNotMatch(html, /\/approve"/);
    assert.doesNotMatch(html, /\/record"/);
    assert.match(html, /\/attendance\/create\?date=/);
  });

  it('explains an empty form', async () => {
    const html = await render({ recordForm: { sitesOnly: true, contracts: [], people: [] } });
    assert.match(html, /No running contract names you/);
  });
});

describe('payroll reads only final approval', () => {
  it('payrollCalculationService filters status: approved', () => {
    const src = fs.readFileSync(path.join(ROOT, 'mongoose/services/payrollCalculationService.js'), 'utf8');
    assert.match(src, /status: 'approved',\s*\n\s*type: \{ \$in: \['work', 'training'\] \}/);
  });
});
