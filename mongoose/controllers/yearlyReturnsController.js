const mongoose = require('mongoose');
const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');
const moment = require('moment-timezone');
const { normalizePayments } = require('../../services/kashflowNormalizer');
const monthNames = [
  'April','May','June','July','August','September',
  'October','November','December','January','February','March'
];

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
      const payments = normalizePayments(receipt.Payments, receipt.InvoiceNumber, receipt.CustomerID);
      const labourCost = lines.filter(l=>l.ChargeType===18685897).reduce((s,l)=>s+((+l.Rate)*(+l.Quantity)||0),0);
      const materialCost = lines.filter(l=>l.ChargeType===18685896).reduce((s,l)=>s+((+l.Rate)*(+l.Quantity)||0),0);
      const cisAmount = Math.abs(lines.filter(l=>l.ChargeType===18685964).reduce((s,l)=>s+((+l.Rate)*(+l.Quantity)||0),0));
      const grossAmount = labourCost + materialCost;
      const netAmount = grossAmount - cisAmount;
      const payDates = payments?.Payment?.Payment?.map(p=>p.PayDate) || [];
      receiptsByMonth[m].push({
        InvoiceNumber: receipt.CustomerReference,
        KashflowNumber: receipt.InvoiceNumber,
        InvoiceDate: receipt.InvoiceDate,
        PayDate: payDates[0] || 'N/A',
        Gross: grossAmount,
        Labour: labourCost,
        Material: materialCost,
        CIS: cisAmount,
        Net: netAmount,
        Submission: receipt.SubmissionDate
      });
    });
    res.render(path.join('mongoose','yearlyReturns'),{
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
