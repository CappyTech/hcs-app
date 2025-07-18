const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const moment = require('moment-timezone');
const normalizePayments = require('../../services/kashflowNormalizer');

const monthNames = [
  'April','May','June','July','August','September',
  'October','November','December','January','February','March'
];

exports.renderMonthlyReturnsForm = async (req,res,next)=>{
  try {
    const suppliers = await mdb.supplier.find({ IsSubcontractor: true }).lean();
    const suppliersWithMonths = [];
    for (const supplier of suppliers) {
      const recs = await mdb.receipt.find({ CustomerID: supplier.SupplierID })
        .select('TaxYear TaxMonth')
        .lean();
      const receiptsByYear = {};
      recs.forEach(r=>{
        if(!r.TaxYear || !r.TaxMonth) return;
        if(!receiptsByYear[r.TaxYear]) receiptsByYear[r.TaxYear]=[];
        if(!receiptsByYear[r.TaxYear].includes(r.TaxMonth)) {
          receiptsByYear[r.TaxYear].push(r.TaxMonth);
          receiptsByYear[r.TaxYear].sort((a,b)=>monthNames.indexOf(monthNames[a-1]) - monthNames.indexOf(monthNames[b-1]));
        }
      });
      suppliersWithMonths.push({
        supplier,
        years:Object.keys(receiptsByYear).sort((a,b)=>b-a),
        receiptsByYear
      });
    }
    res.render(path.join('tailwindcss', 'cis','monthlyReturnsForm'),{
      title:'Monthly Returns Form',
      suppliersWithMonths,
      monthNames
    });
  }catch(err){
    next(err);
  }
};

