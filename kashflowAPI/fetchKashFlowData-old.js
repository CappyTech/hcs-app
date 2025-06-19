const fs = require('fs');
const path = require('path');
const authenticate = require('./autoAuth');
const db = require('../services/kashflowDatabaseService');
const getCustomers = require('./getCustomers');
const getProjects = require('./getProjects');
const getQuotes = require('./getQuotes');
const getSuppliers = require('./getSuppliers');
const getInvoicesByDate = require('./getInvoicesByDate');
const getReceiptsForSupplier = require('./getReceiptsForSupplier');
const getReceiptPayment = require('./getReceiptPayment');
const getInvoicePayment = require('./getInvoicePayment');
const logger = require('../services/loggerService');
const taxService = require('../services/taxService');
const getInvoiceNotes = require('./getInvoiceNotes');
const getReceiptNotes = require('./getReceiptNotes');
const ChargeTypes = require('../controllers/CRUD/kashflow/chargeTypes.json');

async function logOperationDetails(filename, data) {
    try {
        const filePath = path.join(__dirname, '../logs', filename);
        const logData = JSON.stringify(data, null, 2);
        await fs.promises.writeFile(filePath, logData, 'utf8');
    } catch (error) {
        logger.error(`Failed to write log file: ${error.message}`);
    }
}

const PLACEHOLDER_DATES = ["0001-01-01T00:00:00.000Z", "2001-01-01T00:01:15.000Z", "2001-01-01T00:01:15.000Z", "0001-01-01T00:01:15.000Z"];

function isPlaceholderDate(value) {
    return PLACEHOLDER_DATES.includes(value);
}

