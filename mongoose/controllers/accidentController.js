import path from 'path';
import mongoose from 'mongoose';
import mdb from '../services/mongooseDatabaseService.js';
import rbac from '../config/rolePermissionsConfig.js';
import logger from '../../services/loggerService.js';
import notificationService from '../../services/notificationService.js';
import hsCompliance from '../services/healthSafetyComplianceService.js';
import {
  ACCIDENT_CATEGORIES, ACCIDENT_TREATMENT, ACCIDENT_STATUSES,
} from '../models/mongoose/INTERNAL/accidentReport.js';

/**
 * Accident book (Health & Safety, phase 5d; docs/PERMISSION-GROUPS.md).
 *
 *  /accident-report       anyone on site reports (form)
 *  /accident-report/mine  the reports you made: date, kind, place, status
 *  /accidents             the book: admins and Health & Safety at approve
 *  /accidents/:uuid       a full entry, and its investigation
 *
 * The report pages sit outside /accidents on purpose: routeAccess matches by
 * prefix, and /accidents is approve-only.
 */

const dir = (name) => path.join('tailwindcss', 'healthSafety', name);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPORTER_ROLES = ['admin', 'accountant', 'employee', 'subcontractor'];
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Anyone who works for or on behalf of the company can report. */
export function canReport(user) {
  if (!user) return false;
  return REPORTER_ROLES.includes(user.role) || rbac.jobRolesOf(user).length > 0;
}

/** Full entries: admins and Health & Safety at approve or above (all sites). */
export function canReadBook(user) {
  return !!user && (user.role === 'admin' || rbac.hasGroup(user, 'healthSafety', 'approve'));
}

const guard = (test) => (req, res, next) => (test(req.user)
  ? next()
  : next({ statusCode: 403, name: 'ForbiddenError', message: 'You do not have permission to access this page.' }));
export const ensureReporter = guard(canReport);
export const ensureBookReader = guard(canReadBook);

/** "YYYY-MM-DDTHH:mm" from a datetime-local input, as server-local time. */
export function parseLocalDateTime(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const dt = new Date(y, mo - 1, d, h, mi);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d && dt.getHours() === h ? dt : null;
}

/** The report form → a new entry, or { error }. */
export function parseReport(body, user, contractIds = []) {
  const occurredAt = parseLocalDateTime(body.occurredAt);
  if (!occurredAt) return { error: 'Enter when it happened.' };
  if (occurredAt > new Date(Date.now() + 5 * 60 * 1000)) return { error: 'When it happened is in the future.' };
  if (!ACCIDENT_CATEGORIES.includes(body.category)) return { error: 'Choose what kind of incident it was.' };
  const description = str(body.description, 4000);
  if (!description) return { error: 'Describe what happened.' };

  const doc = {
    occurredAt, category: body.category, description,
    location: str(body.location, 200),
    injuryDetails: str(body.injuryDetails, 2000),
    bodyPart: str(body.bodyPart, 120),
    firstAid: str(body.firstAid, 1000),
    treatment: ACCIDENT_TREATMENT.includes(body.treatment) ? body.treatment : 'Not known',
    witnesses: str(body.witnesses, 1000),
    immediateAction: str(body.immediateAction, 2000),
    reportedBy: user._id,
  };
  if (body.contractId) {
    if (!mongoose.Types.ObjectId.isValid(body.contractId) || !contractIds.some((c) => String(c) === String(body.contractId))) {
      return { error: 'Choose a site from the list.' };
    }
    doc.contractId = body.contractId;
  }
  if (!doc.contractId && !doc.location) return { error: 'Say where it happened: choose the site or describe the place.' };

  // Who was hurt: the reporter, someone else (named), or nobody.
  if (body.who === 'me') {
    if (user.employeeId) doc.employeeId = user.employeeId;
    else if (user.subcontractorId) doc.subcontractorId = user.subcontractorId;
    else doc.personName = str(user.name || user.username, 120) || 'The reporter';
  } else if (body.who === 'other') {
    doc.personName = str(body.personName, 120);
    if (!doc.personName) return { error: 'Give the name of the person who was hurt.' };
  } else if (body.who !== 'nobody') {
    return { error: 'Say who was hurt, or that nobody was.' };
  }
  if (doc.category === 'Injury' && body.who === 'nobody') return { error: 'An injury needs the person who was hurt.' };
  return { doc };
}

/** The investigation form → the fields Health & Safety may change. */
export function parseInvestigation(body, user) {
  if (!ACCIDENT_STATUSES.includes(body.status)) return { error: 'Choose a status.' };
  const riddor = { yes: true, no: false }[body.riddorReportable] ?? null;
  let riddorReportedDate = null;
  if (body.riddorReportedDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.riddorReportedDate)) return { error: 'The RIDDOR date is not a valid date.' };
    const [y, m, d] = body.riddorReportedDate.split('-').map(Number);
    riddorReportedDate = new Date(y, m - 1, d);
    if (riddorReportedDate.getMonth() !== m - 1) return { error: 'The RIDDOR date is not a valid date.' };
  }
  if (riddorReportedDate && riddor !== true) return { error: 'Only a RIDDOR-reportable entry has a date reported.' };
  return {
    update: {
      status: body.status,
      riddorReportable: riddor,
      riddorReference: riddor === true ? str(body.riddorReference, 60) : '',
      riddorReportedDate,
      investigation: str(body.investigation, 4000),
      actions: str(body.actions, 4000),
      reviewedBy: user._id,
    },
  };
}

async function openContracts() {
  return mdb.INTERNAL.contract.find({ status: { $ne: 'Completed' } }).select('_id title').sort({ title: 1 }).lean();
}

