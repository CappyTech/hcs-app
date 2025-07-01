// upsertDataMongoose.js
const fs = require('fs');
const path = require('path');
const logger = require('../../services/loggerService');

const PLACEHOLDER_DATES = [
  "0001-01-01T00:00:00.000Z",
  "2001-01-01T00:01:15.000Z",
  "0001-01-01T00:01:15.000Z"
];

function isPlaceholderDate(value) {
  return PLACEHOLDER_DATES.includes(value);
}

async function appendLogEntry(logFilePath, logEntry) {
  try {
    const logDir = path.dirname(logFilePath);

    // ✅ Ensure directory exists
    await fs.promises.mkdir(logDir, { recursive: true });

    const logData = `${new Date().toISOString()} - ${JSON.stringify(logEntry, null, 2)}\n`;
    await fs.promises.appendFile(logFilePath, logData, 'utf8');
  } catch (error) {
    logger.error(`Error writing to log file: ${error.message}`);
  }
}

async function upsertDataMongoose(model, data, uniqueKey, metaModel = null, logDetails = [], logFilePath = '', sendUpdate = () => { }, startfetch = Date.now()) {
  try {
    logger.info(`(Mongo) Upserting data into ${model.modelName}...`);
    sendUpdate(`📥 Upserting into ${model.modelName}...`);
    const startupsertData = Date.now();

    let createdCount = 0;
    let updatedCount = 0;
    let checkedCount = 0;

    for (const item of data) {
      const filter = { [uniqueKey]: item[uniqueKey] };
      const existing = await model.findOne(filter).lean();

      if (existing) {
        checkedCount++;
        const changes = {};
        let hasRealChange = false;

        // ✅ Check for any fields that must always be injected if missing
        if (
          existing.IsSubcontractor === undefined ||
          existing.CISRate === undefined ||
          existing.CISNumber === undefined
        ) {
          hasRealChange = true;
          Object.assign(changes, {
            ...(existing.IsSubcontractor === undefined && { IsSubcontractor: { from: undefined, to: item.IsSubcontractor } }),
            ...(existing.CISRate === undefined && { CISRate: { from: undefined, to: item.CISRate } }),
            ...(existing.CISNumber === undefined && { CISNumber: { from: undefined, to: item.CISNumber } }),
          });
        }

        // 🔁 Normal diff comparison
        for (const key of Object.keys(item)) {
          let currentValue = existing[key];
          let newValue = item[key];

          // Normalize dates for placeholder check
          if (currentValue instanceof Date) currentValue = currentValue.toISOString();
          if (newValue instanceof Date) newValue = newValue.toISOString();
          if (isPlaceholderDate(currentValue) && isPlaceholderDate(newValue)) continue;
          if (key.toLowerCase().includes('created') || key.toLowerCase().includes('updated')) {
            const normCurrent = currentValue ? new Date(currentValue).toISOString().split('.')[0] : null;
            const normNew = newValue ? new Date(newValue).toISOString().split('.')[0] : null;
            if (normCurrent !== normNew) {
              changes[key] = { from: currentValue, to: newValue };
              hasRealChange = true;
            }
            continue;
          }

          if (
            typeof currentValue === typeof newValue &&
            JSON.stringify(currentValue) !== JSON.stringify(newValue)
          ) {
            // Skip changes if both are placeholders and same type
            if (isPlaceholderDate(currentValue) && isPlaceholderDate(newValue)) continue;
            changes[key] = { from: currentValue, to: newValue };
            hasRealChange = true;
          }
        }

        if (hasRealChange) {
          await model.updateOne(filter, { $set: item });
          updatedCount++;
          const logEntry = {
            model: model.modelName,
            action: 'updated',
            uniqueKey: item[uniqueKey],
            changes,
          };
          logDetails.push(logEntry);
          if (logFilePath) await appendLogEntry(logFilePath, logEntry);
        }
      } else {
        await model.create(item);
        createdCount++;
        const logEntry = {
          model: model.modelName,
          action: 'created',
          uniqueKey: item[uniqueKey],
          item,
        };
        logDetails.push(logEntry);
        if (logFilePath) await appendLogEntry(logFilePath, logEntry);
      }
    }

    if (metaModel) {
      await metaModel.updateOne(
        { model: model.modelName },
        {
          $set: {
            createdCount,
            updatedCount,
            checkedCount,
            lastFetchedAt: new Date()
          }
        },
        { upsert: true }
      );
    }

    const summary = `Created ${createdCount}, Updated ${updatedCount}, Checked ${checkedCount}`;
    logger.info(`✅ (Mongo) ${model.modelName} sync complete`, {
      model: model.modelName,
      action: 'summary',
      created: createdCount,
      updated: updatedCount,
      checked: checkedCount,
      durationMs: Date.now() - startupsertData
    });

    sendUpdate(`✅ ${model.modelName} Done: ${summary}`);
    sendUpdate(`⏱ ${model.modelName} took ${Date.now() - startupsertData}ms`);
    sendUpdate(`⏱ Fetch has taken ${Date.now() - startfetch}ms`);

    return { model: model.modelName, createdCount, updatedCount, checkedCount, summary };

  } catch (error) {
    logger.error(`Error upserting into Mongo model ${model.modelName}: ${error.message}`);
  }
}

module.exports = upsertDataMongoose;