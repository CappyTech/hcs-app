import mongoose from 'mongoose';
import schemas from '@cappytech/hcs-schemas';
const { bankReconciliation, uuidField } = schemas;

/**
 * KashFlow's own bank reconciliations, mirrored read-only by hcs-sync.
 *
 * We reconcile locally and never write back, so this exists purely for
 * comparison: what KashFlow believes is reconciled, and the
 * StartBalance/EndBalance anchors for our own period sign-off.
 *
 * strict:false because the Transactions[] sub-shape is Mixed and KashFlow's
 * list and detail endpoints return different field sets.
 */

// Guarded so an image built against hcs-schemas < 2.1.0 degrades to "model
// absent" rather than throwing at import time. createNamespace warns and skips
// a default export without modelName/schema, so the app still boots; every
// consumer null-guards mdb.REST?.bankReconciliation accordingly.
let exported = {};

if (bankReconciliation) {
  const bankReconciliationSchema = new mongoose.Schema({
    uuid: uuidField,
    ...bankReconciliation.fields,
    syncedAt: { type: Date, default: null },
  }, { timestamps: true, strict: false });

  bankReconciliation.indexes.forEach(idx => bankReconciliationSchema.index(idx.fields, idx.options));

  exported = { modelName: 'bankReconciliation', schema: bankReconciliationSchema };
}

export default exported;
