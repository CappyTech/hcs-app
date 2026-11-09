/**
 * Finds records whose page can't be opened: record pages only accept a v4
 * uuid (CRUDRoutes), so a record with a missing or malformed uuid is listed
 * but 404s, and two records sharing one means a link opens the wrong record.
 *
 * Read only. Uses the driver directly, so scanning doesn't count as reading
 * each record in the audit trail, and only fetches the fields used as labels.
 */
import mdb from './mongooseDatabaseService.js';
import listControllerConfig from '../config/listControllerConfig.js';
import { listPathFor } from './listPathService.js';

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const NAMESPACES = ['REST', 'INTERNAL', 'PAPERLESS', 'WEB'];
const LABEL_FIELDS = ['Number', 'Code', 'Name', 'name', 'title', 'username', 'reference', 'registrationNumber'];
const SAMPLE = 25;
const MAX_MS = 15000;

const hasUuid = (model) => typeof model?.collection?.find === 'function' && !!model.schema?.path?.('uuid');

const labelOf = (doc) => {
  const field = LABEL_FIELDS.find((f) => doc[f] !== undefined && doc[f] !== null && doc[f] !== '');
  return field ? String(doc[field]) : String(doc._id);
};

async function checkModel(namespace, modelName, model) {
  // Soft-deleted records aren't shown anywhere, so they can't produce a dead link.
  const live = model.schema.path('deletedAt') ? { deletedAt: null } : {};
  const projection = Object.fromEntries(['uuid', ...LABEL_FIELDS].map((f) => [f, 1]));
  const opts = { maxTimeMS: MAX_MS };

  const unopenable = { ...live, uuid: { $not: UUID_V4 } };
  const [count, sample, duplicates] = await Promise.all([
    model.collection.countDocuments(unopenable, opts),
    model.collection.find(unopenable, { projection, limit: SAMPLE, ...opts }).toArray(),
    model.collection.aggregate([
      { $match: { ...live, uuid: { $type: 'string', $regex: UUID_V4 } } },
      { $group: { _id: '$uuid', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: SAMPLE },
    ], { allowDiskUse: true, ...opts }).toArray(),
  ]);

  if (!count && !duplicates.length) return null;
  const config = listControllerConfig[modelName];
  return {
    namespace,
    model: modelName,
    title: config?.title || modelName,
    listPath: config && !config.deny?.includes?.('l') ? listPathFor(modelName) : null,
    count,
    records: sample.map((doc) => ({ label: labelOf(doc), uuid: doc.uuid ? String(doc.uuid) : null })),
    duplicates: duplicates.map((d) => ({ uuid: d._id, count: d.count })),
  };
}

/**
 * @returns {Promise<{checked:number, problems:Object[], failed:Object[], total:number}>}
 *   failed: models that couldn't be checked, so a timeout never reads as "all clear".
 */
export async function runCheck(db = mdb) {
  const problems = [];
  const failed = [];
  let checked = 0;
  for (const namespace of NAMESPACES) {
    for (const [modelName, model] of Object.entries(db[namespace] || {})) {
      if (!hasUuid(model)) continue;
      try {
        const found = await checkModel(namespace, modelName, model);
        checked += 1;
        if (found) problems.push(found);
      } catch (err) {
        failed.push({ namespace, model: modelName, reason: err.message });
      }
    }
  }
  problems.sort((a, b) => a.title.localeCompare(b.title));
  const total = problems.reduce((n, p) => n + p.count + p.duplicates.length, 0);
  return { checked, problems, failed, total };
}

export default { runCheck, UUID_V4 };
