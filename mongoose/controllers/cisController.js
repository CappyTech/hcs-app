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

    const allPurchases = await mdb.REST.purchase.find({
      Lines: {
        $all: [
          { $elemMatch: { ChargeType: 18685897 } },
          { $elemMatch: { ChargeType: 18685964 } }
        ]
      }
    }).lean();

    const periodStart = moment.tz(currentMonthlyReturn.periodStart, 'Europe/London').startOf('day');
    const periodEnd = moment.tz(currentMonthlyReturn.periodEnd, 'Europe/London').endOf('day');

    const purchases = allPurchases.filter(purchase => {
      return (purchase.Payments || []).some(payment => {
        const payMoment = moment.tz(payment.PayDate, 'Europe/London');
        return payMoment.isBetween(periodStart, periodEnd, null, '[]');
      });
    });

    purchases.forEach(purchase => {
      const pay = purchase.Payments?.[0]?.PayDate;
      if (pay) {
        const payMoment = moment.tz(pay, 'Europe/London');
        purchase.timeZoneTag = payMoment.isDST() ? 'BST' : 'GMT';
        purchase.payDate = slimDateTime(payMoment, ['displayFormat', 'includeTime']);
      } else {
        purchase.timeZoneTag = 'N/A';
        purchase.payDate = 'N/A';
      }
    });

    const supplierIDs = [...new Set(purchases.map(p => p.CustomerID))];
    const suppliers = await mdb.REST.supplier.find({ SupplierID: { $in: supplierIDs } }).sort({ Name: 1 }).lean();

    const supplierTotals = {};
    for (const purchase of purchases) {
      const customerId = String(purchase.CustomerID);
      supplierTotals[customerId] ??= {
        grossAmount: 0,
        materialsCost: 0,
        cisDeductions: 0,
        labourCost: 0,
        reverseChargeVAT: 0,
        reverseChargeNet: 0,
      };

      for (const line of purchase.Lines) {
        const value = parseFloat((line.Rate || 0) * (line.Quantity || 0));
        if (line.ChargeType === 18685896) supplierTotals[customerId].materialsCost += value;
        if (line.ChargeType === 18685897) supplierTotals[customerId].labourCost += value;
        if (line.ChargeType === 18685964) supplierTotals[customerId].cisDeductions += value;
      }

      supplierTotals[customerId].reverseChargeVAT += parseFloat(receipt.CISRCVatAmount || 0);
      supplierTotals[customerId].reverseChargeNet += parseFloat(receipt.CISRCNetAmount || 0);
      supplierTotals[customerId].grossAmount =
        supplierTotals[customerId].materialsCost + supplierTotals[customerId].labourCost;
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
