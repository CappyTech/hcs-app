import path from 'path';
import mongoose from 'mongoose';
import mdb from '../services/mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';
import { writeScopeFor, formOptions, parseYMD } from './inductionController.js';

/**
 * /rams/brief — record who was briefed on a RAMS (Health & Safety, phase 5c).
 *
 * Two steps on one page: pick an approved RAMS on one of your sites
 * (?rams=<uuid>), then tick the people assigned to that site who were
 * briefed. Site Managers and Supervisors see only their own sites (the same
 * scope and people window as /inductions/record); admins and Health & Safety
 * on every site see every open contract. Everything is checked again on save.
 */

const view = path.join('tailwindcss', 'healthSafety', 'ramsBrief');
const BACK = '/rams/brief';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Approved RAMS on the contracts in `options`. */
async function approvedRams(options, db = mdb) {
  if (!options.contracts.length) return [];
  return db.INTERNAL.rams
    .find({ status: 'Approved', contractId: { $in: options.contracts.map((c) => c._id) } })
    .select('uuid title reference version contractId reviewDate')
    .sort({ title: 1 })
    .lean();
}

/**
 * The briefings to save, or { error }. `rams` is the chosen approved RAMS
 * (already limited to the viewer's sites); `options` from formOptions.
 */
export function parseBrief(body, rams, options, user) {
  if (!rams) return { error: 'Choose an approved RAMS on one of your sites.' };
  const site = String(rams.contractId);
  const date = parseYMD(body.date);
  if (!date) return { error: 'Enter the date of the briefing.' };
  const picked = [...new Set([].concat(body.people || []).map(String))];
  if (!picked.length) return { error: 'Tick who was briefed.' };
  const docs = [];
  for (const value of picked) {
    const [kind, id] = value.split(':');
    const p = options.people.find((x) => x.value === value);
    if (!['e', 's'].includes(kind) || !mongoose.Types.ObjectId.isValid(id) || !p || !p.contractIds.includes(site)) {
      return { error: "Someone ticked isn't assigned to this site in the last four weeks or the coming week." };
    }
    const doc = { ramsId: rams._id, contractId: rams.contractId, ramsVersion: rams.version || 1, date, briefedBy: user?._id || null };
    if (kind === 'e') doc.employeeId = id; else doc.subcontractorId = id;
    if (typeof body.notes === 'string' && body.notes.trim()) doc.notes = body.notes.trim().slice(0, 1000);
    docs.push(doc);
  }
  return { docs };
}

async function load(req) {
  const scope = await writeScopeFor(req);
  const options = await formOptions(scope);
  const ramsList = await approvedRams(options);
  const wanted = String(req.query?.rams || req.body?.rams || '');
  const rams = UUID.test(wanted) ? ramsList.find((r) => r.uuid === wanted) || null : null;
  return { scope, options, ramsList, rams };
}

export const getBrief = async (req, res, next) => {
  try {
    const { scope, options, ramsList, rams } = await load(req);
    const site = rams ? String(rams.contractId) : null;
    let briefed = [];
    if (rams) {
      briefed = await mdb.INTERNAL.ramsBriefing.find({ ramsId: rams._id })
        .sort({ date: -1 }).limit(50)
        .populate('employeeId', 'name')
        .lean();
      const subIds = briefed.filter((b) => b.subcontractorId).map((b) => b.subcontractorId);
      if (subIds.length && mdb.REST?.supplier) {
        const names = new Map((await mdb.REST.supplier.find({ _id: { $in: subIds } }).select('Name').lean())
          .map((s) => [String(s._id), s.Name]));
        for (const b of briefed) if (b.subcontractorId) b.subName = names.get(String(b.subcontractorId));
      }
    }
    res.render(view, {
      title: 'RAMS briefing',
      contracts: options.contracts,
      ramsList,
      rams,
      people: site ? options.people.filter((p) => p.contractIds.includes(site)) : [],
      briefed,
      sitesOnly: scope !== null,
      today: new Date().toISOString().slice(0, 10),
    });
  } catch (err) {
    next(err);
  }
};

export const postBrief = async (req, res, next) => {
  try {
    const { options, rams } = await load(req);
    const back = rams ? `${BACK}?rams=${rams.uuid}` : BACK;
    const { docs, error } = parseBrief(req.body || {}, rams, options, req.user);
    if (error) {
      req.flash('error', error);
      return res.redirect(back);
    }
    await mdb.INTERNAL.ramsBriefing.insertMany(docs);
    logger.info(`[ramsController] ${docs.length} briefing(s) recorded on RAMS ${rams.uuid} by ${req.user?._id}`);
    req.flash('success', `Recorded ${docs.length} ${docs.length === 1 ? 'person' : 'people'} briefed.`);
    return res.redirect(back);
  } catch (err) {
    if (err.name === 'ValidationError') {
      req.flash('error', err.message);
      return res.redirect(BACK);
    }
    next(err);
  }
};

export default { getBrief, postBrief, parseBrief };
