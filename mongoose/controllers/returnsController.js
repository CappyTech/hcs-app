const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const moment = require('moment-timezone');
const normalizePayments = require('../../services/kashflowNormalizer');

const monthNames = [
  'April','May','June','July','August','September',
  'October','November','December','January','February','March'
];

exports.renderMonthlyReturnsForm = async (req, res, next) => {
  try {
    // Include CISRate (Number), isReverseCharge flag and uuid used by the view
    const suppliers = await mdb.REST.supplier
      .find({ IsSubcontractor: true })
      .select('Id Name CISRate isReverseCharge uuid')
      .lean();
    const suppliersWithMonths = [];

    for (const supplier of suppliers) {
      const purchases = await mdb.REST.purchase
        .find({ SupplierId: supplier.Id })
        .select('TaxYear TaxMonth IssuedDate PaidDate')
        .lean();

      const receiptsByYear = {};
      purchases.forEach(p => {
        // Prefer explicit tax fields; fallback to PaidDate then IssuedDate
        const year = p.TaxYear || (p.PaidDate ? moment(p.PaidDate).year() : (p.IssuedDate ? moment(p.IssuedDate).year() : null));
        const month = p.TaxMonth || (p.PaidDate ? moment(p.PaidDate).month() + 1 : (p.IssuedDate ? moment(p.IssuedDate).month() + 1 : null));
        if (!year || !month) return;
        if (!receiptsByYear[year]) receiptsByYear[year] = [];
        if (!receiptsByYear[year].includes(month)) {
          receiptsByYear[year].push(month);
          receiptsByYear[year].sort((a, b) => a - b);
        }
      });

      suppliersWithMonths.push({
        supplier,
        years: Object.keys(receiptsByYear).sort((a, b) => b - a),
        receiptsByYear
      });
    }

    res.render(path.join('tailwindcss', 'cis', 'monthlyReturnsForm'), {
      title: 'Monthly Returns Form',
      suppliersWithMonths,
      monthNames
    });
  } catch (err) {
    next(err);
  }
};

exports.renderMonthlyReturnsForOne = async (req, res, next) => {
  try {
    const { year, uuid } = req.params;
    if (!year || !uuid) return res.status(400).send('Year and Supplier UUID required');

    const supplier = await mdb.REST.supplier.findOne({ uuid }).select('Id Name').lean();
    if (!supplier) return res.status(404).send('Subcontractor not found');

    const purchases = await mdb.REST.purchase.find({ SupplierId: supplier.Id, TaxYear: year }).sort({ Number: 1 }).lean();
    const receiptsByMonth = {};

    purchases.forEach(purchase => {
      const month = purchase.TaxMonth || (purchase.PaidDate ? moment(purchase.PaidDate).month() + 1 : (purchase.IssuedDate ? moment(purchase.IssuedDate).month() + 1 : null));
      if (!month) return;
      if (!receiptsByMonth[month]) receiptsByMonth[month] = [];

      const lines = Array.isArray(purchase.LineItems) ? purchase.LineItems : [];
      const labourCost = lines.filter(l => l.ChargeType === 18685897).reduce((s, l) => s + ((+l.Rate) * (+l.Quantity) || 0), 0);
      const materialCost = lines.filter(l => l.ChargeType === 18685896).reduce((s, l) => s + ((+l.Rate) * (+l.Quantity) || 0), 0);
      const cisAmount = Math.abs(lines.filter(l => l.ChargeType === 18685964).reduce((s, l) => s + ((+l.Rate) * (+l.Quantity) || 0), 0));
      const grossAmount = labourCost + materialCost;
      const netAmount = grossAmount - cisAmount;

      const payDate = purchase.PaidDate || null;

      receiptsByMonth[month].push({
        InvoiceNumber: purchase.Number,
        KashflowNumber: purchase.Number,
        InvoiceDate: purchase.IssuedDate,
        PayDate: payDate,
        GrossAmount: grossAmount,
        LabourCost: labourCost,
        MaterialCost: materialCost,
        CISAmount: cisAmount,
        NetAmount: netAmount,
        SubmissionDate: purchase.SubmissionDate,
        TaxMonth: purchase.TaxMonth,
        TaxYear: purchase.TaxYear,
        ReverseCharge: purchase.CISRCVatAmount || 0
      });
    });

    res.render(path.join('tailwindcss', 'cis', 'monthlyReturnsForOne'), {
      title: `Monthly Returns for ${supplier.Name}`,
      year,
      supplier,
      receiptsByMonth,
      monthNames,
      pageBreakMonths: []
    });
  } catch (err) {
    next(err);
  }
};

