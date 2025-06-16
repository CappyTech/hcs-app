// services/migrationService.js
const logger = require('./loggerService');

/**
 * Generic data migrator from Sequelize to Mongoose
 * 
 * @param {Object} sequelizeModel - Sequelize model (e.g., db.Users)
 * @param {Object} mongooseModel - Mongoose model (e.g., mdb.user)
 * @param {Function} transformFn - Function to transform Sequelize record to Mongoose-ready object
 * @param {String} key - Unique key to upsert by (e.g., 'uuid' or 'KashFlowID')
 */
async function migrateModel(sequelizeModel, mongooseModel, transformFn, key = 'uuid') {
    const modelName = sequelizeModel?.name || 'UnknownModel';

    try {
        const records = await sequelizeModel.findAll();
        logger.info(`Migrating ${records.length} record(s) from ${modelName}...`);

        let migrated = 0;
        for (const record of records) {
            const plain = record.get({ plain: true });
            const transformed = await transformFn(plain); // ✅ Fix

            const uniqueKey = transformed?.[key];
            if (!uniqueKey) {
                logger.warn(`Skipped record without ${key}: ${JSON.stringify(plain)}`);
                continue;
            }

            await mongooseModel.updateOne(
                { [key]: uniqueKey },
                transformed,
                { upsert: true }
            );
            migrated++;
        }

        logger.info(`✅ Migrated ${migrated} record(s) from ${modelName}`);
    } catch (error) {
        logger.error(`❌ Migration failed for ${sequelizeModel?.name || 'UnknownModel'}: ${error.message}`);
    }
}

module.exports = { migrateModel };
