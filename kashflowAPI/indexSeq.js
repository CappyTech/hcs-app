const authenticate = require('./autoAuth');
const db = require('../services/sequelizeDatabaseService');
const logger = require('../services/loggerService');

const getCustomers = require('./getCustomers');
const getProjects = require('./getProjects');
const getQuotes = require('./getQuotes');
const getSuppliers = require('./getSuppliers');
const getInvoicesByDate = require('./getInvoicesByDate');
const getReceiptsForSupplier = require('./getReceiptsForSupplier');

async function upsertData(model, data, uniqueKey, metaModel) {
  logger.info(`Upserting data into ${model.name}...`);
  let createdCount = 0;
  let updatedCount = 0;

  try {
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

    // Update the KF_Meta table
    await metaModel.upsert({
      model: model.name,
      createdCount,
      updatedCount,
      lastFetchedAt: new Date(),
    });

    logger.info(`Upsert complete for ${model.name}. Created: ${createdCount}, Updated: ${updatedCount}`);
  } catch (error) {
    logger.error(`Error upserting into ${model.name}:` + error);
  }
}


(async () => {
  try {
    const KF_Meta = db.KF_Meta;

    // Authenticate with KashFlow API
    const client = await new Promise((resolve, reject) => {
      authenticate((error, client) => {
        if (error) {
          logger.error('Failed to authenticate:' + error);
          return reject(error);
        }
        resolve(client);
      });
    });

    // Fetch and upsert customers
    const customers = await getCustomers(client);
    if (customers.length > 0) {
      await upsertData(db.KF_Customers, customers, 'CustomerID', KF_Meta);
    } else {
      logger.info('No customers to save.');
    }

    // Fetch and upsert projects
    const projects = await getProjects(client);
    if (projects.length > 0) {
      await upsertData(db.KF_Projects, projects, 'ID', KF_Meta);
    } else {
      logger.info('No projects to save.');
    }

    // Fetch and upsert quotes
    const quotes = await getQuotes(client);
    if (quotes.length > 0) {
      await upsertData(db.KF_Quotes, quotes, 'InvoiceDBID', KF_Meta);
    } else {
      logger.info('No quotes to save.');
    }

    // Fetch and upsert suppliers
    const suppliers = await getSuppliers(client);
    if (suppliers.length > 0) {
      await upsertData(db.KF_Suppliers, suppliers, 'SupplierID', KF_Meta);
    } else {
      logger.info('No suppliers to save.');
    }

    // Fetch and upsert invoices by date range
    const startDate = new Date('2014-01-01');
    const endDate = new Date();
    const invoices = await getInvoicesByDate(client, startDate, endDate);
    if (invoices.length > 0) {
      await upsertData(db.KF_Invoices, invoices, 'InvoiceDBID', KF_Meta);
    } else {
      logger.info('No invoices to save.');
    }

    // Fetch and upsert receipts
    for (const supplier of suppliers) {
      const receipts = await getReceiptsForSupplier(client, supplier.SupplierID);
      if (receipts.length > 0) {
        await upsertData(db.KF_Receipts, receipts, 'InvoiceDBID', KF_Meta);
      }
    }

    logger.info('Data fetch and upsert completed.');
  } catch (error) {
    logger.error('An error occurred:' + error);
  }
})();

