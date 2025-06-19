async function upsertData(model, data, uniqueKey, metaModel, logDetails, logFilePath) {
    try {
        logger.info(`Upserting data into ${model.name}...`);
        let createdCount = 0;
        let updatedCount = 0;
        let checkedCount = 0;

        for (const item of data) {
            const whereClause = { [uniqueKey]: item[uniqueKey] };

            try {
                const existing = await model.findOne({ where: whereClause, raw: false });

                if (existing) {
                    checkedCount++;
                    const changes = {};
                    let isEqual = true;

                    for (const key of Object.keys(item)) {
                        const currentValue = existing[key];
                        const newValue = item[key];

                        // 1. Skip placeholder dates (e.g., "0001-01-01T00:00:00.000Z")
                        if (key.toLowerCase().includes('date') && newValue === '0001-01-01T00:00:00.000Z' || newValue === '2001-01-01T00:01:15.000Z') {
                            continue; // Ignore placeholder dates
                        }

                        // 2. Normalize booleans and integers
                        const normalizedCurrent = (typeof currentValue === 'boolean' || typeof currentValue === 'number')
                            ? Boolean(currentValue)
                            : currentValue;
                        const normalizedNew = (typeof newValue === 'boolean' || typeof newValue === 'number')
                            ? Boolean(newValue)
                            : newValue;

                        if (typeof normalizedNew === 'object' && normalizedNew !== null) {
                            // 3. Compare objects (JSON.stringify)
                            if (JSON.stringify(normalizedCurrent) !== JSON.stringify(normalizedNew)) {
                                changes[key] = { from: currentValue, to: newValue };
                                isEqual = false;
                            }
                        } else if (normalizedCurrent !== normalizedNew) {
                            // 4. Compare primitive types
                            changes[key] = { from: currentValue, to: newValue };
                            isEqual = false;
                        }
                    }

                    if (!isEqual) {
                        // Perform the update if changes are detected
                        await model.update(item, { where: whereClause });
                        updatedCount++;
                        const logEntry = {
                            model: model.name,
                            action: 'updated',
                            uniqueKey: item[uniqueKey],
                            changes,
                        };
                        logDetails.push(logEntry);
                        await appendLogEntry(logFilePath, logEntry);
                    }
                } else {
                    // Create new record if it doesn't exist
                    await model.create(item);
                    createdCount++;
                    const logEntry = {
                        model: model.name,
                        action: 'created',
                        uniqueKey: item[uniqueKey],
                        item,
                    };
                    logDetails.push(logEntry);
                    await appendLogEntry(logFilePath, logEntry);
                }
            } catch (findOrUpdateError) {
                logger.error(`Error processing ${JSON.stringify(whereClause)}: ${findOrUpdateError.message}`);
            }
        }

        // Update metadata
        try {
            await metaModel.upsert({
                model: model.name,
                createdCount,
                updatedCount,
                checkedCount,
                lastFetchedAt: new Date(),
            });
        } catch (metaError) {
            logger.error(`Error updating meta model for ${model.name}: ${metaError.message}`);
        }

        logger.info(`Upsert complete for ${model.name}. Created: ${createdCount}, Updated: ${updatedCount}, Checked: ${checkedCount}`);
    } catch (error) {
        logger.error(`Error upserting into ${model.name}: ${error.message}`);
    }
}