const mongoose = require('mongoose');
const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');
const moment = require('moment-timezone');
const taxService = require('../../services/taxService');
const { slimDateTime } = require('../../services/dateService');

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

    const periodStart = moment.tz(currentMonthlyReturn.periodStart, 'Europe/London').startOf('day');
    const periodEnd = moment.tz(currentMonthlyReturn.periodEnd, 'Europe/London').endOf('day');

    // Only include suppliers flagged as subcontractors, fetch CISRate too
    const subcontractors = await mdb.REST.supplier
      .find({ $or: [{ IsSubcontractor: true }, { Subcontractor: true }] })
      .select('Id Name CISRate')
      .lean();
    const subcontractorIdSet = new Set(subcontractors.map(s => String(s.Id)));

    // Pull purchases for the specified tax period, matching either stored TaxYear/TaxMonth
    // or by PaidDate/IssuedDate falling within the period window.
    const candidatePurchases = await mdb.REST.purchase.find({
      SupplierId: { $in: Array.from(subcontractorIdSet) },
      $or: [
        { TaxYear: specifiedYear, TaxMonth: specifiedMonth },
        { PaidDate: { $gte: periodStart.toDate(), $lte: periodEnd.toDate() } },
        { IssuedDate: { $gte: periodStart.toDate(), $lte: periodEnd.toDate() } }
      ]
    }).lean();

    // Filter within bounds using PaidDate first, then IssuedDate fallback
    const purchases = candidatePurchases.filter(purchase => {
      const date = purchase.PaidDate || purchase.IssuedDate;
      if (!date) return false;
      const d = moment.tz(date, 'Europe/London');
      const inPeriod = d.isBetween(periodStart, periodEnd, null, '[]');
      const isSubcontractor = subcontractorIdSet.has(String(purchase.SupplierId));
      return inPeriod && isSubcontractor;
    });

    purchases.forEach(purchase => {
      const pay = purchase.PaidDate || purchase.IssuedDate || null;
      if (pay) {
        const payMoment = moment.tz(pay, 'Europe/London');
        purchase.timeZoneTag = payMoment.isDST() ? 'BST' : 'GMT';
        purchase.payDate = slimDateTime(payMoment, ['displayFormat', 'includeTime']);
      } else {
        purchase.timeZoneTag = 'N/A';
        purchase.payDate = 'N/A';
      }
    });
  const supplierIDs = [...new Set(purchases.map(p => String(p.SupplierId)))];
  // Limit the suppliers list to subcontractors who have purchases in this period
  const suppliers = subcontractors
    .filter(s => supplierIDs.includes(String(s.Id)))
    .sort((a, b) => (a.Name || '').localeCompare(b.Name || ''));

    const supplierTotals = {};
    // Build a lookup for CISRate by supplierId
    const cisRateBySupplierId = {};
    subcontractors.forEach(s => {
      cisRateBySupplierId[String(s.Id)] = typeof s.CISRate === 'number' ? s.CISRate : 0.2;
    });

    for (const purchase of purchases) {
      const supplierId = String(purchase.SupplierId);
      supplierTotals[supplierId] ??= {
        grossAmount: 0,
        materialsCost: 0,
        cisDeductions: 0,
        labourCost: 0,
        reverseChargeVAT: 0,
        reverseChargeNet: 0,
        calculatedCISDeduction: 0,
      };

      for (const line of purchase.LineItems || []) {
        const value = parseFloat((line.Rate || 0) * (line.Quantity || 0));
        if (line.ChargeType === 18685896) supplierTotals[supplierId].materialsCost += value;
        if (line.ChargeType === 18685897) supplierTotals[supplierId].labourCost += value;
        if (line.ChargeType === 18685964) supplierTotals[supplierId].cisDeductions += value;
      }

      supplierTotals[supplierId].reverseChargeVAT += parseFloat(purchase.CISRCVatAmount || 0);
      supplierTotals[supplierId].reverseChargeNet += parseFloat(purchase.CISRCNetAmount || 0);
      supplierTotals[supplierId].grossAmount =
        supplierTotals[supplierId].materialsCost + supplierTotals[supplierId].labourCost;

      // Calculate CIS deduction using supplier CISRate
      const cisRate = cisRateBySupplierId[supplierId] ?? 0.2;
      supplierTotals[supplierId].calculatedCISDeduction = supplierTotals[supplierId].labourCost * cisRate;
    }

    const allPurchasesSubmitted = purchases.every(
      p => p.SubmissionDate && p.SubmissionDate !== '0000-00-00 00:00:00'
    );
    const submissionDate = allPurchasesSubmitted && purchases.length > 0 ? purchases[0].SubmissionDate : null;

    const previousMonth = specifiedMonth === 1 ? 12 : specifiedMonth - 1;
    const previousYear = specifiedMonth === 1 ? specifiedYear - 1 : specifiedYear;
    const nextMonth = specifiedMonth === 12 ? 1 : specifiedMonth + 1;
    const nextYear = specifiedMonth === 12 ? specifiedYear + 1 : specifiedYear;

    const periodEndMoment = moment(currentMonthlyReturn.periodEnd).tz('Europe/London');
    const submissionStartDate = periodEndMoment.clone().date(7);
    const submissionEndDate = periodEndMoment.clone().date(11);

    res.render(path.join('tailwindcss', 'cis', 'cis'), {
      title: 'CIS Submission Dashboard',
      supplierCount: suppliers.length,
      purchaseCount: purchases.length,
      suppliers,
      purchases,
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
