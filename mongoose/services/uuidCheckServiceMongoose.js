const { v4: uuidv4 } = require('uuid');
const logger = require('../../services/loggerService');
const mdb = require('./mongooseDatabaseService');

async function ensureUUIDs() {
  for (const [modelName, model] of Object.entries(mdb)) {
    if (!model || !model.schema || typeof model.schema.path !== 'function') {
      logger.warn(`Skipping ${modelName} – not a valid Mongoose model.`);
      continue;
    }

    if (!model.schema.path('uuid')) {
      logger.warn(`Model ${modelName} has no uuid field – skipping.`);
      continue;
    }

    const docs = await model.find({ uuid: { $exists: false } });
    if (docs.length === 0) {
      logger.info(`✅ ${modelName}: all records already have UUIDs.`);
      continue;
    }

    logger.info(`🛠️ ${modelName}: Found ${docs.length} records missing UUIDs.`);

    for (const doc of docs) {
      doc.uuid = uuidv4();
      await doc.save();
    }

    logger.info(`✅ ${modelName}: Added UUIDs to ${docs.length} records.`);
  }
}

module.exports = { ensureUUIDs };