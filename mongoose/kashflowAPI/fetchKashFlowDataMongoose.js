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
const ChargeTypes = require('../../kashflowAPI/chargeTypes.json');
const upsertData = require('./upsertDataMongoose');
const promiseLimit = require('promise-limit');
const limit = promiseLimit(3);
const mdb = require('../services/mongooseDatabaseService');

const cliProgress = require('cli-progress');
const chalk = require('chalk');
const process = require('process');

let isFetching = false;

exports.fetchKashFlowDataMongoose = async (sendUpdate = () => {}) => {
  if (isFetching) return;
  isFetching = true;
  const startfetch = Date.now();
  const operationLog = [];
  const workerErrors = [];

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
    let completedSuppliers = 0;
    const totalSuppliers = suppliers.length;

    // ✅ CLI progress bar
    const progressBar = new cliProgress.SingleBar({
      format: chalk.blue('{bar}') + ` {percentage}% | {value}/{total} suppliers`,
      barCompleteChar: '█',
      barIncompleteChar: '░',
      hideCursor: true
    });
    progressBar.start(totalSuppliers, 0);

    await Promise.all(
      suppliers.map(supplier =>
        limit(() =>
          new Promise((resolve, reject) => {
            const worker = new Worker(path.join(__dirname, 'workerProcessReceiptsMongoose.js'), {
              workerData: { supplier, startfetch }
            });

            worker.on('message', msg => {
              if (msg.type === 'done') {
                completedSuppliers++;
                progressBar.update(completedSuppliers);
                sendUpdate(`✅ ${msg.supplier} (${msg.count} receipts, ${msg.duration}ms)`);
                sendUpdate(`📊 Progress: ${completedSuppliers}/${totalSuppliers}`);
                process.stdout.write('\x07'); // ✅ sound on complete
                return resolve();
              }
              if (msg.type === 'log') sendUpdate(`[${msg.timestamp}] [${msg.supplier}] ${msg.log}`);
              if (msg.type === 'error') {
                workerErrors.push({ supplier: supplier.Name, message: msg.message });
                sendUpdate(`❌ Worker error for ${supplier.Name}: ${msg.message}`);
                process.stdout.write('\x07'); // ✅ sound on error
                return resolve();
              }
            });

            worker.on('error', err => {
              process.stdout.write('\x07');
              reject(err);
            });
            worker.on('exit', code => {
              if (code !== 0) {
                process.stdout.write('\x07');
                reject(new Error(`Worker exited unexpectedly: ${code}`));
              }
            });
          })
        )
      )
    );

    progressBar.stop();
    process.stdout.write('\x07'); // ✅ final bell

    if (workerErrors.length > 0) {
      sendUpdate(`⚠️ ${workerErrors.length} suppliers failed.`);
      workerErrors.forEach(err => sendUpdate(`❌ ${err.supplier}: ${err.message}`));
    }

    sendUpdate('✅ Mongoose fetch complete.');
    const logFilename = `fetch-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    await fs.promises.writeFile(path.join(__dirname, '../logs', logFilename), JSON.stringify(operationLog, null, 2));

  } catch (err) {
    process.stdout.write('\x07');
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
