// fetchKashFlowDataMongoose.js
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const authenticate = require('../../kashflowAPI/autoAuth');
const getCustomers = require('../../kashflowAPI/getCustomers');
const getProjects = require('../../kashflowAPI/getProjects');
const getQuotes = require('../../kashflowAPI/getQuotes');
const getSuppliers = require('../../kashflowAPI/getSuppliers');
const getInvoicesByDate = require('../../kashflowAPI/getInvoicesByDate');
const getInvoicePayment = require('../../kashflowAPI/getInvoicePayment');
const getInvoiceNotes = require('../../kashflowAPI/getInvoiceNotes');
const logger = require('../../services/loggerService');
const ChargeTypes = require('../../kashflowAPI/chargeTypes');
const upsertData = require('./upsertDataMongoose');
const promiseLimit = require('promise-limit');
const limit = promiseLimit(3); // Limit to 3 concurrent workers

let isFetching = false;

exports.fetchKashFlowDataMongoose = async (sendUpdate = () => {}) => {
  if (isFetching) return;
  isFetching = true;
  const startfetch = Date.now();
  const operationLog = [];

  try {

    const client = await authenticate('main thread');

    const baseModels = [
      { name: 'customers', fetchFn: getCustomers, model: mdb.customer, uniqueKey: 'CustomerID' },
      { name: 'supplier', fetchFn: getSuppliers, model: mdb.supplier, uniqueKey: 'SupplierID' },
    ];

    for (const { name, fetchFn, model, uniqueKey } of baseModels) {
      const data = await fetchFn(client);
      if (data.length > 0) {
        await upsertData(model, data, uniqueKey, mdb.meta, operationLog, `../logs/${name}.txt`, sendUpdate, startfetch);
      }
    }

    const [completed, active, archived] = await Promise.all([
      getProjects(client, 0), getProjects(client, 1), getProjects(client, 2)
    ]);
    const projects = [...completed, ...active, ...archived];
    if (projects.length > 0) {
      await upsertData(mdb.project, projects, 'ID', mdb.meta, operationLog, '../logs/projects.txt', sendUpdate, startfetch);
    }

    const invoices = await getInvoicesByDate(client, new Date('2014-01-01'), new Date());
    const invoiceTransformed = await Promise.all(invoices.map(async invoice => {
      const payments = await getInvoicePayment(client, invoice.InvoiceNumber);
      const notes = await getInvoiceNotes(client, invoice.InvoiceDBID);
      const mappedLines = invoice.Lines?.anyType?.map(mapLine) || [];
      return { ...invoice, Lines: mappedLines, Payments: payments, notes };
    }));
    await upsertData(mdb.invoice, invoiceTransformed, 'InvoiceDBID', mdb.meta, operationLog, '../logs/invoices.txt', sendUpdate, startfetch);

    const quotes = await getQuotes(client);
    const quoteTransformed = await Promise.all(quotes.map(async quote => {
      const payments = await getInvoicePayment(client, quote.InvoiceNumber);
      const notes = await getInvoiceNotes(client, quote.InvoiceDBID);
      const mappedLines = quote.Lines?.anyType?.map(mapLine) || [];
      return { ...quote, Lines: mappedLines, Payments: payments, notes };
    }));
    await upsertData(mdb.quote, quoteTransformed, 'InvoiceDBID', mdb.meta, operationLog, '../logs/quotes.txt', sendUpdate, startfetch);

    const suppliers = await mdb.supplier.find().lean();

    await Promise.all(
      suppliers.map(supplier => limit(() => new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'workerProcessReceiptsMongoose.js'), {
          workerData: { supplier, startfetch }
        });

        worker.on('message', msg => {
          if (msg.type === 'done') return resolve();
          if (msg.type === 'log') return sendUpdate(`[${msg.timestamp}] [${msg.supplier}] ${msg.log}`);
          if (msg.type === 'error') {
            logger.error(`Worker error for ${supplier.Name}: ${msg.message}`);
            sendUpdate(`❌ Worker error for ${supplier.Name}: ${msg.message}`);
            return reject(new Error(msg.message));
          }
        });

        worker.on('error', reject);
        worker.on('exit', code => {
          if (code !== 0) {
            logger.error(`Worker for ${supplier.Name} exited with code ${code}`);
            reject(new Error(`Worker exited unexpectedly: ${code}`));
          }
        });
      }))
    ));

    logger.info('Data fetch and upsert completed.');
    const logFilename = `fetch-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    await fs.promises.writeFile(path.join(__dirname, '../logs', logFilename), JSON.stringify(operationLog, null, 2));

  } catch (err) {
    logger.error(`Fetch error: ${err.message}`);
  } finally {
    isFetching = false;
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