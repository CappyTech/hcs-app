const { parentPort, workerData } = require('worker_threads');
const authenticate = require('../autoAuth');
const taxService = require('../../services/taxService');
const logger = require('../../services/loggerService');
const mdb = require('../../services/mongoose/mongooseDatabaseService');
const getReceiptsForSupplier = require('../getReceiptsForSupplier');
const getReceiptPayment = require('../getReceiptPayment');
const getReceiptNotes = require('../getReceiptNotes');
const normalizePayments = require('../../services/kashflowNormalizer').normalizePayments;
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
const ChargeTypes = require('../../controllers/CRUD/kashflow/chargeTypes.json');

(async () => {
  if (!workerData || !workerData.supplier) {
    logger.error('❌ This script must be run as a worker with workerData.supplier');
    process.exit(1);
  }

  const supplier = workerData.supplier;
  const startfetch = workerData.startfetch;

  try {
    await mdb.connect();
  } catch (err) {
    logger.error('❌ Failed to connect to MongoDB: ' + err.message);
    process.exit(1);
  }

  try {
    const context = `worker thread - working on: ${supplier.Name}`;
    const client = await authenticate(context);
    const receipts = await getReceiptsForSupplier(client, supplier.SupplierID);

    const transformedReceipts = await Promise.all(receipts.map(async (receipt) => {
      const payments = await getReceiptPayment(client, receipt.InvoiceNumber);
      const notes = await getReceiptNotes(client, receipt.InvoiceDBID);

      const mappedLines = receipt.Lines?.anyType?.map(mapLine) || [];
      const flattenedPayments = normalizePayments(payments);

      let taxYear, taxMonth;
      if (flattenedPayments.length && flattenedPayments[0]?.PayDate) {
        ({ taxYear, taxMonth } = taxService.calculateTaxYearAndMonth(flattenedPayments[0].PayDate));
      }

      return {
        ...receipt,
        Lines: mappedLines,
        Payments: flattenedPayments,
        TaxMonth: taxMonth,
        TaxYear: taxYear,
        notes,
      };
    }));

    for (const receipt of transformedReceipts) {
      try {
        await mdb.receipt.updateOne(
          { InvoiceDBID: receipt.InvoiceDBID },
          { $set: receipt },
          { upsert: true }
        );
      } catch (err) {
        logger.error(`❌ Failed to upsert receipt ${receipt.InvoiceDBID}: ${err.message}`);
        if (parentPort) parentPort.postMessage({ type: 'error', message: err.message });
        process.exit(1);
      }
    }

    if (parentPort) {
      parentPort.postMessage({ type: 'done', result: transformedReceipts });
    }

    process.exit(0); // ✅ important!
  } catch (err) {
    const errMsg = `❌ Error processing receipts for ${supplier.Name}: ${err.message}`;
    logger.error(errMsg);
    if (parentPort) parentPort.postMessage({ type: 'error', message: err.message });
    process.exit(1);
  }
})();