async function upsertData(model, data, uniqueKey, metaModel, logDetails, logFilePath, sendUpdate = () => {}, startfetch) {
    try {
        logger.info(`Upserting data into ${model.name}...`);
        sendUpdate(`📥 Upserting into ${model.name}...`);
        const startupsertData = Date.now();

        let createdCount = 0;
        let updatedCount = 0;
        let checkedCount = 0;

        for (const item of data) {
            const whereClause = { [uniqueKey]: item[uniqueKey] };
            //logger.debug(`whereClause: ${JSON.stringify(whereClause)}`);
        
            // Fetch existing record for comparison
            const existing = await model.findOne({ where: whereClause, raw: true });
            //logger.debug(`Existing record: ${JSON.stringify(existing)}`);
        
            if (existing) {
                checkedCount++;
                const changes = {};
                let hasRealChange = false;
        
                for (const key of Object.keys(item)) {
                    const currentValue = existing[key];
                    const newValue = item[key];
                    //const debug = key === 'DueDate';

                    //if (debug) {
                        //logger.debug(`Key: ${key}\n Current Value: ${currentValue}\n New Value: ${newValue}`);
                        //logger.debug(`Type of Current Value: ${typeof currentValue}\n Type of New Value: ${typeof newValue}`);
                    //}
                    // Skip placeholder dates or redundant type differences
                    if (isPlaceholderDate(currentValue) || isPlaceholderDate(newValue)) {
                        //if (debug) {
                            //logger.debug(`Skipping placeholder date for key: ${key}`);
                        //}
                        continue;
                    }

                    // Normalize and compare timestamps to the second (ignore microseconds/milliseconds)
                    if (key.toLowerCase().includes('created') || key.toLowerCase().includes('updated')) {
                        const normalizedCurrent = currentValue ? new Date(currentValue).toISOString().split('.')[0] : null;
                        const normalizedNew = newValue ? new Date(newValue).toISOString().split('.')[0] : null;
                        //if (debug) {
                            //logger.debug(`Normalized Current: ${normalizedCurrent}, Normalized New: ${normalizedNew}`);
                        //}

                        if (normalizedCurrent !== normalizedNew) {
                            // If the timestamps differ significantly, log the change
                            changes[key] = { from: currentValue, to: newValue };
                            hasRealChange = true; // Only set this if the difference is beyond normalization
                        }
                        //logger.debug(`Continuing after timestamp normalization check for key: ${key}`);
                        
                        continue; // Skip further checks for timestamps
                    }
        
                    // Check for real changes (ignore type differences)
                    if (
                        typeof currentValue === typeof newValue &&
                        JSON.stringify(currentValue) !== JSON.stringify(newValue)
                    ) {
                        changes[key] = { from: currentValue, to: newValue };
                        hasRealChange = true;
                    }
                }
        
                // Update only if there are real changes
                if (hasRealChange) {
                    logger.info(`Updating record with changes: ${JSON.stringify(changes)}`);
                    await model.update(item, { where: whereClause });
                    updatedCount++;
                    const logEntry = {
                        model: model.name,
                        action: 'updated',
                        uniqueKey: item[uniqueKey],
                        changes,
                    };
                    logDetails.push(logEntry);
                    //logger.debug(JSON.stringify(logEntry, null, 2));
                    await appendLogEntry(logFilePath, logEntry);
                }
            } else {
                // Create new entry if it doesn't exist
                logger.info(`Creating new record: ${JSON.stringify(item)}`);
                await model.create(item);
                createdCount++;
                const logEntry = {
                    model: model.name,
                    action: 'created',
                    uniqueKey: item[uniqueKey],
                    item,
                };
                logDetails.push(logEntry);
                //logger.debug(JSON.stringify(logEntry, null, 2));
                await appendLogEntry(logFilePath, logEntry);
            }
        }        

        // Update metadata
        try {
            logger.info(`Updating metadata for model: ${model.name}`);
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

        const summary = `Created ${createdCount}, Updated ${updatedCount}, Checked ${checkedCount}`;
        logger.info(`✅ ${model.name} Done: ${summary}`);
        sendUpdate(`✅ ${model.name} Done: ${summary}`);
        logger.info(`Upsert complete for ${model.name}. Created: ${createdCount}, Updated: ${updatedCount}, Checked: ${checkedCount}`);
        const ms = Date.now() - startupsertData;
        sendUpdate(`⏱ ${model.name} took ${ms}ms`);
        const msf = Date.now() - startfetch;
        sendUpdate(`⏱ Fetch has taken ${msf}ms`);
        return {
            model: model.name,
            createdCount,
            updatedCount,
            checkedCount,
            summary,
        };
    } catch (error) {
        logger.error(`Error upserting into ${model.name}: ${error.message}`);
    }
}


async function appendLogEntry(logFilePath, logEntry) {
    try {
        const logData = `${new Date().toISOString()} - ${JSON.stringify(logEntry, null, 2)}\n`;
        await fs.promises.appendFile(logFilePath, logData, 'utf8');
    } catch (error) {
        logger.error(`Error writing to log file: ${error.message}`);
    }
}

let isFetching = false;

exports.fetchKashFlowData = async (sendUpdate = () => {}) => {
    if (isFetching) {
        logger.info('A fetch operation is already in progress.');
        return;
    }
    const operationLog = [];
    try {
        isFetching = true;
        startfetch = Date.now();

        const DEBUG_SUPPLIER_NAME = "C & D Surfacing";
        const DEBUG_LOG_PATH = path.join(__dirname, `../logs/debug-supplier-${DEBUG_SUPPLIER_NAME.replace(/\s+/g, '-').toLowerCase()}.txt`);

        async function debugLog(data) {
            const output = `${new Date().toISOString()} - ${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}\n\n`;
            await fs.promises.appendFile(DEBUG_LOG_PATH, output, 'utf8');
        }
        const client = await new Promise((resolve, reject) => {
            authenticate((error, client) => {
                if (error) {
                    return reject(error);
                }
                resolve(client);
            });
        });
        const KF_Meta = db.KF_Meta;

        //////////////////////////////////////////

        const modelsToFetch = [
            { name: 'customers', fetchFn: getCustomers, model: db.KF_Customers, uniqueKey: 'CustomerID' },
            { name: 'supplier', fetchFn: getSuppliers, model: db.KF_Suppliers, uniqueKey: 'SupplierID' },
        ];

        for (const { name, fetchFn, model, uniqueKey } of modelsToFetch) {
            logger.info(`Fetching ${name.toLowerCase()}...`);
            const data = await fetchFn(client);
            if (data.length > 0) {
                logger.info(`Fetched ${data.length} ${name.toLowerCase()}.`);
                await upsertData(model, data, uniqueKey, KF_Meta, operationLog, `./logs/${name}.txt`,sendUpdate,startfetch);
            } else {
                logger.info(`No ${name.toLowerCase()} found.`);
            }
        }

        //////////////////////////////////////////

        // Fetch projects for all statuses (0 = Completed, 1 = Active, 2 = Archived)
        const [completedProjects, activeProjects, archivedProjects] = await Promise.all([
            getProjects(client, 0), // Completed
            getProjects(client, 1), // Active
            getProjects(client, 2), // Archived
        ]);
        logger.info('Projects fetched for all statuses:');
        logger.info(`Completed: ${completedProjects.length}`);
        logger.info(`Active: ${activeProjects.length}`);
        logger.info(`Archived: ${archivedProjects.length}`);
        // Merge or handle the results as needed
        const allProjects = [
            ...completedProjects,
            ...activeProjects,
            ...archivedProjects,
        ];
        if (allProjects.length > 0) {
            logger.info(`Fetched ${allProjects.length} projects.`);
            await upsertData(
                db.KF_Projects,
                allProjects,
                'ID',
                KF_Meta,
                operationLog,
                './logs/projects.txt',
                sendUpdate,
                startfetch
            );
        } else {
            logger.info('No projects found.');
        }

        //////////////////////////////////////////

        logger.info('Fetching invoices...');
        const startDate = new Date('2014-01-01');
        const endDate = new Date();
        const invoices = await getInvoicesByDate(client, startDate, endDate);
        if (invoices.length > 0) {

            logger.info(`Fetched ${invoices.length} invoices.`);

            //transform invoices and include lines
            const transformedInvoices = await Promise.all(invoices.map(async (invoice) => {
                // Fetch payments for the invoice
                const payments = await getInvoicePayment(client, invoice.InvoiceNumber);
                //logger.debug(`Payments for InvoiceNumber ${quote.InvoiceNumber}: ${JSON.stringify(payments, null, 2)}`);
                const mappedLines = invoice.Lines?.anyType?.map(mapLine) || [];
                return {
                    ...invoice,
                    mappedLines,
                    Payments: { Payment: payments },
                };
            }));

            await upsertData(
                db.KF_Invoices,
                invoices.map((invoice) => ({
                    ...invoice,
                    Lines: invoice.Lines?.anyType?.map(mapLine),
                })),
                'InvoiceDBID',
                KF_Meta,
                operationLog,
                './logs/invoices.txt',
                sendUpdate,
                startfetch
            );
        } else {
            logger.info('No invoices found.');
        }

        //////////////////////////////////////////

        logger.info('Fetching quotes...');
        const quotes = await getQuotes(client);
        if (quotes.length > 0) {

            logger.info(`Fetched ${quotes.length} quotes.`);

            //transform quotes and include lines and payment
            const transformedQuotes = await Promise.all(quotes.map(async (quote) => {
                // Fetch payments for the quote
                const payments = await getInvoicePayment(client, quote.InvoiceNumber);
                const notes = await getInvoiceNotes(client, quote.InvoiceDBID);
                //logger.debug(`Payments for InvoiceNumber ${quote.InvoiceNumber}: ${JSON.stringify(payments, null, 2)}`);
                const mappedLines = quote.Lines?.anyType?.map(mapLine) || [];
                return {
                    ...quote,
                    mappedLines,
                    Payments: { Payment: payments },
                    notes,
                };
            }));

            await upsertData(
                db.KF_Quotes,
                transformedQuotes,
                'InvoiceDBID',
                KF_Meta,
                operationLog,
                './logs/quotes.txt',
                sendUpdate,
                startfetch
            );
        } else {
            logger.info('No quotes found.');
        }

        //////////////////////////////////////////

        for (const supplier of await db.KF_Suppliers.findAll({ raw: true })) {
            try {

                const isDebugSupplier = supplier.Name === DEBUG_SUPPLIER_NAME;

                logger.info(`Starting to fetch receipts for supplier: ${supplier.Name}, SupplierID: ${supplier.SupplierID}`);

                if (isDebugSupplier) {
                    const msg = `🔍 DEBUG MATCH: Supplier Details`;
                    logger.debug(msg);
                    await debugLog([msg, supplier]);
                }

                const receipts = await getReceiptsForSupplier(client, supplier.SupplierID);
        
                if (isDebugSupplier) {
                    const msg = `🔍 DEBUG MATCH: Raw Receipts`;
                    logger.debug(msg);
                    await debugLog([msg, receipts]);
                }

                if (receipts.length > 0) {
                    logger.info(`Fetched ${receipts.length} receipts for supplier: ${supplier.Name} (SupplierID: ${supplier.SupplierID})`);
        
                    // Transform receipts and include lines and payments
                    const transformedReceipts = await Promise.all(receipts.map(async (receipt) => {
                        // Fetch payments for the receipt
                        const payments = await getReceiptPayment(client, receipt.InvoiceNumber);
                        const notes = await getReceiptNotes(client, receipt.InvoiceDBID);
                        //logger.debug(`Payments for ReceiptNumber ${receipt.InvoiceNumber}: ${JSON.stringify(payments, null, 2)}`);
                        const mappedLines = receipt.Lines?.anyType?.map(mapLine) || [];
                        let taxYear;
                        let taxMonth;
                        if (payments && payments.Payment[0]?.PayDate) {
                            ({ taxYear, taxMonth } = taxService.calculateTaxYearAndMonth(payments.Payment[0].PayDate));
                            //logger.debug(`Tax Year: ${taxYear}, Tax Month: ${taxMonth}`);
                        }

                        const transformed = {
                            ...receipt,
                            mappedLines,
                            Payments: { Payment: payments },
                            TaxMonth: taxMonth,
                            TaxYear: taxYear,
                            notes,
                        };
        
                        if (isDebugSupplier) {
                            const msg = `🔍 DEBUG MATCH: Transformed Receipt ${receipt.InvoiceNumber}`;
                            logger.debug(msg);
                            await debugLog([msg, transformed]);
                        }
        
                        return transformed;
                    }));

                    // Upsert receipts with payments
                    await upsertData(
                        db.KF_Receipts,
                        transformedReceipts,
                        'InvoiceDBID',
                        KF_Meta,
                        operationLog,
                        './logs/receipts.txt',
                        sendUpdate,
                        startfetch
                    );
        
                    logger.info(`Successfully upserted ${receipts.length} receipts for supplier: ${supplier.Name} (SupplierID: ${supplier.SupplierID})`);
                } else {
                    logger.info(`No receipts found for supplier: ${supplier.Name} (SupplierID: ${supplier.SupplierID})`);
                }
            } catch (error) {
                logger.error(`Error processing receipts for supplier: ${supplier.Name} (SupplierID: ${supplier.SupplierID}): ${error.message}`);
            }
        }        

        logger.info('Data fetch and upsert completed.');

        const logFilename = `fetch-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
        await logOperationDetails(logFilename, operationLog);
    } catch (error) {
        logger.error(`An error occurred during fetch: ${error.message}`);
    }
};

function mapLine(line) {
    return {
        LineID: line.LineID,
        Quantity: line.Quantity || null,
        Description: line.Description || null,
        Rate: line.Rate || null,
        ChargeType: line.ChargeType || null,
        ChargeTypeName: line.ChargeType ? ChargeTypes[line.ChargeType] || null : null,
        VatRate: line.VatRate || null,
        VatAmount: line.VatAmount || null,
        ProductID: line.ProductID || null,
        Sort: line.Sort || null,
        ProjID: line.ProjID || null,
    };
}