async function notifyNewReport(doc) {
  // No health details by email: just that something was reported, and where to look.
  const people = await hsCompliance.healthSafetyUsers(mdb.INTERNAL.user, 'approve');
  const when = doc.occurredAt.toISOString().slice(0, 10);
  const line = `A ${doc.category.toLowerCase()} on ${when} has been added to the accident book.`;
  for (const u of people) {
    if (!u.email || !u.emailVerified) continue;
    try {
      await notificationService.enqueue({
        to: u.email,
        recipientUserId: u._id,
        subject: `Accident book: new ${doc.category.toLowerCase()} reported`,
        html: notificationService.wrapTemplate({ heading: 'Accident book', bodyLines: [line], ctaText: 'Open the entry', ctaUrl: `${notificationService.baseUrl()}/accidents/${doc.uuid}` }),
        text: line,
        category: 'health-safety',
        dedupeKey: `accident-new-${doc.uuid}:${u.email}`,
      });
    } catch (err) {
      logger.error(`[accidentController] Failed to queue new-report email: ${err.message}`);
    }
  }
}

// ── Reporting ─────────────────────────────────────────────────────────

export const getReport = async (req, res, next) => {
  try {
    res.render(dir('accidentReport'), {
      title: 'Report an accident',
      contracts: await openContracts(),
      categories: ACCIDENT_CATEGORIES,
      treatments: ACCIDENT_TREATMENT,
      now: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16),
    });
  } catch (err) {
    next(err);
  }
};

export const postReport = async (req, res, next) => {
  try {
    const contracts = req.body?.contractId ? await openContracts() : [];
    const { doc, error } = parseReport(req.body || {}, req.user, contracts.map((c) => c._id));
    if (error) {
      req.flash('error', error);
      return res.redirect('/accident-report');
    }
    const saved = await new mdb.INTERNAL.accidentReport(doc).save();
    logger.info(`[accidentController] Accident book entry ${saved.uuid} reported by ${req.user._id}`);
    await notifyNewReport(saved);
    req.flash('success', 'Thank you. Your report is in the accident book and Health & Safety have been told.');
    return res.redirect('/accident-report/mine');
  } catch (err) {
    if (err.name === 'ValidationError') {
      req.flash('error', err.message);
      return res.redirect('/accident-report');
    }
    next(err);
  }
};

export const getMine = async (req, res, next) => {
  try {
    const rows = await mdb.INTERNAL.accidentReport.find({ reportedBy: req.user._id })
      .select('occurredAt category location contractId status')
      .populate('contractId', 'title')
      .sort({ occurredAt: -1 }).limit(100).lean();
    res.render(dir('accidentMine'), { title: 'My accident reports', rows });
  } catch (err) {
    next(err);
  }
};

// ── The book ──────────────────────────────────────────────────────────

export const getBook = async (req, res, next) => {
  try {
    const q = {};
    if (ACCIDENT_STATUSES.includes(req.query.status)) q.status = req.query.status;
    if (ACCIDENT_CATEGORIES.includes(req.query.category)) q.category = req.query.category;
    if (req.query.riddor === 'due') { q.riddorReportable = true; q.riddorReportedDate = null; }
    const rows = await mdb.INTERNAL.accidentReport.find(q)
      .select('uuid occurredAt category location contractId personName employeeId subcontractorId status riddorReportable riddorReportedDate')
      .populate('contractId', 'title')
      .populate('employeeId', 'name')
      .sort({ occurredAt: -1 }).limit(500).lean();
    res.render(dir('accidentBook'), {
      title: 'Accident book', rows,
      filters: { status: q.status || '', category: q.category || '', riddor: req.query.riddor === 'due' ? 'due' : '' },
      categories: ACCIDENT_CATEGORIES, statuses: ACCIDENT_STATUSES,
    });
  } catch (err) {
    next(err);
  }
};

async function findEntry(uuid) {
  if (!UUID.test(String(uuid || ''))) return null;
  return mdb.INTERNAL.accidentReport.findOne({ uuid });
}

export const getEntry = async (req, res, next) => {
  try {
    const doc = await findEntry(req.params.uuid);
    if (!doc) return next({ statusCode: 404, name: 'NotFoundError', message: 'Accident book entry not found.' });
    await doc.populate([
      { path: 'contractId', select: 'title uuid' },
      { path: 'employeeId', select: 'name uuid' },
      { path: 'reportedBy', select: 'username' },
      { path: 'reviewedBy', select: 'username' },
    ]);
    let subName = '';
    if (doc.subcontractorId && mdb.REST?.supplier) {
      subName = (await mdb.REST.supplier.findById(doc.subcontractorId).select('Name').lean())?.Name || '';
    }
    res.render(dir('accidentEntry'), {
      title: 'Accident book entry', entry: doc.toObject(), subName,
      statuses: ACCIDENT_STATUSES,
    });
  } catch (err) {
    next(err);
  }
};

export const postEntry = async (req, res, next) => {
  try {
    const doc = await findEntry(req.params.uuid);
    if (!doc) return next({ statusCode: 404, name: 'NotFoundError', message: 'Accident book entry not found.' });
    const back = `/accidents/${doc.uuid}`;
    const { update, error } = parseInvestigation(req.body || {}, req.user);
    if (error) {
      req.flash('error', error);
      return res.redirect(back);
    }
    doc.set(update);
    await doc.save();
    req.flash('success', 'Saved.');
    return res.redirect(back);
  } catch (err) {
    if (err.name === 'ValidationError') {
      req.flash('error', err.message);
      return res.redirect('/accidents');
    }
    next(err);
  }
};

export default {
  getReport, postReport, getMine, getBook, getEntry, postEntry,
  ensureReporter, ensureBookReader, canReport, canReadBook,
  parseReport, parseInvestigation, parseLocalDateTime,
};
