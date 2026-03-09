const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const taxService = require('../../services/taxService');
const cisMappings = require('../config/cisMappings');
const moment = require('moment-timezone');

// Tax month display names (April=1 .. March=12)
const monthNames = [
  'April','May','June','July','August','September',
  'October','November','December','January','February','March'
];

// Note: Month name mapping handled by CIS dashboard utilities; not needed here.

exports.renderMonthlyReturnsForm = async (req,res,next)=>{
  try {
    // Build suppliersWithMonths similar to legacy view but from REST purchases
    const suppliers = await mdb.REST.supplier
      .find({ $or: [{ Subcontractor: true }, { IsSubcontractor: true }] })
      .sort({ Name: 1 })
      .lean();

    const suppliersWithMonths = [];
    for (const supplier of suppliers) {
      const recs = await mdb.REST.purchase.find({
        SupplierId: supplier.Id,
        $or: [
          { deletedAt: null },
          { deletedAt: { $exists: false } },
          { deletedAt: '' },
          { deletedAt: '0000-00-00 00:00:00' }
        ]
      })
        .select('TaxYear TaxMonth')
        .lean();
      const receiptsByYear = {};
      recs.forEach(r => {
        if (!r.TaxYear || !r.TaxMonth) return;
        if (!receiptsByYear[r.TaxYear]) receiptsByYear[r.TaxYear] = [];
        if (!receiptsByYear[r.TaxYear].includes(r.TaxMonth)) {
          receiptsByYear[r.TaxYear].push(r.TaxMonth);
          receiptsByYear[r.TaxYear].sort((a,b)=> monthNames.indexOf(monthNames[a-1]) - monthNames.indexOf(monthNames[b-1]));
        }
      });
      suppliersWithMonths.push({
        supplier,
        years: Object.keys(receiptsByYear).sort((a,b)=> b - a),
        receiptsByYear
      });
    }

    return res.render(path.join('tailwindcss', 'cis', 'monthlyReturnsForm'),{
      title: 'Monthly Returns',
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
    const debug = !!req.query.debug;
    if(!month || !year || !uuid) return res.status(400).send('Month, Year and Supplier UUID required');
    const supplier = await mdb.REST.supplier.findOne({ uuid }).lean();
    if(!supplier) {
      req.flash('error', 'Supplier not found.');
      return res.redirect('/suppliers');
    }

    // Fetch purchases for supplier and period
    const purchases = await mdb.REST.purchase.find({
      SupplierId: supplier.Id,
      TaxYear: +year,
      TaxMonth: +month,
      $or: [
        { deletedAt: null },
        { deletedAt: { $exists: false } },
        { deletedAt: '' },
        { deletedAt: '0000-00-00 00:00:00' }
      ]
    }).sort({ Number: 1 }).lean();

    // Paid-only filtering as per CIS policy
    const paidPurchases = purchases.filter(p => (Array.isArray(p.PaymentLines) && p.PaymentLines.length > 0) || !!p.PaidDate);

    // Helper to classify line items similar to cisController
    const classifyPurchase = (p) => {
      const hasLineItems = Array.isArray(p.LineItems) && p.LineItems.length > 0;
      const hasLines = Array.isArray(p.Lines) && p.Lines.length > 0;
      const lines = hasLineItems ? p.LineItems : hasLines ? p.Lines : [];
      let labourCost = 0, materialsCost = 0, cisAmount = 0;
      for (const line of lines) {
        if (!line) continue;
        const chargeType = line.ChargeType != null ? Number(line.ChargeType) : null;
        const qty = Number(line.Quantity) || 0;
        const rate = Number(line.Rate) || 0;
        const amount = line.Amount != null ? Number(line.Amount) : (rate * qty);
        if (chargeType === 18685896) { materialsCost += amount; continue; }
        if (chargeType === 18685897) { labourCost += amount; continue; }
        if (chargeType === 18685964) { cisAmount += Math.abs(amount); continue; }
        const nc = Number(line.NominalCode) || null;
        const nn = (line.NominalName || line.Description || '').toString().toLowerCase();
        if (nc && cisMappings.materialsNominalCodes.includes(nc)) { materialsCost += amount; continue; }
        if (nc && cisMappings.labourNominalCodes.includes(nc)) { labourCost += amount; continue; }
        if (nc && Array.isArray(cisMappings.cisDeductionNominalCodes) && cisMappings.cisDeductionNominalCodes.includes(nc)) { cisAmount += Math.abs(amount); continue; }
        if (nn.includes('material')) { materialsCost += amount; continue; }
        if (nn.includes('labour') || nn.includes('labor') || nn.includes('subcontract')) { labourCost += amount; continue; }
      }
      const grossAmount = labourCost + materialsCost;
      const netAmount = grossAmount - cisAmount;
      const payDates = Array.isArray(p.PaymentLines) ? p.PaymentLines.map(pl => pl.PayDate || pl.Date).filter(Boolean) : [];
      const payDate = p.PaidDate || (payDates.length ? payDates[0] : null);
      return { labourCost, materialsCost, cisAmount, grossAmount, netAmount, payDates, payDate };
    };

    const rows = paidPurchases.map(p => {
      const c = classifyPurchase(p);
      return {
        Number: p.Number,
        IssuedDate: p.IssuedDate,
        PaidDate: c.payDate,
        LabourCost: c.labourCost,
        MaterialCost: c.materialsCost,
        CISAmount: c.cisAmount,
        GrossAmount: c.grossAmount,
        NetAmount: c.netAmount,
        SubmissionDate: p.SubmissionDate
      };
    });

    // Totals
    const totals = rows.reduce((acc, r) => ({
      LabourCost: acc.LabourCost + (r.LabourCost || 0),
      MaterialCost: acc.MaterialCost + (r.MaterialCost || 0),
      CISAmount: acc.CISAmount + (r.CISAmount || 0),
      GrossAmount: acc.GrossAmount + (r.GrossAmount || 0),
      NetAmount: acc.NetAmount + (r.NetAmount || 0),
    }), { LabourCost: 0, MaterialCost: 0, CISAmount: 0, GrossAmount: 0, NetAmount: 0 });

    const monthName = moment.tz({ year: +year, month: 3, day: 6 }, 'Europe/London').add(+month - 1, 'months').format('MMMM');

    const nextYearShortM = (Number(year) + 1).toString().slice(-2);
    const dynamicTitleM = `${supplier.Name} | Heron Constructive Solutions LTD | ${year}-${nextYearShortM} CIS Returns — ${monthName}`;
    return res.render(path.join('tailwindcss', 'cis', 'monthlyReturnsForOneSubcontractor'), {
      title: dynamicTitleM,
      supplier,
      year: +year,
      month: +month,
      monthName,
      rows,
      totals,
      debug
    });
  }catch(err){
    next(err);
  }
};

exports.renderYearlyReturns = async (req,res,next)=>{
  try {
    const { year, uuid } = req.params;
    const debug = !!req.query.debug;
    if(!year || !uuid) return res.status(400).send('Year and Supplier UUID required');
    const supplier = await mdb.REST.supplier.findOne({ uuid }).lean();
    if(!supplier) {
      req.flash('error', 'Supplier not found.');
      return res.redirect('/suppliers');
    }
    const purchases = await mdb.REST.purchase.find({
      SupplierId: supplier.Id,
      TaxYear: +year,
      $or: [
        { deletedAt: null },
        { deletedAt: { $exists: false } },
        { deletedAt: '' },
        { deletedAt: '0000-00-00 00:00:00' }
      ]
    }).sort({ TaxMonth: 1, Number: 1 }).lean();

    // Paid-only filtering as per CIS policy
    const paidPurchases = purchases.filter(p => (Array.isArray(p.PaymentLines) && p.PaymentLines.length > 0) || !!p.PaidDate);

    // Build receiptsByMonth compatible with existing template
    const receiptsByMonth = {};
    const classifyPurchase = (p) => {
      const hasLineItems = Array.isArray(p.LineItems) && p.LineItems.length > 0;
      const hasLines = Array.isArray(p.Lines) && p.Lines.length > 0;
      const lines = hasLineItems ? p.LineItems : hasLines ? p.Lines : [];
      let labourCost = 0, materialsCost = 0, cisAmount = 0;
      for (const line of lines) {
        if (!line) continue;
        const chargeType = line.ChargeType != null ? Number(line.ChargeType) : null;
        const qty = Number(line.Quantity) || 0;
        const rate = Number(line.Rate) || 0;
        const amount = line.Amount != null ? Number(line.Amount) : (rate * qty);
        if (chargeType === 18685896) { materialsCost += amount; continue; }
        if (chargeType === 18685897) { labourCost += amount; continue; }
        if (chargeType === 18685964) { cisAmount += Math.abs(amount); continue; }
        const nc = Number(line.NominalCode) || null;
        const nn = (line.NominalName || line.Description || '').toString().toLowerCase();
        if (nc && cisMappings.materialsNominalCodes.includes(nc)) { materialsCost += amount; continue; }
        if (nc && cisMappings.labourNominalCodes.includes(nc)) { labourCost += amount; continue; }
        if (nc && Array.isArray(cisMappings.cisDeductionNominalCodes) && cisMappings.cisDeductionNominalCodes.includes(nc)) { cisAmount += Math.abs(amount); continue; }
        if (nn.includes('material')) { materialsCost += amount; continue; }
        if (nn.includes('labour') || nn.includes('labor') || nn.includes('subcontract')) { labourCost += amount; continue; }
      }
      const grossAmount = labourCost + materialsCost;
      const netAmount = grossAmount - cisAmount;
      const payDates = Array.isArray(p.PaymentLines) ? p.PaymentLines.map(pl => pl.PayDate || pl.Date).filter(Boolean) : [];
      const payDate = p.PaidDate || (payDates.length ? payDates[0] : null);
      return { labourCost, materialsCost, cisAmount, grossAmount, netAmount, payDate };
    };

    for (const p of paidPurchases) {
      const m = (p.TaxMonth || 1).toString();
      if (!receiptsByMonth[m]) receiptsByMonth[m] = [];
      const c = classifyPurchase(p);
      receiptsByMonth[m].push({
        InvoiceNumber: p.SupplierReference || p.Number,
        KashflowNumber: p.Number,
        InvoiceDate: p.IssuedDate,
        PayDate: c.payDate,
        Gross: c.grossAmount,
        Labour: c.labourCost,
        Material: c.materialsCost,
        CIS: c.cisAmount,
        Net: c.netAmount,
        SubmissionDate: p.SubmissionDate
      });
    }

    // Provide helpers for formatting if not globally defined
    const slimDateTime = (d) => d ? moment.tz(d, 'Europe/London').format('DD/MM/YYYY') : '';
    const formatCurrency = (n) => `£${(Number(n||0)).toFixed(2)}`;

    const nextYearShort = (Number(year) + 1).toString().slice(-2);
    const dynamicTitle = `${supplier.Name} | Heron Constructive Solutions LTD | ${year}-${nextYearShort} CIS Returns`;
    return res.render(path.join('tailwindcss', 'cis', 'yearlyReturns'),{
      title: dynamicTitle,
      year: +year,
      supplier,
      receiptsByMonth,
      monthNames,
      pageBreakMonths: [],
      slimDateTime,
      formatCurrency,
      debug
    });
  }catch(err){
    next(err);
  }
};

// New: stub handlers to satisfy routes and avoid undefined callbacks
exports.renderYearlyReturnsForAll = async (req, res, next) => {
  try {
    const { year } = req.params;
    if (!year) return res.status(400).send('Year required');
    // Redirect to CIS Dashboard (choose month 1 by default)
    req.flash('success', 'Redirected to CIS Dashboard (year view not yet implemented).');
    return res.redirect(`/CIS/Dashboard/${year}/1`);
  } catch (err) {
    next(err);
  }
};

exports.renderMonthlyReturnsForAll = async (req, res, next) => {
  try {
    const { year, month } = req.params;
    if (!year || !month) return res.status(400).send('Year and Month required');
    // Redirect to CIS Dashboard monthly view
    return res.redirect(`/CIS/Dashboard/${year}/${month}`);
  } catch (err) {
    next(err);
  }
};