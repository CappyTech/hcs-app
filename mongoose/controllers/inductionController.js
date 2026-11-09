import path from 'path';
import mongoose from 'mongoose';
import mdb from '../services/mongooseDatabaseService.js';
import rbac from '../config/rolePermissionsConfig.js';
import projectScope from '../services/projectScopeService.js';
import logger from '../../services/loggerService.js';
import { INDUCTION_TOPICS } from '../models/mongoose/INTERNAL/induction.js';

/**
 * /inductions/record — record a site induction (Health & Safety, phase 5b).
 *
 * Site Managers and Supervisors hold Health & Safety at edit on their own
 * sites only. The generic CRUD pages can't check a record's site, so a
 * project-scoped grant gives read/list there; this page is where they write.
 * It offers only their contracts, and only people assigned to those
 * contracts around now, and checks both again on save. Admins and anyone
 * with Health & Safety on every site see every open contract.
 */

const view = path.join('tailwindcss', 'healthSafety', 'recordInduction');
const { PEOPLE_WINDOW_BACK, PEOPLE_WINDOW_AHEAD } = projectScope;
const BACK = '/inductions/record';

export function parseYMD(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return null;
  const [y, m, d] = String(s).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? dt : null;
}

/** null = every site; otherwise the viewer's project scope sets. */
export async function writeScopeFor(req, db = mdb) {
  const user = req.user;
  if (!user) return { contractIds: [] };
  if (user.role === 'admin' || rbac.hasGroup(user, 'healthSafety', 'edit')) return null;
  return projectScope.forRequest(req, db);
}

const inScope = (scope, id) => scope === null || scope.contractIds.some((c) => String(c) === String(id));

/** Contracts the viewer may record on, and the people assigned to them around now. */
export async function formOptions(scope, now = new Date(), db = mdb) {
  const contracts = await db.INTERNAL.contract
    .find(scope === null ? { status: { $ne: 'Completed' } } : { _id: { $in: scope.contractIds } })
    .select('_id title').sort({ title: 1 }).lean();
  const people = new Map();
  if (contracts.length) {
    const assignments = await db.INTERNAL.assignment
      .find({
        contractId: { $in: contracts.map((c) => c._id) },
        weekStart: { $gte: new Date(now.getTime() - PEOPLE_WINDOW_BACK), $lte: new Date(now.getTime() + PEOPLE_WINDOW_AHEAD) },
      })
      .populate('assignedEmployees', 'name')
      .populate('assignedSubcontractors', 'Name name')
      .lean();
    for (const a of assignments) {
      const add = (value, label) => {
        const p = people.get(value) || { value, label, contractIds: [] };
        if (!p.contractIds.includes(String(a.contractId))) p.contractIds.push(String(a.contractId));
        people.set(value, p);
      };
      for (const e of a.assignedEmployees || []) if (e?._id) add(`e:${e._id}`, e.name || 'Employee');
      for (const s of a.assignedSubcontractors || []) if (s?._id) add(`s:${s._id}`, s.Name || s.name || 'Subcontractor');
    }
  }
  return { contracts, people: [...people.values()].sort((a, b) => a.label.localeCompare(b.label)) };
}

/**
 * Turn the form into an induction, or return { error }. `options` are the
 * viewer's formOptions: the contract and the person must both be in them.
 */
export function parseForm(body, options, user) {
  const { person, contractId } = body;
  const [kind, personId] = String(person || '').split(':');
  if (!['e', 's'].includes(kind) || !mongoose.Types.ObjectId.isValid(personId)) return { error: 'Choose who was inducted.' };
  if (!mongoose.Types.ObjectId.isValid(contractId)) return { error: 'Choose the site.' };
  if (!options.contracts.some((c) => String(c._id) === String(contractId))) return { error: "That contract isn't one of your sites." };
  const p = options.people.find((x) => x.value === `${kind}:${personId}`);
  if (!p || !p.contractIds.includes(String(contractId))) return { error: "That person isn't assigned to this site in the last four weeks or the coming week." };

  const date = parseYMD(body.date);
  if (!date) return { error: 'Enter the date of the induction.' };
  let expiryDate = null;
  if (body.expiryDate) {
    expiryDate = parseYMD(body.expiryDate);
    if (!expiryDate) return { error: 'The re-induction date is not a valid date.' };
    if (expiryDate < date) return { error: 'The re-induction date is before the induction.' };
  }
  const picked = [].concat(body.topics || []).map(String);
  const topics = INDUCTION_TOPICS.filter((t) => picked.includes(t));
  if (!topics.length) return { error: 'Tick at least one topic covered.' };

  const doc = {
    contractId, date, expiryDate, topics,
    acknowledged: body.acknowledged === 'on' || body.acknowledged === 'true',
    inductedBy: user?._id || null,
  };
  if (kind === 'e') doc.employeeId = personId; else doc.subcontractorId = personId;
  const name = typeof body.personName === 'string' ? body.personName.trim().slice(0, 120) : '';
  if (name) {
    if (kind === 'e') return { error: 'An operative name is only for someone a subcontractor sends.' };
    doc.personName = name;
  }
  if (typeof body.notes === 'string' && body.notes.trim()) doc.notes = body.notes.trim().slice(0, 2000);
  return { doc };
}

async function recent(scope, db = mdb) {
  const q = scope === null ? {} : { contractId: { $in: scope.contractIds } };
  const rows = await db.INTERNAL.induction.find(q).sort({ date: -1 }).limit(20)
    .populate('contractId', 'title')
    .populate('employeeId', 'name')
    .lean();
  const subIds = rows.filter((r) => r.subcontractorId).map((r) => r.subcontractorId);
  const subs = new Map();
  if (subIds.length && db.REST?.supplier) {
    for (const s of await db.REST.supplier.find({ _id: { $in: subIds } }).select('Name').lean()) subs.set(String(s._id), s.Name);
  }
  return rows.map((r) => ({
    uuid: r.uuid,
    date: r.date,
    site: r.contractId?.title || '',
    who: r.employeeId?.name
      || [r.personName, subs.get(String(r.subcontractorId))].filter(Boolean).join(' — ')
      || 'Unknown',
    acknowledged: !!r.acknowledged,
    expiryDate: r.expiryDate,
  }));
}

export const getRecord = async (req, res, next) => {
  try {
    const scope = await writeScopeFor(req);
    const options = await formOptions(scope);
    res.render(view, {
      title: 'Record an induction',
      ...options,
      topics: INDUCTION_TOPICS,
      sitesOnly: scope !== null,
      recent: await recent(scope),
      today: new Date().toISOString().slice(0, 10),
    });
  } catch (err) {
    next(err);
  }
};

export const postRecord = async (req, res, next) => {
  try {
    const scope = await writeScopeFor(req);
    if (!inScope(scope, req.body.contractId)) {
      req.flash('error', "That contract isn't one of your sites.");
      return res.redirect(BACK);
    }
    const options = await formOptions(scope);
    const { doc, error } = parseForm(req.body || {}, options, req.user);
    if (error) {
      req.flash('error', error);
      return res.redirect(BACK);
    }
    await new mdb.INTERNAL.induction(doc).save();
    logger.info(`[inductionController] Induction recorded on contract ${doc.contractId} by ${req.user?._id}`);
    req.flash('success', 'Induction recorded.');
    return res.redirect(BACK);
  } catch (err) {
    if (err.name === 'ValidationError' || /induction/i.test(err.message || '')) {
      req.flash('error', err.message);
      return res.redirect(BACK);
    }
    next(err);
  }
};

export default { getRecord, postRecord, parseForm, formOptions, writeScopeFor, parseYMD };
