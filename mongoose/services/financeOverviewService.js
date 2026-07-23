import mdb from './mongooseDatabaseService.js';

async function getFinanceOverview({ recentLimit = 10 } = {}) {
  const Invoice = mdb.REST?.invoice;
  const Purchase = mdb.REST?.purchase;

  if (!Invoice) throw new Error('Invoice model not loaded');
  if (!Purchase) throw new Error('Purchase model not loaded');

  const now = new Date();

  // ── Invoice aggregations ───────────────────────────────────────────────────
  const [allInvoices, recentInvoices, overdueInvoices] = await Promise.all([
    Invoice.aggregate([
      {
        $group: {
          _id: '$Status',
          count: { $sum: 1 },
          totalGross: { $sum: '$GrossAmount' },
          totalPaid: { $sum: '$AmountPaid' },
          totalDue: { $sum: '$DueAmount' },
        },
      },
    ]),
    Invoice.find({ IsArchived: { $ne: true } })
      .sort({ IssuedDate: -1 })
      .limit(recentLimit)
      .select('uuid Number CustomerName IssuedDate DueDate GrossAmount AmountPaid DueAmount Status')
      .lean(),
    Invoice.find({
      DueDate: { $lt: now },
      Status: { $nin: ['Paid', 'Credited'] },
      IsArchived: { $ne: true },
    })
      .sort({ DueDate: 1 })
      .select('uuid Number CustomerName DueDate GrossAmount DueAmount Status OverdueDays')
      .lean(),
  ]);

  // Flatten invoice status counts
  const invoiceByStatus = {};
  let invoiceTotalGross = 0;
  let invoiceTotalDue = 0;
  for (const row of allInvoices) {
    const status = row._id || 'Unknown';
    invoiceByStatus[status] = { count: row.count, totalGross: row.totalGross || 0, totalDue: row.totalDue || 0 };
    invoiceTotalGross += row.totalGross || 0;
    invoiceTotalDue += row.totalDue || 0;
  }
  const invoiceTotalCount = allInvoices.reduce((s, r) => s + r.count, 0);

  // ── Purchase aggregations ──────────────────────────────────────────────────
  const [allPurchases, recentPurchases, overduePurchases] = await Promise.all([
    Purchase.aggregate([
      {
        $group: {
          _id: '$Status',
          count: { $sum: 1 },
          totalGross: { $sum: '$GrossAmount' },
        },
      },
    ]),
    Purchase.find({})
      .sort({ IssuedDate: -1 })
      .limit(recentLimit)
      .select('uuid Number SupplierName IssuedDate DueDate GrossAmount TotalPaidAmount Status')
      .lean(),
    Purchase.find({
      DueDate: { $lt: now },
      Status: { $nin: ['Paid'] },
    })
      .sort({ DueDate: 1 })
      .select('uuid Number SupplierName DueDate GrossAmount Status OverdueDays')
      .lean(),
  ]);

  const purchaseByStatus = {};
  let purchaseTotalGross = 0;
  for (const row of allPurchases) {
    const status = row._id || 'Unknown';
    purchaseByStatus[status] = { count: row.count, totalGross: row.totalGross || 0 };
    purchaseTotalGross += row.totalGross || 0;
  }
  const purchaseTotalCount = allPurchases.reduce((s, r) => s + r.count, 0);

  return {
    invoiceTotalCount,
    invoiceTotalGross,
    invoiceTotalDue,
    invoiceByStatus,
    recentInvoices,
    overdueInvoices,
    purchaseTotalCount,
    purchaseTotalGross,
    purchaseByStatus,
    recentPurchases,
    overduePurchases,
    recentLimit,
  };
}

export default { getFinanceOverview };
