// Read-only mirror of the payroll provider's data (Staffology), written by
// hcs-sync into its own database. hcs-app never writes to it.
//
// Guarded so the app still boots on an hcs-schemas pin that predates 3.1.0:
// without the entity, createNamespace skips the model (no modelName/schema).
import mongoose from 'mongoose';
import schemas from '@cappytech/hcs-schemas';
const { payrollPayRunEntry: entity, uuidField } = schemas;

let exported = {};
if (entity) {
  const schema = new mongoose.Schema({
    uuid: uuidField,
    ...entity.fields,
  }, {
    collection: entity.collection,
    strict: false,
    timestamps: true,
    // hcs-sync owns the indexes on this database.
    autoIndex: false,
  });
  entity.indexes.forEach((idx) => schema.index(idx.fields, idx.options));
  exported = { modelName: 'payrollpayrunentry', schema };
}

export default exported;