exports.renderMonthlyReturnsForOne = async (req, res, next) => {
  try {
    const { year, uuid } = req.params;
    if (!year || !uuid) return res.status(400).send('Year and Supplier UUID required');

    const supplier = await mdb.supplier.findOne({ uuid }).lean();
    if (!supplier) return res.status(404).send('Subcontractor not found');

    const receipts = await mdb.receipt.find({ CustomerID: supplier.SupplierID, TaxYear: year }).sort({ InvoiceNumber: 1 }).lean();
    const receiptsByMonth = {};

    receipts.forEach(receipt => {
      const month = receipt.TaxMonth || moment(receipt.InvoiceDate).month() + 1;
      if (!receiptsByMonth[month]) receiptsByMonth[month] = [];

      const lines = Array.isArray(receipt.Lines)
        ? receipt.Lines
        : (receipt.Lines?.Line
            ? Array.isArray(receipt.Lines.Line) ? receipt.Lines.Line : [receipt.Lines.Line]
            : []);

      const payments = normalizePayments(receipt.Payments);
      const payDates = payments.map(p => p.PayDate);
      const payDate = payDates.length > 0 ? payDates[0] : null;

      const labourCost = lines.filter(l => l.ChargeType === 18685897).reduce((s, l) => s + (+l.Rate * +l.Quantity || 0), 0);
      const materialCost = lines.filter(l => l.ChargeType === 18685896).reduce((s, l) => s + (+l.Rate * +l.Quantity || 0), 0);
      const cisAmount = Math.abs(lines.filter(l => l.ChargeType === 18685964).reduce((s, l) => s + (+l.Rate * +l.Quantity || 0), 0));
      const grossAmount = labourCost + materialCost;
      const netAmount = grossAmount - cisAmount;

      receiptsByMonth[month].push({
        InvoiceNumber: receipt.CustomerReference,
        KashflowNumber: receipt.InvoiceNumber,
        InvoiceDate: receipt.InvoiceDate,
        PayDate: payDate,
        GrossAmount: grossAmount,
        LabourCost: labourCost,
        MaterialCost: materialCost,
        CISAmount: cisAmount,
        NetAmount: netAmount,
        SubmissionDate: receipt.SubmissionDate,
        TaxMonth: receipt.TaxMonth,
        TaxYear: receipt.TaxYear,
        ReverseCharge: receipt.ReverseCharge || 0
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

    const suppliers = await mdb.supplier.find({ IsSubcontractor: true }).lean();
    const subcontractors = [];

    for (const supplier of suppliers) {
      const receipts = await mdb.receipt.find({
        CustomerID: supplier.SupplierID,
        TaxYear: year,
        TaxMonth: +month
      }).sort({ InvoiceNumber: 1 }).lean();

      if (receipts.length === 0) continue;

      const invoices = receipts.map(receipt => {
        const lines = Array.isArray(receipt.Lines)
          ? receipt.Lines
          : (receipt.Lines?.Line
              ? Array.isArray(receipt.Lines.Line) ? receipt.Lines.Line : [receipt.Lines.Line]
              : []);

        const payments = normalizePayments(receipt.Payments);
        const payDate = payments.length > 0 ? payments[0].PayDate : null;

        const labourCost = lines.filter(l => l.ChargeType === 18685897).reduce((s, l) => s + (+l.Rate * +l.Quantity || 0), 0);
        const materialCost = lines.filter(l => l.ChargeType === 18685896).reduce((s, l) => s + (+l.Rate * +l.Quantity || 0), 0);
        const cisAmount = Math.abs(lines.filter(l => l.ChargeType === 18685964).reduce((s, l) => s + (+l.Rate * +l.Quantity || 0), 0));
        const grossAmount = labourCost + materialCost;
        const netAmount = grossAmount - cisAmount;

        return {
          invoiceNumber: receipt.CustomerReference,
          kashflowNumber: receipt.InvoiceNumber,
          invoiceDate: receipt.InvoiceDate,
          remittanceDate: payDate,
          grossAmount,
          labourCost,
          materialCost,
          cisAmount,
          netAmount,
          reverseCharge: receipt.ReverseCharge || 0,
          submissionDate: receipt.SubmissionDate,
          month: receipt.TaxMonth,
          year: receipt.TaxYear
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

exports.renderMonthlyReturns = async (req,res,next)=>{
  try {
    const { month, year, uuid } = req.params;
    if(!month || !year || !uuid) return res.status(400).send('Month, Year and Supplier UUID required');
    const supplier = await mdb.supplier.findOne({ uuid }).lean();
    if(!supplier) {
      req.flash('error', 'Supplier not found.');
      return res.redirect('/suppliers');
    }
    const receipts = await mdb.receipt.find({ CustomerID: supplier.SupplierID, TaxYear: year, TaxMonth: month }).sort({ InvoiceNumber: 1 }).lean();
    const receiptsByMonth = {};
    receipts.forEach(receipt=>{
      const m = receipt.TaxMonth || moment(receipt.InvoiceDate).month()+1;
      if(!receiptsByMonth[m]) receiptsByMonth[m]=[];
      const lines = Array.isArray(receipt.Lines) ? receipt.Lines : (receipt.Lines?.Line ? (Array.isArray(receipt.Lines.Line)?receipt.Lines.Line:[receipt.Lines.Line]) : []);
      const payments = normalizePayments(receipt.Payments);
      const labourCost = lines.filter(l=>l.ChargeType===18685897).reduce((s,l)=>s+((+l.Rate)*(+l.Quantity)||0),0);
      const materialCost = lines.filter(l=>l.ChargeType===18685896).reduce((s,l)=>s+((+l.Rate)*(+l.Quantity)||0),0);
      const cisAmount = Math.abs(lines.filter(l=>l.ChargeType===18685964).reduce((s,l)=>s+((+l.Rate)*(+l.Quantity)||0),0));
      const grossAmount = labourCost + materialCost;
      const netAmount = grossAmount - cisAmount;
      const payDates = payments.map(p => p.PayDate);
      const payDate = payDates.length > 0 ? payDates[0] : null;
      receiptsByMonth[m].push({
        InvoiceNumber: receipt.CustomerReference,
        KashflowNumber: receipt.InvoiceNumber,
        InvoiceDate: receipt.InvoiceDate,
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
    res.render(path.join('tailwindcss', 'cis', 'monthlyReturnsForOneSubcontractor'), {
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

exports.renderYearlyReturns = async (req,res,next)=>{
  try {
    const { year, uuid } = req.params;
    if(!year || !uuid) return res.status(400).send('Year and Supplier UUID required');
    const supplier = await mdb.supplier.findOne({ uuid }).lean();
    if(!supplier) return res.status(404).send('Supplier not found');
    const receipts = await mdb.receipt.find({ CustomerID: supplier.SupplierID, TaxYear: year }).sort({ InvoiceNumber:1 }).lean();
    const receiptsByMonth = {};
    receipts.forEach(receipt=>{
      const m = receipt.TaxMonth || moment(receipt.InvoiceDate).month()+1;
      if(!receiptsByMonth[m]) receiptsByMonth[m]=[];
      const lines = Array.isArray(receipt.Lines)?receipt.Lines:(receipt.Lines?.Line?(Array.isArray(receipt.Lines.Line)?receipt.Lines.Line:[receipt.Lines.Line]):[]);
      const payments = normalizePayments(receipt.Payments);
      const labourCost = lines.filter(l=>l.ChargeType===18685897).reduce((s,l)=>s+((+l.Rate)*(+l.Quantity)||0),0);
      const materialCost = lines.filter(l=>l.ChargeType===18685896).reduce((s,l)=>s+((+l.Rate)*(+l.Quantity)||0),0);
      const cisAmount = Math.abs(lines.filter(l=>l.ChargeType===18685964).reduce((s,l)=>s+((+l.Rate)*(+l.Quantity)||0),0));
      const grossAmount = labourCost + materialCost;
      const netAmount = grossAmount - cisAmount;
      const payDates = payments.map(p => p.PayDate);
      const payDate = payDates.length > 0 ? payDates[0] : null;
      receiptsByMonth[m].push({
        InvoiceNumber: receipt.CustomerReference,
        KashflowNumber: receipt.InvoiceNumber,
        InvoiceDate: receipt.InvoiceDate,
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

    const suppliers = await mdb.supplier.find({ IsSubcontractor: true }).lean();
    const subcontractors = [];

    for (const supplier of suppliers) {
      const receipts = await mdb.receipt.find({
        CustomerID: supplier.SupplierID,
        TaxYear: year
      }).sort({ InvoiceNumber: 1 }).lean();

      if (receipts.length === 0) continue;

      const invoices = receipts.map(receipt => {
        const lines = Array.isArray(receipt.Lines)
          ? receipt.Lines
          : (receipt.Lines?.Line
              ? Array.isArray(receipt.Lines.Line) ? receipt.Lines.Line : [receipt.Lines.Line]
              : []);

        const payments = normalizePayments(receipt.Payments);
        const payDate = payments.length > 0 ? payments[0].PayDate : null;

        const labourCost = lines.filter(l => l.ChargeType === 18685897).reduce((s, l) => s + (+l.Rate * +l.Quantity || 0), 0);
        const materialCost = lines.filter(l => l.ChargeType === 18685896).reduce((s, l) => s + (+l.Rate * +l.Quantity || 0), 0);
        const cisAmount = Math.abs(lines.filter(l => l.ChargeType === 18685964).reduce((s, l) => s + (+l.Rate * +l.Quantity || 0), 0));
        const grossAmount = labourCost + materialCost;
        const netAmount = grossAmount - cisAmount;

        return {
          invoiceNumber: receipt.CustomerReference,
          kashflowNumber: receipt.InvoiceNumber,
          invoiceDate: receipt.InvoiceDate,
          remittanceDate: payDate,
          grossAmount,
          labourCost,
          materialCost,
          cisAmount,
          netAmount,
          reverseCharge: receipt.ReverseCharge || 0,
          submissionDate: receipt.SubmissionDate,
          month: receipt.TaxMonth,
          year: receipt.TaxYear
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