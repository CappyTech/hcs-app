// Start-up: clear attendance fields nothing uses any more.
//
//   - breakMinutes, overtimeHours, overtimeRate and payRate are gone from the
//     model (nothing let anyone enter them; payroll now pays hours × the
//     employee's hourly rate, or the day rate)
//   - a subcontractor's record holds where and when only: no hoursWorked or
//     dayRate (subcontractors are paid on their CIS invoices, not payroll)
//
// A field that's only ever empty (missing, null or 0: breakMinutes defaulted
// to 0 on every record) is $unset. A document holding a real value (non-null,
// non-zero) in any field of its group is left alone and counted in a warning,
// so nobody's figures disappear without someone looking first. Idempotent:
// once the fields are cleared, one count query finds nothing to do.
//
// Everything above "Database" is pure, for testing without a database.
import mdb from './mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';
import { REMOVED_FIELDS, SUBCONTRACTOR_PAY_FIELDS } from '../models/mongoose/INTERNAL/attendance.js';

export const CLEANUP_GROUPS = [
  { name: 'removed', label: 'removed fields', scope: {}, fields: REMOVED_FIELDS },
  { name: 'subcontractor', label: 'subcontractor hours/day rate', scope: { subcontractorId: { $ne: null } }, fields: SUBCONTRACTOR_PAY_FIELDS },
];

// Missing, null or 0. MongoDB compares numbers by value across types, so 0
// also matches a Decimal128 0 and a double 0.0.
const EMPTY = [null, 0];

/** A value worth keeping: non-null and non-zero (Decimal128 read via toString). Pure. */
export function isRealValue(v) {
  if (v == null) return false;
  const n = Number(typeof v === 'object' && typeof v.toString === 'function' ? v.toString() : v);
  return !(n === 0);
}

/** Whether a document's group fields can all be cleared (none holds a real value). Pure. */
export function isClearable(doc, fields) {
  return fields.every((f) => !isRealValue(doc?.[f]));
}

/** Documents in the group holding any of its fields with a non-null value. */
export function presentQuery(group) {
  return { ...group.scope, $or: group.fields.map((f) => ({ [f]: { $ne: null } })) };
}

/** Documents in the group whose `field` holds a real value. */
export function realQuery(group, field) {
  return { ...group.scope, [field]: { $nin: EMPTY } };
}

/** Documents in the group that hold a field to clear and no real value in any. */
export function clearableQuery(group) {
  return {
    ...group.scope,
    $or: group.fields.map((f) => ({ [f]: { $exists: true } })),
    $and: group.fields.map((f) => ({ [f]: { $in: EMPTY } })),
  };
}

/**
 * Decide what to do with a group from its counts. Pure.
 *   present — documents holding a non-null value in any of the group's fields
 *   real    — { field: documents holding a real value in it }
 * Returns { clear, kept, warning }: clear says whether to $unset the fields on
 * the documents with nothing real in them (clearableQuery / isClearable pick
 * those); kept lists the fields with real values, whose documents are left
 * alone, and warning is the message to log about them, or null.
 */
export function planGroup(group, { present = 0, real = {} } = {}) {
  const kept = Object.fromEntries(group.fields.filter((f) => (real[f] || 0) > 0).map((f) => [f, real[f]]));
  const warning = Object.keys(kept).length
    ? `[migration] attendance: kept ${group.label} with real values, left alone: ${Object.entries(kept).map(([f, n]) => `${f} on ${n} record(s)`).join(', ')}`
    : null;
  return { clear: present > 0, kept, warning };
}

// ── Database ─────────────────────────────────────────────────────────────

/**
 * Run the clean-up. Returns { [group]: { cleared, kept } }. One count per
 * group when there's nothing left to do.
 */
export async function cleanupAttendanceFields(db = mdb) {
  const Model = db.INTERNAL?.attendance;
  const out = {};
  if (!Model) return out;
  for (const group of CLEANUP_GROUPS) {
    const present = await Model.countDocuments(presentQuery(group));
    if (!present) { out[group.name] = { cleared: 0, kept: {} }; continue; }
    const real = {};
    for (const f of group.fields) real[f] = await Model.countDocuments(realQuery(group, f));
    const plan = planGroup(group, { present, real });
    if (plan.warning) logger.warn(plan.warning);
    let cleared = 0;
    if (plan.clear) {
      const unset = Object.fromEntries(group.fields.map((f) => [f, 1]));
      // strict:false — the removed fields aren't in the schema any more, and
      // Mongoose would otherwise drop them from the $unset
      const res = await Model.updateMany(clearableQuery(group), { $unset: unset }, { timestamps: false, strict: false });
      cleared = res?.modifiedCount || 0;
      if (cleared) logger.info(`[migration] attendance: cleared ${group.label} (${group.fields.join(', ')}) from ${cleared} record(s)`);
    }
    out[group.name] = { cleared, kept: plan.kept };
  }
  return out;
}

export default {
  CLEANUP_GROUPS, isRealValue, isClearable, presentQuery, realQuery, clearableQuery, planGroup, cleanupAttendanceFields,
};