exports.renderMonthlyReturnsForAll = async (req, res, next) => {
  try {
    const { month, year } = req.params;
    if (!month || !year) return res.status(400).send('Month and Year required');

    const suppliers = await mdb.REST.supplier.find({ IsSubcontractor: true }).lean();
    const subcontractors = [];

    for (const supplier of suppliers) {
      const purchases = await mdb.REST.purchase.find({
        SupplierId: supplier.Id,
        TaxYear: year,
        TaxMonth: +month
      }).sort({ Number: 1 }).lean();

      if (purchases.length === 0) continue;

      const invoices = purchases.map(purchase => {
        const lines = Array.isArray(purchase.LineItems) ? purchase.LineItems : [];
        const payDate = purchase.PaidDate || null;

        const labourCost = lines.filter(l => l.ChargeType === 18685897).reduce((s, l) => s + ((+l.Rate) * (+l.Quantity) || 0), 0);
        const materialCost = lines.filter(l => l.ChargeType === 18685896).reduce((s, l) => s + ((+l.Rate) * (+l.Quantity) || 0), 0);
        const cisAmount = Math.abs(lines.filter(l => l.ChargeType === 18685964).reduce((s, l) => s + ((+l.Rate) * (+l.Quantity) || 0), 0));
        const grossAmount = labourCost + materialCost;
        const netAmount = grossAmount - cisAmount;

        return {
          invoiceNumber: purchase.Number,
          kashflowNumber: purchase.Number,
          invoiceDate: purchase.IssuedDate,
          remittanceDate: payDate,
          grossAmount,
          labourCost,
          materialCost,
          cisAmount,
          netAmount,
          reverseCharge: purchase.CISRCVatAmount || 0,
          submissionDate: purchase.SubmissionDate,
          month: purchase.TaxMonth,
          year: purchase.TaxYear
        };
      });

      subcontractors.push({
        name: supplier.Name,
        company: supplier.CompanyName || '',
        cisNumber: supplier.CISNumber || '',
        utrNumber: supplier.UTRNumber || '',
        deduction: parseFloat(supplier.CISRate || '0'),
        isGross: supplier.CISRate === '0',
        isReverseCharge: supplier.isReverseCharge,
        invoices
      });
    }

    res.render(path.join('tailwindcss', 'cis', 'monthlyReturnsForAll'), {
      title: `Monthly Returns for Month ${month}, ${year}`,
      month,
      year,
      subcontractors,
      monthName: monthNames[+month - 1]
    });
  } catch (err) {
    next(err);
  }
};

exports.renderMonthlyReturns = async (req, res, next) => {
  try {
    const { month, year, uuid } = req.params;
    if (!month || !year || !uuid) return res.status(400).send('Month, Year and Supplier UUID required');
    const supplier = await mdb.REST.supplier.findOne({ uuid }).lean();
    if (!supplier) {
      req.flash('error', 'Supplier not found.');
      return res.redirect('/suppliers');
    }
    const receipts = await mdb.REST.purchase.find({ SupplierId: supplier.Id, TaxYear: year, TaxMonth: +month }).sort({ Number: 1 }).lean();
    const receiptsByMonth = {};
    receipts.forEach(receipt => {
      const m = receipt.TaxMonth || (receipt.PaidDate ? moment(receipt.PaidDate).month() + 1 : (receipt.IssuedDate ? moment(receipt.IssuedDate).month() + 1 : null));
      if(!receiptsByMonth[m]) receiptsByMonth[m]=[];
      const lines = Array.isArray(receipt.LineItems) ? receipt.LineItems : [];
      const labourCost = lines.filter(l => l.ChargeType === 18685897).reduce((s, l) => s + (((+l.Rate) * (+l.Quantity)) || 0), 0);
      const materialCost = lines.filter(l => l.ChargeType === 18685896).reduce((s, l) => s + (((+l.Rate) * (+l.Quantity)) || 0), 0);
      const cisAmount = Math.abs(lines.filter(l => l.ChargeType === 18685964).reduce((s, l) => s + (((+l.Rate) * (+l.Quantity)) || 0), 0));
      const grossAmount = labourCost + materialCost;
      const netAmount = grossAmount - cisAmount;
      const payDates = receipt.PaidDate ? [receipt.PaidDate] : [];
      const payDate = payDates.length > 0 ? payDates[0] : null;
      receiptsByMonth[m].push({
        InvoiceNumber: receipt.Number,
        KashflowNumber: receipt.Number,
        InvoiceDate: receipt.IssuedDate,
        PayDates: payDates,
        PayDate: payDate,
        GrossAmount: grossAmount,
        LabourCost: labourCost,
        MaterialCost: materialCost,
        CISAmount: cisAmount,
        NetAmount: netAmount,
        SubmissionDate: receipt.SubmissionDate
      });
    });
    res.render(path.join('tailwindcss', 'cis', 'monthlyReturns'), {
      title: 'Subcontractor Monthly Returns',
      month,
      year,
      supplier,
      receiptsByMonth,
      monthNames,
      pageBreakMonths:[]
    });
  }catch(err){
    next(err);
  }
};

