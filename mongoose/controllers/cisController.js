const mongoose = require('mongoose');
const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');
const moment = require('moment-timezone');
const taxService = require('../../services/taxService');
const cisMappings = require('../config/cisMappings');

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
      $and: [
        { $or: [
          { deletedAt: null },
          { deletedAt: { $exists: false } },
          { deletedAt: '' },
          { deletedAt: '0000-00-00 00:00:00' }
        ] },
        { $or: [
          { TaxYear: specifiedYear, TaxMonth: specifiedMonth },
          { PaidDate: { $gte: new Date(currentMonthlyReturn.periodStart), $lte: new Date(currentMonthlyReturn.periodEnd) } },
          { IssuedDate: { $gte: new Date(currentMonthlyReturn.periodStart), $lte: new Date(currentMonthlyReturn.periodEnd) } }
        ] }
      ]
    }).lean();

    // Only paid purchases are allowed in CIS: consider paid if has PaymentLines or PaidDate present
    const paidPurchases = purchases.filter(p => (Array.isArray(p.PaymentLines) && p.PaymentLines.length > 0) || !!p.PaidDate);

    // Suppliers for those purchases (only subcontractors)
  const supplierIDs = [...new Set(paidPurchases.map(p => p?.SupplierId).filter(id => id != null))];
    const suppliers = await mdb.REST.supplier
      .find({
        Id: { $in: supplierIDs },
        $or: [{ Subcontractor: true }, { IsSubcontractor: true }]
      })
      .sort({ Name: 1 })
      .lean();

    // Restrict purchases to subcontractor suppliers only
  const allowedSupplierIds = new Set(suppliers.map(s => String(s.Id)));
  const filteredPurchases = paidPurchases.filter(p => allowedSupplierIds.has(String(p.SupplierId)));

    // CIS rate map per supplier id
    const cisRateBySupplierId = new Map();
    for (const s of suppliers) {
      const rate = typeof s.CISRate === 'number' ? s.CISRate : null; // null means unknown
      cisRateBySupplierId.set(String(s.Id), rate);
    }

  // Totals per supplier
  const supplierTotals = {};
  const cisDebug = process.env.CIS_DEBUG_NOMINALS === 'true';
  const nominalCodeCounts = new Map();
  const nominalNameCounts = new Map();
  const debugStats = { usedLineItems: 0, usedLines: 0, emptyLines: 0 };
  const debugSamples = [];
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

      const hasLineItems = Array.isArray(purchase.LineItems) && purchase.LineItems.length > 0;
      const hasLines = Array.isArray(purchase.Lines) && purchase.Lines.length > 0;
      const lines = hasLineItems ? purchase.LineItems : hasLines ? purchase.Lines : [];
      if (cisDebug) {
        if (hasLineItems) debugStats.usedLineItems++;
        else if (hasLines) debugStats.usedLines++;
        else debugStats.emptyLines++;
        if (debugSamples.length < 5) {
          const sample = {
            purchaseId: purchase.Id || purchase.uuid || purchase.Number,
            hasLineItems,
            hasLines,
            lineItemsLen: hasLineItems ? purchase.LineItems.length : 0,
            linesLen: hasLines ? purchase.Lines.length : 0,
            firstLineKeys: lines[0] ? Object.keys(lines[0]) : []
          };
          debugSamples.push(sample);
        }
      }

      for (const line of lines) {
        if (!line) continue;
        if (cisDebug) {
          if (line.NominalCode != null) {
            const code = Number(line.NominalCode);
            nominalCodeCounts.set(code, (nominalCodeCounts.get(code) || 0) + 1);
          }
          if (line.NominalName) {
            const name = String(line.NominalName).trim();
            if (name) nominalNameCounts.set(name, (nominalNameCounts.get(name) || 0) + 1);
          }
        }
        const chargeType = line.ChargeType != null ? Number(line.ChargeType) : null;
        const qty = Number(line.Quantity) || 0;
        const rate = Number(line.Rate) || 0;
        const amount = line.Amount != null ? Number(line.Amount) : (rate * qty);

        // Primary: SOAP charge types if present
        if (chargeType === 18685896) { supplierTotals[supplierId].materialsCost += amount; continue; }
        if (chargeType === 18685897) { supplierTotals[supplierId].labourCost += amount; continue; }
        if (chargeType === 18685964) { supplierTotals[supplierId].cisDeductions += Math.abs(amount); continue; }

        // REST heuristic classification
        const nc = Number(line.NominalCode) || null;
        const nn = (line.NominalName || line.Description || '').toString().toLowerCase();
        if (nc && cisMappings.materialsNominalCodes.includes(nc)) {
          supplierTotals[supplierId].materialsCost += amount;
          continue;
        }
        if (nc && cisMappings.labourNominalCodes.includes(nc)) {
          supplierTotals[supplierId].labourCost += amount;
          continue;
        }
        if (nc && Array.isArray(cisMappings.cisDeductionNominalCodes) && cisMappings.cisDeductionNominalCodes.includes(nc)) {
          supplierTotals[supplierId].cisDeductions += Math.abs(amount);
          continue;
        }
        // Fallback by name hints
        if (nn.includes('material')) {
          supplierTotals[supplierId].materialsCost += amount;
          continue;
        }
        if (nn.includes('labour') || nn.includes('labor') || nn.includes('subcontract')) {
          supplierTotals[supplierId].labourCost += amount;
          continue;
        }

      }

      // Emit debug log if enabled
      if (cisDebug) {
        const codesSorted = Array.from(nominalCodeCounts.entries()).sort((a,b)=>b[1]-a[1]).map(([code,count])=>({ code, count }));
        const namesSorted = Array.from(nominalNameCounts.entries()).sort((a,b)=>b[1]-a[1]).map(([name,count])=>({ name, count }));
        const summary = {
          year: specifiedYear,
          month: specifiedMonth,
          suppliersConsidered: suppliers.length,
          purchasesConsidered: filteredPurchases.length,
          topNominalCodes: codesSorted.slice(0, 20),
          topNominalNames: namesSorted.slice(0, 20),
          usedLineItems: debugStats.usedLineItems,
          usedLines: debugStats.usedLines,
          emptyLines: debugStats.emptyLines,
          samples: debugSamples
        };
        // File transport keeps meta; console prints the message only, so include JSON in message too
        logger.info('[CIS_DEBUG_NOMINALS] ' + JSON.stringify(summary));
        logger.info('[CIS_DEBUG_NOMINALS] Distinct NominalCodes and NominalNames (full)', {
          year: summary.year,
          month: summary.month,
          suppliersConsidered: summary.suppliersConsidered,
          purchasesConsidered: summary.purchasesConsidered,
          nominalCodes: codesSorted.slice(0, 100),
          nominalNames: namesSorted.slice(0, 100)
        });
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

  // Use the actual Date for periodEnd to avoid double-formatting and preserve type for slimDateTime
  const periodEnd = moment(currentMonthlyReturn.periodEnd);
  const submissionStartDate = periodEnd.clone().date(7).toDate();
  const submissionEndDate = periodEnd.clone().date(11).toDate();

    // Decorate purchases for view list
  const purchasesForView = filteredPurchases.map(p => {
      const isPaid = (Array.isArray(p.PaymentLines) && p.PaymentLines.length > 0) || !!p.PaidDate;
      const displayDateRaw = isPaid ? (p.PaidDate || p.IssuedDate || null) : (p.IssuedDate || null);
      const m = displayDateRaw ? moment.tz(displayDateRaw, 'Europe/London') : null;
      const due = p.DueDate ? moment.tz(p.DueDate, 'Europe/London') : null;
      return {
        ...p,
        isPaid,
        displayDateLabel: isPaid ? 'Paid' : 'Issued',
        displayDate: m ? m.format('Do MMM YYYY') : '',
        timeZoneTag: m ? (m.isDST() ? 'BST' : 'GMT') : '',
        dueDateStr: due ? due.format('Do MMM YYYY') : '',
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
