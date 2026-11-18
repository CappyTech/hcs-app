import { AUDIT_EXCLUDE_MODELS } from './mongooseDatabaseService.js';
import { UUID_V4 } from './dataCheckService.js';

/**
 * Bulk delete for INTERNAL list pages: tick several records, confirm, delete.
 *
 * It does exactly what the single delete does, once per record: the same
 * route guard (the model's `delete` middleware, or the RBAC matrix), then
 * Model.findOneAndDelete({ uuid }), a hard delete that the audit plugin
 * records with the deleted record's contents. The only additions are the
 * batch cap, the count check on the confirmation step and the guard that
 * stops a person deleting their own user account.
 */

/** Most records one bulk delete may remove. */
export const BULK_DELETE_MAX = 100;

const denied = (config, op) => Array.isArray(config?.deny) && config.deny.includes(op);

/**
 * Whether a model's list page offers bulk delete. It must be an INTERNAL
 * model whose single delete exists (not denied in its config), whose records
 * carry a uuid (the delete routes look records up by it), and whose deletes
 * the audit trail records. That last rule leaves out the audit log itself and
 * the collections excluded from the trail (sessions, workbook imports,
 * in-app notifications).
 */
export function canBulkDelete(namespace, modelName, Model, config = {}) {
  if (namespace !== 'INTERNAL') return false;
  if (denied(config, 'd')) return false;
  if (AUDIT_EXCLUDE_MODELS.includes(modelName)) return false;
  return !!Model?.schema?.path?.('uuid');
}

/**
 * The record uuids a form posted, as `uuids` (one value or several). Drops
 * anything that isn't a uuid and repeats. `tooMany` is set when more than
 * BULK_DELETE_MAX were ticked; nothing is deleted then.
 */
export function parseBulkUuids(body = {}) {
  const raw = body.uuids;
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const uuids = [...new Set(list.filter((u) => typeof u === 'string' && UUID_V4.test(u)))];
  return { uuids, tooMany: uuids.length > BULK_DELETE_MAX };
}

/** A short label for a record on the confirmation page. */
export function recordLabel(doc, linkField) {
  const candidates = [linkField, 'name', 'title', 'username', 'registrationNumber', 'email'];
  for (const k of candidates) {
    const v = k ? doc?.[k] : undefined;
    if (v !== undefined && v !== null && v !== '' && typeof v !== 'object') return String(v);
  }
  const first = doc?.firstName || doc?.forename;
  const last = doc?.lastName || doc?.surname;
  if (first || last) return [first, last].filter(Boolean).join(' ');
  return doc?.uuid || '';
}

/**
 * The uuids the person may not delete in this batch: their own user account.
 * Deleting it would sign them out mid-batch and lock them out.
 */
export function protectedUuids(modelName, user) {
  if (modelName === 'user' && user?.uuid) return new Set([user.uuid]);
  return new Set();
}

/**
 * Deletes each record in turn with findOneAndDelete, the call the single
 * delete makes, so the audit plugin writes one delete entry per record.
 * Returns how many were deleted and which uuids were not found.
 */
export async function deleteRecords(Model, uuids) {
  let deleted = 0;
  const missing = [];
  for (const uuid of uuids) {
    const doc = await Model.findOneAndDelete({ uuid });
    if (doc) deleted += 1;
    else missing.push(uuid);
  }
  return { deleted, missing };
}

export default {
  BULK_DELETE_MAX,
  canBulkDelete,
  parseBulkUuids,
  recordLabel,
  protectedUuids,
  deleteRecords,
};
