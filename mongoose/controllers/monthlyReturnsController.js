const mongoose = require('mongoose');
const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../services/loggerService');
const moment = require('moment-timezone');
const normalizePayments = require('../../services/kashflowNormalizer').normalizePayments;

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
    res.render(path.join('mongoose','monthlyReturnsForm'),{
      title:'Monthly Returns Form',
      suppliersWithMonths,
      monthNames
    });
  }catch(err){
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
      const payments = normalizePayments(receipt.Payments, receipt.InvoiceNumber, receipt.CustomerID);
      const labourCost = lines.filter(l=>l.ChargeType===18685897).reduce((s,l)=>s+((+l.Rate)*(+l.Quantity)||0),0);
      const materialCost = lines.filter(l=>l.ChargeType===18685896).reduce((s,l)=>s+((+l.Rate)*(+l.Quantity)||0),0);
      const cisAmount = Math.abs(lines.filter(l=>l.ChargeType===18685964).reduce((s,l)=>s+((+l.Rate)*(+l.Quantity)||0),0));
      const grossAmount = labourCost + materialCost;
      const netAmount = grossAmount - cisAmount;
      const payDates = payments?.Payment?.Payment?.map(p=>p.PayDate) || [];
      const payDate = payDates.length>0 ? payDates[0] : 'N/A';
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
    res.render(path.join('mongoose','monthlyReturnsForOneSubcontractor'),{
      title:'Subcontractor Monthly Returns',
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
