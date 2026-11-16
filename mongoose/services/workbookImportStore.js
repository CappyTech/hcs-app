// The parked workbook uploads (workbookImport) shared by both imports:
// listing them, saving one for later, deleting one, marking one imported,
// and the start-up step that moved expiry from createdAt to expiresAt.
import mdb from './mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';
import { UPLOAD_LIFETIME_MS } from '../models/mongoose/INTERNAL/workbookImport.js';

const RECENT_LIMIT = 30;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const notFound = () => Object.assign(new Error('That upload has expired or been deleted. Upload the workbook again.'), { status: 404 });

/** One upload as the list shows it. Pure. */
export function describeUpload(doc, kind) {
  const r = doc.result || {};
  let summary = '';
  if (doc.importedAt) {
    summary = kind === 'jobRegister'
      ? `${plural(r.created || 0, 'row')} added, ${plural(r.updated || 0, 'row')} filled in`
      : `${plural(r.created || 0, 'day')} imported${r.createdLocations ? `, ${plural(r.createdLocations, 'new location')}` : ''}${Number(r.failed) ? `, ${plural(Number(r.failed), 'day')} not saved` : ''}`;
  }
  return {
    uuid: doc.uuid,
    fileName: doc.fileName || '(no name)',
    createdAt: doc.createdAt,
    expiresAt: doc.expiresAt || null,
    by: doc.createdBy?.username || doc.createdBy?.email || '',
    saved: !!doc.saved && !doc.importedAt,
    savedAt: doc.savedAt || null,
    importedAt: doc.importedAt || null,
    failed: Number(r.failed) || 0,
    summary,
  };
}

/**
 * Saved uploads of one kind, and any others that haven't expired yet, newest
 * first. Filtered on expiresAt as well as left to the TTL index, which only
 * sweeps about once a minute.
 */
export async function recentUploads(kind, now = new Date()) {
  const docs = await mdb.INTERNAL.workbookImport
    .find({ kind, $or: [{ saved: true, importedAt: null }, { expiresAt: { $gt: now } }] })
    .select('uuid fileName createdAt expiresAt saved savedAt importedAt result createdBy')
    .populate('createdBy', 'username email')
    .sort({ createdAt: -1 })
    .limit(RECENT_LIMIT)
    .lean();
  return docs.map((d) => describeUpload(d, kind));
}

/** A parked upload that's still there (not expired), or a 404. */
export async function findUpload(uuid, kind, now = new Date()) {
  const doc = await mdb.INTERNAL.workbookImport.findOne({ uuid: String(uuid || ''), kind }).lean();
  if (!doc) throw notFound();
  if (!doc.saved && doc.expiresAt && new Date(doc.expiresAt) <= now) throw notFound();
  return doc;
}

/** Keep the check page's choices and stop the upload expiring. */
export async function saveChoices(uuid, kind, choices, userId) {
  const doc = await findUpload(uuid, kind);
  if (doc.importedAt) throw Object.assign(new Error('That upload has already been imported.'), { status: 400 });
  await mdb.INTERNAL.workbookImport.updateOne(
    { _id: doc._id },
    { $set: { saved: true, savedAt: new Date(), savedBy: userId || undefined, choices }, $unset: { expiresAt: 1 } },
  );
  return doc;
}

/** Delete a parked upload (never the records an import wrote). */
export async function deleteUpload(uuid, kind) {
  const res = await mdb.INTERNAL.workbookImport.deleteOne({ uuid: String(uuid || ''), kind });
  if (!res.deletedCount) throw notFound();
}

/** Record the import's result (and anything in extra, e.g. the choices used); the upload then expires a day later. */
export async function markImported(id, result, now = new Date(), extra = {}) {
  await mdb.INTERNAL.workbookImport.updateOne(
    { _id: id },
    { $set: { ...extra, importedAt: now, result, saved: false, expiresAt: new Date(now.getTime() + UPLOAD_LIFETIME_MS) } },
  );
}

/**
 * Start-up: expiry used to be a TTL on createdAt, which would delete saved
 * uploads. Bring the indexes in line with the model (drops that one) and give
 * uploads from before the change an expiresAt. Idempotent.
 */
export async function migrateExpiry() {
  const Model = mdb.INTERNAL.workbookImport;
  if (!Model) return;
  await Model.syncIndexes();
  const old = await Model.find({ expiresAt: { $exists: false }, saved: { $ne: true } }).select('_id createdAt').lean();
  for (const d of old) {
    const from = d.createdAt ? new Date(d.createdAt).getTime() : Date.now();
    await Model.updateOne({ _id: d._id }, { $set: { expiresAt: new Date(from + UPLOAD_LIFETIME_MS) } });
  }
  if (old.length) logger.info(`[migration] workbookImport: gave ${old.length} upload(s) an expiry date`);
}

export default { describeUpload, recentUploads, findUpload, saveChoices, deleteUpload, markImported, migrateExpiry };
