const { parentPort, workerData } = require('worker_threads');
const authenticate = require('../../kashflowAPI/autoAuth');
const taxService = require('../../services/taxService');
const logger = require('../../services/loggerService');
const mdb = require('../services/mongooseDatabaseService');
const getReceiptsForSupplier = require('../../kashflowAPI/getReceiptsForSupplier');
const getReceiptPayment = require('../../kashflowAPI/getReceiptPayment');
const getReceiptNotes = require('../../kashflowAPI/getReceiptNotes');
const normalizePayments = require('../../services/kashflowNormalizer').normalizePayments;
const ChargeTypes = require('../../kashflowAPI/chargeTypes.json');

function reportProgress(log) {
  if (parentPort) {
    parentPort.postMessage({
      type: 'log',
      timestamp: new Date().toISOString(),
      supplier: supplier?.Name || 'Unknown',
      log
    });
  }
}

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

(async () => {
  const { supplier, startfetch } = workerData;

  if (!supplier) {
    logger.error('❌ This script must be run with supplier in workerData');
    process.exit(1);
  }

  try {
    await mdb.connect();
    reportProgress(`🔌 Connected to MongoDB`);

    const client = await authenticate(`worker thread - working on: ${supplier.Name}`);
    reportProgress(`🔐 Authenticated`);

    reportProgress(`🔍 Fetching receipts for SupplierID ${supplier.SupplierID}`);
    const receipts = await getReceiptsForSupplier(client, supplier.SupplierID);
    reportProgress(`📦 Retrieved ${receipts.length} receipts`);

    const transformedReceipts = await Promise.all(receipts.map(async (receipt, index) => {
      const payments = await getReceiptPayment(client, receipt.InvoiceNumber);
      const notes = await getReceiptNotes(client, receipt.InvoiceDBID);
      const mappedLines = receipt.Lines?.anyType?.map(mapLine) || [];
      const flattenedPayments = normalizePayments(payments);

      let taxYear, taxMonth;
      if (flattenedPayments.length && flattenedPayments[0]?.PayDate) {
        ({ taxYear, taxMonth } = taxService.calculateTaxYearAndMonth(flattenedPayments[0].PayDate));
      }

      reportProgress(`🧾 Processed receipt ${index + 1}/${receipts.length} (Invoice ${receipt.InvoiceNumber})`);

      return {
        ...receipt,
        Lines: mappedLines,
        Payments: flattenedPayments,
        TaxMonth: taxMonth,
        TaxYear: taxYear,
        notes,
      };
    }));

    reportProgress(`💾 Upserting ${transformedReceipts.length} receipts...`);

    for (const receipt of transformedReceipts) {
      await mdb.receipt.updateOne(
        { InvoiceDBID: receipt.InvoiceDBID },
        { $set: receipt },
        { upsert: true }
      );
    }

    reportProgress(`✅ All receipts upserted successfully.`);

    if (parentPort) {
      parentPort.postMessage({
        type: 'done',
        supplier: supplier.Name,
        count: transformedReceipts.length,
        duration: Date.now() - startfetch
      });
    }

    process.exit(0);
  } catch (err) {
    const msg = `❌ Error processing ${supplier.Name}: ${err.message}`;
    logger.error(msg);
    if (parentPort) parentPort.postMessage({ type: 'error', message: err.message });
    process.exit(1);
  }
})();
