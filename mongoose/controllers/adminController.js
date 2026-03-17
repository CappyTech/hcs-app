'use strict';

const path = require('path');
const mdb = require('../services/mongooseDatabaseService');

// Human-readable label per model, derived from document fields
const MODEL_META = {
  purchase: doc => `Purchase #${doc.Number}${doc.SupplierName ? ' — ' + doc.SupplierName : ''}`,
  invoice:  doc => `Invoice #${doc.Number}${doc.CustomerName ? ' — ' + doc.CustomerName : ''}`,
  customer: doc => doc.Name || doc.Code || String(doc.Id || ''),
  supplier: doc => doc.Name || doc.Code || String(doc.Id || ''),
  project:  doc => doc.Name || doc.Reference || (doc.Number ? `#${doc.Number}` : String(doc._id)),
  quote:    doc => `Quote #${doc.Number}${doc.CustomerName ? ' — ' + doc.CustomerName : ''}`,
  nominal:  doc => `${doc.Code || ''} ${doc.Name || ''}`.trim(),
  note:     doc => `${doc.ObjectType || ''} #${doc.ObjectNumber || ''}: ${(doc.Text || '').slice(0, 60)}`,
};

exports.getDeletedItems = async (req, res, next) => {
  try {
    const rows = [];

    for (const [modelName, labelFn] of Object.entries(MODEL_META)) {
      const model = mdb.REST[modelName];
      if (!model) continue;

      const docs = await model
        .find({ deletedAt: { $type: 'date' } })
        .sort({ deletedAt: -1 })
        .lean();

      for (const doc of docs) {
        rows.push({
          model: modelName,
          label: labelFn(doc),
          deletedAt: doc.deletedAt,
          uuid: doc.uuid || null,
        });
      }
    }

    // Sort all results newest-deleted first
    rows.sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));

    res.render(path.join('tailwindcss', 'admin', 'deletedItems'), {
      title: 'Deleted Items',
      rows,
    });
  } catch (err) {
    next(err);
  }
};
