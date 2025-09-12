const mongoose = require('mongoose');
const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');
const moment = require('moment-timezone');
const taxService = require('../../services/taxService');

exports.renderCISDashboardMongo = async (req, res, next) => {
  try {
    const specifiedYear = parseInt(req.params.year);
    const specifiedMonth = parseInt(req.params.month);

    if (isNaN(specifiedYear) || isNaN(specifiedMonth) || specifiedMonth < 1 || specifiedMonth > 12) {
      return res.status(400).send('Invalid year or month.');
    }

  const taxYear = taxService.getTaxYearStartEnd(specifiedYear);
  const currentMonthlyReturn = taxService.getCurrentMonthlyReturn(specifiedYear, specifiedMonth);

    logger.info(`Rendering CIS Dashboard for Year: ${specifiedYear}, Month: ${specifiedMonth}`);

    // Fetch purchases for the period. Prefer TaxYear/TaxMonth match; fall back to PaidDate/IssuedDate window.
    const purchases = await mdb.REST.purchase.find({
      $or: [
        { TaxYear: specifiedYear, TaxMonth: specifiedMonth },
        { PaidDate: { $gte: new Date(currentMonthlyReturn.periodStart), $lte: new Date(currentMonthlyReturn.periodEnd) } },
        { IssuedDate: { $gte: new Date(currentMonthlyReturn.periodStart), $lte: new Date(currentMonthlyReturn.periodEnd) } }
      ]
    }).lean();

    // Suppliers for those purchases (only subcontractors)
    const supplierIDs = [...new Set(purchases.map(p => p?.SupplierId).filter(id => id != null))];
    const suppliers = await mdb.REST.supplier
      .find({
        Id: { $in: supplierIDs },
        $or: [{ Subcontractor: true }, { IsSubcontractor: true }]
      })
      .sort({ Name: 1 })
      .lean();

    // Restrict purchases to subcontractor suppliers only
    const allowedSupplierIds = new Set(suppliers.map(s => String(s.Id)));
    const filteredPurchases = purchases.filter(p => allowedSupplierIds.has(String(p.SupplierId)));

    // CIS rate map per supplier id
    const cisRateBySupplierId = new Map();
    for (const s of suppliers) {
      const rate = typeof s.CISRate === 'number' ? s.CISRate : null; // null means unknown
      cisRateBySupplierId.set(String(s.Id), rate);
    }

    // Totals per supplier
    const supplierTotals = {};
  for (const purchase of filteredPurchases) {
      const supplierId = String(purchase.SupplierId);
      supplierTotals[supplierId] ??= {
        grossAmount: 0,
        materialsCost: 0,
        cisDeductions: 0,
        calculatedCISDeduction: 0,
        labourCost: 0,
        reverseChargeVAT: 0,
        reverseChargeNet: 0,
      };

      const lines = Array.isArray(purchase.LineItems) && purchase.LineItems.length
        ? purchase.LineItems
        : Array.isArray(purchase.Lines) ? purchase.Lines : [];

      for (const line of lines) {
        if (!line) continue;
        const chargeType = Number(line.ChargeType);
        const qty = Number(line.Quantity) || 0;
        const rate = Number(line.Rate) || 0;
        const amount = line.Amount != null ? Number(line.Amount) : (rate * qty);
        if (chargeType === 18685896) supplierTotals[supplierId].materialsCost += amount;
        if (chargeType === 18685897) supplierTotals[supplierId].labourCost += amount;
        if (chargeType === 18685964) supplierTotals[supplierId].cisDeductions += Math.abs(amount);
      }

      // Reverse charge may not be present on purchases model; keep zero if absent
      supplierTotals[supplierId].reverseChargeVAT += Number(purchase.CISRCVatAmount || 0);
      supplierTotals[supplierId].reverseChargeNet += Number(purchase.CISRCNetAmount || 0);
      supplierTotals[supplierId].grossAmount = supplierTotals[supplierId].materialsCost + supplierTotals[supplierId].labourCost;
    }

    // Compute fallback CIS deduction from labour * CISRate when explicit cis line is zero
    for (const [sid, totals] of Object.entries(supplierTotals)) {
      const rate = cisRateBySupplierId.get(sid);
      totals.calculatedCISDeduction = rate ? totals.labourCost * rate : 0;
    }

    // Submission flags based on purchases
    const allPurchasesSubmitted = filteredPurchases.length > 0 && filteredPurchases.every(
      p => p.SubmissionDate && p.SubmissionDate !== '0000-00-00 00:00:00'
    );
    const submissionDate = allPurchasesSubmitted && filteredPurchases.length > 0 ? filteredPurchases[0].SubmissionDate : null;

    const previousMonth = specifiedMonth === 1 ? 12 : specifiedMonth - 1;
    const previousYear = specifiedMonth === 1 ? specifiedYear - 1 : specifiedYear;
    const nextMonth = specifiedMonth === 12 ? 1 : specifiedMonth + 1;
    const nextYear = specifiedMonth === 12 ? specifiedYear + 1 : specifiedYear;

    const periodEnd = moment(currentMonthlyReturn.periodEndDisplay, 'Do MMMM YYYY');
    const submissionStartDate = periodEnd.clone().date(7).format('Do MMMM YYYY');
    const submissionEndDate = periodEnd.clone().date(11).format('Do MMMM YYYY');

    // Decorate purchases for view list
  const purchasesForView = filteredPurchases.map(p => {
      const payDate = p.PaidDate || p.IssuedDate || null;
      const m = payDate ? moment.tz(payDate, 'Europe/London') : null;
      return {
        ...p,
        payDate: m ? m.format('Do MMM YYYY') : '',
        timeZoneTag: m ? (m.isDST() ? 'BST' : 'GMT') : '',
      };
    });

  res.render(path.join('tailwindcss', 'cis', 'cis'), {
      title: 'CIS Submission Dashboard',
  supplierCount: suppliers.length,
  purchaseCount: filteredPurchases.length,
      suppliers,
      purchases: purchasesForView,
      taxYear,
      taxMonth: specifiedMonth,
      allPurchasesSubmitted,
      submissionDate,
      supplierTotals,
      currentMonthlyReturn,
      previousYear,
      previousMonth,
      nextYear,
      nextMonth,
      submissionStartDate,
      submissionEndDate,
      specifiedYear,
      specifiedMonth,
    });
  } catch (error) {
    logger.error(`Error rendering CIS dashboard Mongo: ${error.message}`, { stack: error.stack });
    req.flash('error', `Error rendering CIS dashboard Mongo: ${error.message}`);
    next(error);
  }
};

exports.redirectCIS = (req, res, next) => {
  const { taxYear, taxMonth } = taxService.calculateTaxYearAndMonth(moment());
  return res.redirect(`/CIS/Dashboard/${taxYear}/${taxMonth}`);
};
