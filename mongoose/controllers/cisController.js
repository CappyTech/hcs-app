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

    const receipts = await mdb.receipt.find({
      Payments: {
        $elemMatch: {
          PayDate: {
            $gte: new Date(currentMonthlyReturn.periodStart),
            $lte: new Date(currentMonthlyReturn.periodEnd),
          },
        },
      },
      Lines: {
        $all: [
          { $elemMatch: { ChargeType: 18685897 } },
          { $elemMatch: { ChargeType: 18685964 } }
        ]
      }
    }).lean();

    const supplierIDs = [...new Set(receipts.map(r => r.CustomerID))];
    const suppliers = await mdb.supplier.find({ SupplierID: { $in: supplierIDs } }).sort({ Name: 1 }).lean();

    const supplierTotals = {};
    for (const receipt of receipts) {
      const customerId = String(receipt.CustomerID);
      supplierTotals[customerId] ??= {
        grossAmount: 0,
        materialsCost: 0,
        cisDeductions: 0,
        labourCost: 0,
        reverseChargeVAT: 0,
        reverseChargeNet: 0,
      };

      for (const line of receipt.Lines) {
        const value = parseFloat(line.Rate * line.Quantity || 0);
        if (line.ChargeType === 18685896) supplierTotals[customerId].materialsCost += value;
        if (line.ChargeType === 18685897) supplierTotals[customerId].labourCost += value;
        if (line.ChargeType === 18685964) supplierTotals[customerId].cisDeductions += value;
      }

      supplierTotals[customerId].reverseChargeVAT += parseFloat(receipt.CISRCVatAmount || 0);
      supplierTotals[customerId].reverseChargeNet += parseFloat(receipt.CISRCNetAmount || 0);
      supplierTotals[customerId].grossAmount =
        supplierTotals[customerId].materialsCost + supplierTotals[customerId].labourCost;
    }

    const allReceiptsSubmitted = receipts.every(
      r => r.SubmissionDate && r.SubmissionDate !== '0000-00-00 00:00:00'
    );
    const submissionDate = allReceiptsSubmitted && receipts.length > 0 ? receipts[0].SubmissionDate : null;

    const previousMonth = specifiedMonth === 1 ? 12 : specifiedMonth - 1;
    const previousYear = specifiedMonth === 1 ? specifiedYear - 1 : specifiedYear;
    const nextMonth = specifiedMonth === 12 ? 1 : specifiedMonth + 1;
    const nextYear = specifiedMonth === 12 ? specifiedYear + 1 : specifiedYear;

    const periodEnd = moment(currentMonthlyReturn.periodEndDisplay, 'Do MMMM YYYY');
    const submissionStartDate = periodEnd.clone().date(7).format('Do MMMM YYYY');
    const submissionEndDate = periodEnd.clone().date(11).format('Do MMMM YYYY');

    res.render(path.join('mongoose', 'cis'), {
      title: 'CIS Submission Dashboard',
      supplierCount: suppliers.length,
      receiptCount: receipts.length,
      suppliers,
      receipts,
      taxYear,
      taxMonth: specifiedMonth,
      allReceiptsSubmitted,
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
  return res.redirect(`/CIS/${taxYear}/${taxMonth}`);
};