exports.renderYearlyReturns = async (req, res, next) => {
  try {
    const { year, uuid } = req.params;
    if (!year || !uuid) return res.status(400).send('Year and Supplier UUID required');
    const supplier = await mdb.REST.supplier.findOne({ uuid }).lean();
    if (!supplier) return res.status(404).send('Supplier not found');
    const receipts = await mdb.REST.purchase.find({ SupplierId: supplier.Id, TaxYear: year }).sort({ Number: 1 }).lean();
    const receiptsByMonth = {};
    receipts.forEach(receipt => {
      const m = receipt.TaxMonth || (receipt.PaidDate ? moment(receipt.PaidDate).month() + 1 : (receipt.IssuedDate ? moment(receipt.IssuedDate).month() + 1 : null));
      if(!receiptsByMonth[m]) receiptsByMonth[m]=[];
      const lines = Array.isArray(receipt.LineItems) ? receipt.LineItems : [];
      const labourCost = lines.filter(l => l.ChargeType === 18685897).reduce((s, l) => s + (((+l.Rate) * (+l.Quantity)) || 0), 0);
      const materialCost = lines.filter(l => l.ChargeType === 18685896).reduce((s, l) => s + (((+l.Rate) * (+l.Quantity)) || 0), 0);
      const cisAmount = Math.abs(lines.filter(l => l.ChargeType === 18685964).reduce((s, l) => s + (((+l.Rate) * (+l.Quantity)) || 0), 0));
      const grossAmount = labourCost + materialCost;
      const netAmount = grossAmount - cisAmount;
      const payDates = receipt.PaidDate ? [receipt.PaidDate] : [];
      const payDate = payDates.length > 0 ? payDates[0] : null;
      receiptsByMonth[m].push({
        InvoiceNumber: receipt.Number,
        KashflowNumber: receipt.Number,
        InvoiceDate: receipt.IssuedDate,
        PayDates: payDates,
        PayDate: payDate,
        Gross: grossAmount,
        Labour: labourCost,
        Material: materialCost,
        CIS: cisAmount,
        Net: netAmount,
        Submission: receipt.SubmissionDate
      });
    });
    res.render(path.join('tailwindcss', 'cis', 'yearlyReturns'),{
      title:'Subcontractor Yearly Returns',
      year,
      supplier,
      receiptsByMonth,
      monthNames,
      pageBreakMonths:[]
    });
  }catch(err){
    next(err);
  }
};

exports.renderYearlyReturnsForAll = async (req, res, next) => {
  try {
    const { year } = req.params;
    if (!year) return res.status(400).send('Year required');

    const suppliers = await mdb.REST.supplier.find({ IsSubcontractor: true }).lean();
    const subcontractors = [];

    for (const supplier of suppliers) {
      const purchases = await mdb.REST.purchase.find({
        SupplierId: supplier.Id,
        TaxYear: year
      }).sort({ Number: 1 }).lean();

      if (purchases.length === 0) continue;

      const invoices = purchases.map(purchase => {
        const lines = Array.isArray(purchase.LineItems) ? purchase.LineItems : [];
        const payDate = purchase.PaidDate || null;

        const labourCost = lines.filter(l => l.ChargeType === 18685897).reduce((s, l) => s + ((+l.Rate) * (+l.Quantity) || 0), 0);
        const materialCost = lines.filter(l => l.ChargeType === 18685896).reduce((s, l) => s + ((+l.Rate) * (+l.Quantity) || 0), 0);
        const cisAmount = Math.abs(lines.filter(l => l.ChargeType === 18685964).reduce((s, l) => s + ((+l.Rate) * (+l.Quantity) || 0), 0));
        const grossAmount = labourCost + materialCost;
        const netAmount = grossAmount - cisAmount;

        return {
          invoiceNumber: purchase.Number,
          kashflowNumber: purchase.Number,
          invoiceDate: purchase.IssuedDate,
          remittanceDate: payDate,
          grossAmount,
          labourCost,
          materialCost,
          cisAmount,
          netAmount,
          reverseCharge: purchase.CISRCVatAmount || 0,
          submissionDate: purchase.SubmissionDate,
          month: purchase.TaxMonth,
          year: purchase.TaxYear
        };
      });

      subcontractors.push({
        name: supplier.Name,
        company: supplier.CompanyName || '',
        cisNumber: supplier.CISNumber || '',
        utrNumber: supplier.UTRNumber || '',
        deduction: parseFloat(supplier.CISRate || '0'),
        isGross: supplier.CISRate === '0',
        isReverseCharge: supplier.isReverseCharge,
        invoices
      });
    }

  res.render(path.join('tailwindcss', 'cis', 'yearlyReturnsForAll'), {
      title: `Yearly Returns for ${year}`,
      year,
      subcontractors,
      monthNames
    });
  } catch (err) {
    next(err);
  }
};