const authenticate = require('./autoAuth');
const db = require('../services/sequelizeDatabaseService');
const getCustomers = require('./getCustomers');
const getProjects = require('./getProjects');
const getQuotes = require('./getQuotes');
const getSuppliers = require('./getSuppliers');
const getInvoicesByDate = require('./getInvoicesByDate');
const getReceiptsForSupplier = require('./getReceiptsForSupplier');
const logger = require('../services/loggerService');

// Upsert function with KF_Meta table update
async function upsertData(model, data, uniqueKey, metaModel) {
    try {
        logger.info(`Upserting data into ${model.name}...`);
        let createdCount = 0;
        let updatedCount = 0;

        for (const item of data) {
            const [instance, created] = await model.upsert(item, {
                where: { [uniqueKey]: item[uniqueKey] },
            });

            if (created) {
                createdCount++;
            } else {
                updatedCount++;
            }
        }

        await metaModel.upsert({
            model: model.name,
            createdCount,
            updatedCount,
            lastFetchedAt: new Date(),
        });

        logger.info(`Upsert complete for ${model.name}. Created: ${createdCount}, Updated: ${updatedCount}`);
    } catch (error) {
        logger.info(`Error upserting into ${model.name}: ${error.message}`);
    }
}

let isFetching = false;

exports.fetchKashFlowData = async () => {
    if (isFetching) {
        logger.info('A fetch operation is already in progress.');
        return;
    }
    try {
        isFetching = true;
        isMaintenanceMode = true;
        logger.info('Maintenance mode enabled.');
        logger.info('Authenticating SOAP API...');
        const client = await new Promise((resolve, reject) => {
            authenticate((error, client) => {
                if (error) {
                    logger.error('Failed to authenticate: ' + error.message);
                    return reject(error);
                }
                resolve(client);
            });
        });

        logger.info('SOAP API authenticated successfully.');

        const KF_Meta = db.KF_Meta;

        // Fetch and upsert customers
        logger.info('Fetching customers...');
        const customers = await getCustomers(client);
        if (customers.length > 0) {
            logger.info(`Fetched ${customers.length} customers.`);
            await upsertData(db.KF_Customers, customers, 'CustomerID', KF_Meta);
        } else {
            logger.info('No customers found.');
        }

        // Fetch and upsert projects
        logger.info('Fetching projects...');
        const projects = await getProjects(client);
        if (projects.length > 0) {
            logger.info(`Fetched ${projects.length} projects.`);
            await upsertData(db.KF_Projects, projects, 'ID', KF_Meta);
        } else {
            logger.info('No projects found.');
        }

        // Fetch and upsert quotes
        logger.info('Fetching quotes...');
        const quotes = await getQuotes(client);
        if (quotes.length > 0) {
            logger.info(`Fetched ${quotes.length} quotes.`);
            await upsertData(
                db.KF_Quotes,
                quotes.map((quote) => ({
                    ...quote,
                    Lines: quote.Lines?.anyType?.map((line) => ({
                        LineID: line.LineID,
                        Quantity: line.Quantity,
                        Description: line.Description,
                        Rate: line.Rate,
                        ChargeType: line.ChargeType,
                        VatRate: line.VatRate,
                        VatAmount: line.VatAmount,
                        ProductID: line.ProductID,
                        Sort: line.Sort,
                        ProjID: line.ProjID,
                    })),
                })),
                'InvoiceDBID',
                KF_Meta
            );
        } else {
            logger.info('No quotes found.');
        }

        // Fetch and upsert suppliers
        logger.info('Fetching suppliers...');
        const suppliers = await getSuppliers(client);
        if (suppliers.length > 0) {
            logger.info(`Fetched ${suppliers.length} suppliers.`);
            await upsertData(db.KF_Suppliers, suppliers, 'SupplierID', KF_Meta);
        } else {
            logger.info('No suppliers found.');
        }

        // Fetch and upsert invoices
        const startDate = new Date('2014-01-01');
        const endDate = new Date();
        logger.info('Fetching invoices...');
        const invoices = await getInvoicesByDate(client, startDate, endDate);
        if (invoices.length > 0) {
            logger.info(`Fetched ${invoices.length} invoices.`);
            await upsertData(db.KF_Invoices, invoices.map((invoice) => ({
                ...invoice,
                Lines: invoice.Lines?.anyType?.map((line) => ({
                    LineID: line.LineID,
                    Quantity: line.Quantity,
                    Description: line.Description,
                    Rate: line.Rate,
                    ChargeType: line.ChargeType,
                    VatRate: line.VatRate,
                    VatAmount: line.VatAmount,
                    ProductID: line.ProductID,
                    Sort: line.Sort,
                    ProjID: line.ProjID,
                })),
            })), 'InvoiceDBID', KF_Meta);
        } else {
            logger.info('No invoices found.');
        }

        // Fetch and upsert receipts for each supplier
        for (const supplier of suppliers) {
            logger.info(`Fetching receipts for supplier: ${supplier.Name}...`);
            const receipts = await getReceiptsForSupplier(client, supplier.SupplierID);
            if (receipts && receipts.length > 0) {
                logger.info(`Fetched ${receipts.length} receipts for supplier: ${supplier.Name}`);
                await upsertData(
                    db.KF_Receipts,
                    receipts.map((receipt) => ({
                        ...receipt,
                        Lines: receipt.Lines?.anyType?.map((line) => ({
                            LineID: line.LineID,
                            Quantity: line.Quantity,
                            Description: line.Description,
                            Rate: line.Rate,
                            ChargeType: line.ChargeType,
                            VatRate: line.VatRate,
                            VatAmount: line.VatAmount,
                            ProductID: line.ProductID,
                            Sort: line.Sort,
                            ProjID: line.ProjID,
                        })),
                    })),
                    'InvoiceDBID',
                    KF_Meta
                );
            } else {
                logger.info(`No receipts found for supplier: ${supplier.Name}`);
            }
        }
        isMaintenanceMode = false;
        logger.info('Maintenance mode disabled.');
        logger.info('Data fetch and upsert completed.');
    } catch (error) {
        logger.error(`An error occurred during fetch: ${error.message}`);
    } finally {
        isFetching = false;
        isMaintenanceMode = false;
        logger.info('Maintenance mode disabled.');
    }
};
