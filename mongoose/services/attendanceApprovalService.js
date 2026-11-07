/**
 * Two-stage week approval for attendance (permission groups phase 3b,
 * docs/PERMISSION-GROUPS.md "Two-stage week approval").
 *
 *   pending ──(Site Manager)──▶ site-approved ──(Contracts Manager)──▶ approved
 *
 * - The site step belongs to whoever runs the record's site: a Site Ops
 *   approve grant (project scope counts) on a contract that names them in
 *   `siteManagers` (projectScopeService).
 * - The final step needs Site Ops approve over all records (Contracts
 *   Manager). It can't be taken by the person who took the site step.
 * - A record whose site names no site manager (or has no site: sick, holiday,
 *   off) skips the site step: the Contracts Manager approves it from pending.
 * - Admin approves in one step from either state, for cover.
 * - Anyone who could approve the record's current step can reject it; a Site
 *   Manager can also take back a week they site-approved. Rejecting records
 *   who, when and why.
 *
 * Payroll reads only `approved` (payrollCalculationService), and holiday
 * accrual runs only on the final step.
 */
import mdb from './mongooseDatabaseService.js';
import projectScope from './projectScopeService.js';
import rbac from '../config/rolePermissionsConfig.js';
import { matchesFilter } from '../../services/dataScopingService.js';

export const AWAITING = ['pending', 'site-approved'];

const refId = (v) => (v && typeof v === 'object' && v._id ? String(v._id) : v ? String(v) : null);

/**
 * Which of `records` sit on a site that names a site manager. A record is
 * judged by its contract when it has one, else by its project.
 * @returns {Promise<{contractIds:Set<string>, projectIds:Set<string>}>}
 */
export async function managedSites(records, db = mdb) {
  const contractIds = [...new Set(records.map((r) => refId(r.contractId)).filter(Boolean))];
  const projectIds = [...new Set(records.map((r) => refId(r.projectId)).filter(Boolean))];
  const out = { contractIds: new Set(), projectIds: new Set() };
  if (!contractIds.length && !projectIds.length) return out;
  const or = [];
  if (contractIds.length) or.push({ _id: { $in: contractIds } });
  if (projectIds.length) or.push({ projectId: { $in: projectIds } });
  const contracts = await db.INTERNAL.contract
    .find({ 'siteManagers.0': { $exists: true }, status: { $ne: 'Completed' }, $or: or })
    .select('_id projectId').lean();
  for (const c of contracts) {
    out.contractIds.add(String(c._id));
    if (c.projectId) out.projectIds.add(String(c.projectId));
  }
  return out;
}

export function needsSiteStep(record, managed) {
  const c = refId(record.contractId);
  if (c) return managed.contractIds.has(c);
  const p = refId(record.projectId);
  return !!p && managed.projectIds.has(p);
}

/**
 * Who the viewer is, for these records.
 * @returns {Promise<{userId, admin, all, siteFilter, managed}>}
 */
export async function contextFor(req, records, db = mdb) {
  const user = req.user;
  const admin = user?.role === 'admin';
  const all = !admin && rbac.hasGroup(user, 'siteOps', 'approve');
  let siteFilter = null;
  if (!admin && rbac.hasGroup(user, 'siteOps', 'approve', { project: true })) {
    siteFilter = projectScope.filterFor('attendance', await projectScope.forRequest(req, db));
  }
  return {
    userId: user?._id ? String(user._id) : null,
    admin,
    all,
    siteFilter,
    // Viewers who can approve nothing (employees on /daily) skip the lookup
    managed: admin || all || siteFilter
      ? await managedSites(records, db)
      : { contractIds: new Set(), projectIds: new Set() },
  };
}

const inSites = (ctx, record) => !!ctx.siteFilter && matchesFilter(record, ctx.siteFilter);

/**
 * What approving `record` would do for this viewer.
 * @returns {{ok:true, next:'site-approved'|'approved'} | {ok:false, reason:string}}
 */
export function decideApprove(ctx, record) {
  const status = record.status || 'pending';
  if (!AWAITING.includes(status)) return { ok: false, reason: 'This record is not waiting for approval.' };
  if (ctx.admin) return { ok: true, next: 'approved' };
  if (status === 'pending') {
    const siteStep = needsSiteStep(record, ctx.managed);
    if (siteStep && inSites(ctx, record)) return { ok: true, next: 'site-approved' };
    if (ctx.all && !siteStep) return { ok: true, next: 'approved' };
    if (ctx.all) return { ok: false, reason: "Waiting for the site manager's approval." };
    return { ok: false, reason: 'This record is not on one of your sites.' };
  }
  // site-approved
  if (!ctx.all) return { ok: false, reason: 'Waiting for a contracts manager to approve.' };
  if (ctx.userId && refId(record.siteApprovedBy) === ctx.userId) {
    return { ok: false, reason: 'You approved this for the site: someone else gives the final approval.' };
  }
  return { ok: true, next: 'approved' };
}

/** Whether this viewer may reject `record`. */
export function decideReject(ctx, record) {
  const status = record.status || 'pending';
  if (!AWAITING.includes(status)) return { ok: false, reason: 'This record is not waiting for approval.' };
  if (ctx.admin || ctx.all || inSites(ctx, record)) return { ok: true };
  return { ok: false, reason: 'This record is not on one of your sites.' };
}

/** The update that moves a record to `next`, stamped with who and when. */
export function approvalUpdate(next, userId, now = new Date()) {
  if (next === 'site-approved') return { status: next, siteApprovedBy: userId, siteApprovedAt: now };
  return { status: 'approved', approvedBy: userId, approvedAt: now };
}

export function rejectionUpdate(userId, reason, now = new Date()) {
  const update = { status: 'rejected', rejectedBy: userId, rejectedAt: now };
  const text = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';
  if (text) update.rejectionReason = text;
  return update;
}

/** Per-record buttons for a page: { [uuid]: { approve, approveLabel, reject } }. */
export function actionsFor(ctx, records) {
  const out = {};
  for (const r of records) {
    const a = decideApprove(ctx, r);
    const j = decideReject(ctx, r);
    if (!a.ok && !j.ok) continue;
    out[r.uuid] = {
      approve: a.ok,
      approveLabel: a.ok && a.next === 'site-approved' ? 'Approve for the site' : 'Approve',
      reject: j.ok,
      waiting: a.ok ? null : a.reason,
    };
  }
  return out;
}

/**
 * Write side for the routes. Re-checks the status in the update itself, so
 * two approvers racing can't both move the same record.
 */
export async function approveOne(req, uuid, db = mdb) {
  const record = await db.INTERNAL.attendance.findOne({ uuid }).lean();
  if (!record) return { ok: false, reason: 'Attendance record not found.', status: 404 };
  const ctx = await contextFor(req, [record], db);
  const d = decideApprove(ctx, record);
  if (!d.ok) return { ...d, status: 403 };
  const updated = await db.INTERNAL.attendance.findOneAndUpdate(
    { _id: record._id, status: record.status || 'pending' },
    approvalUpdate(d.next, req.user._id),
    { new: true },
  );
  if (!updated) return { ok: false, reason: 'Someone else changed this record. Refresh and try again.', status: 409 };
  return { ok: true, next: d.next, record: updated };
}

export async function rejectOne(req, uuid, reason, db = mdb) {
  const record = await db.INTERNAL.attendance.findOne({ uuid }).lean();
  if (!record) return { ok: false, reason: 'Attendance record not found.', status: 404 };
  const ctx = await contextFor(req, [record], db);
  const d = decideReject(ctx, record);
  if (!d.ok) return { ...d, status: 403 };
  const updated = await db.INTERNAL.attendance.findOneAndUpdate(
    { _id: record._id, status: record.status || 'pending' },
    rejectionUpdate(req.user._id, reason),
    { new: true },
  );
  if (!updated) return { ok: false, reason: 'Someone else changed this record. Refresh and try again.', status: 409 };
  return { ok: true, record: updated };
}

/**
 * Approve what this viewer can in a date range. Returns the counts and the
 * records that reached `approved` (for holiday accrual).
 */
export async function approveRange(req, start, end, db = mdb) {
  const records = await db.INTERNAL.attendance
    .find({ date: { $gte: start, $lte: end }, status: { $in: AWAITING } }).lean();
  const ctx = await contextFor(req, records, db);
  const moves = new Map(); // `${from}>${next}` -> [_id]
  let waiting = 0;
  for (const r of records) {
    const d = decideApprove(ctx, r);
    if (!d.ok) {
      // Only count what the viewer could see but not move yet
      if (ctx.admin || ctx.all || inSites(ctx, r)) waiting++;
      continue;
    }
    const key = `${r.status || 'pending'}>${d.next}`;
    (moves.get(key) || moves.set(key, []).get(key)).push(r._id);
  }
  const counts = { 'site-approved': 0, approved: 0, waiting };
  const approvedIds = [];
  for (const [key, ids] of moves) {
    const [from, next] = key.split('>');
    const res = await db.INTERNAL.attendance.updateMany(
      { _id: { $in: ids }, status: from },
      approvalUpdate(next, req.user._id),
    );
    counts[next] += res.modifiedCount || 0;
    if (next === 'approved') approvedIds.push(...ids);
  }
  const approved = approvedIds.length
    ? await db.INTERNAL.attendance.find({ _id: { $in: approvedIds }, status: 'approved' })
    : [];
  return { counts, approved };
}

/**
 * Write scope for recording attendance. null = any record (admin,
 * accountant, Site Ops edit over all records); otherwise the viewer's site
 * sets, and a write must land on one of their contracts.
 */
export async function writeScopeFor(req, db = mdb) {
  const user = req.user;
  if (!user) return { contractIds: [], projectIds: [] };
  if (['admin', 'accountant'].includes(user.role) || rbac.hasGroup(user, 'siteOps', 'edit')) return null;
  return projectScope.forRequest(req, db);
}

export function contractInScope(scope, contractId) {
  if (scope === null) return true;
  const c = refId(contractId);
  return !!c && scope.contractIds.some((x) => String(x) === c);
}

export default {
  AWAITING, managedSites, needsSiteStep, contextFor, decideApprove, decideReject,
  approvalUpdate, rejectionUpdate, actionsFor, approveOne, rejectOne, approveRange,
  writeScopeFor, contractInScope,
};
