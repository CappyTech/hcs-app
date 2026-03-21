const path = require("path");
const mdb = require("../services/mongooseDatabaseService");
const taxService = require("../../services/taxService");
const cisMappings = require("../config/cisMappings");
const moment = require("moment-timezone");

// Tax month display names (April=1 .. March=12)
const monthNames = [
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
  "January",
  "February",
  "March",
];

// Note: Month name mapping handled by CIS dashboard utilities; not needed here.

exports.renderMonthlyReturnsForm = async (req, res, next) => {
  try {
    // Build suppliersWithMonths similar to legacy view but from REST purchases
    // OLD: .find({ $or: [{ Subcontractor: true }, { IsSubcontractor: true }] })
    // NEW: subcontractors have WithholdingTaxRate >= 0
    const suppliers = await mdb.REST.supplier
      .find({ WithholdingTaxRate: { $gte: 0 } })
      .sort({ Name: 1 })
      .lean();

    const suppliersWithMonths = [];
    // NOTE: deletedAt filtering disabled — hcs-sync may write stale deletedAt values.
    // Filtering by casing-inconsistent deletedAt was excluding live records.
    // const deletedFilter = {
    //   $or: [
    //     { deletedAt: null },
    //     { deletedAt: { $exists: false } },
    //     { deletedAt: '' },
    //     { deletedAt: '0000-00-00 00:00:00' },
    //   ],
    // };

    for (const supplier of suppliers) {
      const recs = await mdb.REST.purchase
        .find({
          SupplierId: supplier.Id,
          // ...deletedFilter,
        })
        .select("TaxYear TaxMonth")
        .lean();
      const receiptsByYear = {};
      recs.forEach((r) => {
        if (!r.TaxYear || !r.TaxMonth) return;
        if (!receiptsByYear[r.TaxYear]) receiptsByYear[r.TaxYear] = [];
        if (!receiptsByYear[r.TaxYear].includes(r.TaxMonth)) {
          receiptsByYear[r.TaxYear].push(r.TaxMonth);
          receiptsByYear[r.TaxYear].sort((a, b) => a - b);
        }
      });

      // If no TaxYear/TaxMonth data, try computing from payment dates
      if (Object.keys(receiptsByYear).length === 0) {
        const fallbackRecs = await mdb.REST.purchase
          .find({
            SupplierId: supplier.Id,
            $or: [{ TaxYear: null }, { TaxYear: { $exists: false } }],
            // ...deletedFilter,
          })
          .select("PaidDate PaymentLines")
          .lean();
        for (const r of fallbackRecs) {
          const payDate =
            r.PaidDate ||
            (Array.isArray(r.PaymentLines) && r.PaymentLines.length > 0
              ? r.PaymentLines[0].PayDate || r.PaymentLines[0].Date
              : null);
          if (!payDate) continue;
          const { taxYear: ty, taxMonth: tm } =
            taxService.calculateTaxYearAndMonth(payDate);
          if (!ty || !tm) continue;
          if (!receiptsByYear[ty]) receiptsByYear[ty] = [];
          if (!receiptsByYear[ty].includes(tm)) {
            receiptsByYear[ty].push(tm);
            receiptsByYear[ty].sort((a, b) => a - b);
          }
        }
      }

      const years = Object.keys(receiptsByYear).sort((a, b) => b - a);
      if (years.length === 0) continue;
      suppliersWithMonths.push({
        supplier,
        years,
        receiptsByYear,
      });
    }

    return res.render(path.join("tailwindcss", "cis", "monthlyReturnsForm"), {
      title: "Monthly Returns",
      suppliersWithMonths,
      monthNames,
    });
  } catch (err) {
    next(err);
  }
};

exports.renderMonthlyReturns = async (req, res, next) => {
  try {
    const { month, year, uuid } = req.params;
    const debug = !!req.query.debug;
    if (!month || !year || !uuid)
      return res.status(400).send("Month, Year and Supplier UUID required");

    // Subcontractors may only view their own returns
    if (req.user && req.user.role === "subcontractor") {
      const ownSupplier = req.user.subcontractorId
        ? await mdb.REST.supplier.findById(req.user.subcontractorId).lean()
        : null;
      if (!ownSupplier || ownSupplier.uuid !== uuid) {
        return res
          .status(403)
          .send(
            "You do not have permission to view this subcontractor's returns.",
          );
      }
    }

    const supplier = await mdb.REST.supplier.findOne({ uuid }).lean();
    if (!supplier) {
      req.flash("error", "Supplier not found.");
      return res.redirect("/suppliers");
    }

    // Fetch purchases for supplier and period
    const taxMonthRange = taxService.getCurrentMonthlyReturn(+year, +month);
    const purchases = await mdb.REST.purchase
      .find({
        SupplierId: supplier.Id,
        // NOTE: deletedAt filtering removed — hcs-sync may write stale deletedAt values.
        $or: [
          { TaxYear: +year, TaxMonth: +month },
          {
            TaxYear: null,
            PaidDate: {
              $gte: taxMonthRange.periodStart,
              $lte: taxMonthRange.periodEnd,
            },
          },
          {
            TaxYear: { $exists: false },
            PaidDate: {
              $gte: taxMonthRange.periodStart,
              $lte: taxMonthRange.periodEnd,
            },
          },
        ],
      })
      .sort({ Number: 1 })
      .lean();

    // Paid-only filtering as per CIS policy
    const paidPurchases = purchases.filter(
      (p) =>
        (Array.isArray(p.PaymentLines) && p.PaymentLines.length > 0) ||
        !!p.PaidDate,
    );

    const rows = paidPurchases.map((p) => {
      const c = classifyLines(p);
      return {
        Number: p.Number,
        IssuedDate: p.IssuedDate,
        PaidDate: c.payDate,
        LabourCost: c.labourCost,
        MaterialCost: c.materialsCost,
        CISAmount: c.cisAmount,
        GrossAmount: c.grossAmount,
        NetAmount: c.netAmount,
        SubmissionDate: p.SubmissionDate,
      };
    });

    // Totals
    const totals = rows.reduce(
      (acc, r) => ({
        LabourCost: acc.LabourCost + (r.LabourCost || 0),
        MaterialCost: acc.MaterialCost + (r.MaterialCost || 0),
        CISAmount: acc.CISAmount + (r.CISAmount || 0),
        GrossAmount: acc.GrossAmount + (r.GrossAmount || 0),
        NetAmount: acc.NetAmount + (r.NetAmount || 0),
      }),
      {
        LabourCost: 0,
        MaterialCost: 0,
        CISAmount: 0,
        GrossAmount: 0,
        NetAmount: 0,
      },
    );

    const monthName = moment
      .tz({ year: +year, month: 3, day: 6 }, "Europe/London")
      .add(+month - 1, "months")
      .format("MMMM");

    const nextYearShortM = (Number(year) + 1).toString().slice(-2);
    const dynamicTitleM = `${supplier.Name} | Heron Constructive Solutions LTD | ${year}-${nextYearShortM} CIS Returns — ${monthName}`;
    return res.render(
      path.join("tailwindcss", "cis", "monthlyReturnsForOneSubcontractor"),
      {
        title: dynamicTitleM,
        supplier,
        year: +year,
        month: +month,
        monthName,
        rows,
        totals,
        debug,
      },
    );
  } catch (err) {
    next(err);
  }
};

exports.renderYearlyReturns = async (req, res, next) => {
  try {
    const { year, uuid } = req.params;
    const debug = !!req.query.debug;
    if (!year || !uuid)
      return res.status(400).send("Year and Supplier UUID required");

    // Subcontractors may only view their own returns
    if (req.user && req.user.role === "subcontractor") {
      const ownSupplier = req.user.subcontractorId
        ? await mdb.REST.supplier.findById(req.user.subcontractorId).lean()
        : null;
      if (!ownSupplier || ownSupplier.uuid !== uuid) {
        return res
          .status(403)
          .send(
            "You do not have permission to view this subcontractor's returns.",
          );
      }
    }

    const supplier = await mdb.REST.supplier.findOne({ uuid }).lean();
    if (!supplier) {
      req.flash("error", "Supplier not found.");
      return res.redirect("/suppliers");
    }
    const taxYearRange = taxService.getTaxYearStartEnd(+year);
    const purchasesRaw = await mdb.REST.purchase
      .find({
        SupplierId: supplier.Id,
        $or: [
          { TaxYear: +year },
          {
            TaxYear: null,
            PaidDate: { $gte: taxYearRange.start, $lte: taxYearRange.end },
          },
          {
            TaxYear: { $exists: false },
            PaidDate: { $gte: taxYearRange.start, $lte: taxYearRange.end },
          },
        ],
      })
      .sort({ TaxMonth: 1, Number: 1 })
      .lean();

    // Filter soft-deletes client-side — DISABLED pending hcs-sync fix.
    // The old hcs-app sync incorrectly wrote deletedAt on active records before Nov 2025,
    // causing pre-switch months to be hidden. Re-enable once hcs-sync cleans the data.
    // const isNotDeleted = (p) => {
    //   const d = p.deletedAt ?? p.DeletedAt;
    //   if (d === null || d === undefined || d === '' || d === '0000-00-00 00:00:00') return true;
    //   const dt = new Date(d);
    //   return isNaN(dt.getTime());
    // };
    // const purchases = purchasesRaw.filter(isNotDeleted);
    const purchases = purchasesRaw;

    // Paid-only filtering as per CIS policy
    const paidPurchases = purchases.filter(
      (p) =>
        (Array.isArray(p.PaymentLines) && p.PaymentLines.length > 0) ||
        !!p.PaidDate,
    );

    // Build receiptsByMonth compatible with existing template
    const receiptsByMonth = {};

    for (const p of paidPurchases) {
      let m = p.TaxMonth;
      if (!m) {
        const payDate =
          p.PaidDate ||
          (Array.isArray(p.PaymentLines) && p.PaymentLines.length > 0
            ? p.PaymentLines[0].PayDate || p.PaymentLines[0].Date
            : null);
        if (payDate) {
          m = taxService.calculateTaxYearAndMonth(payDate).taxMonth;
        }
      }
      m = (m || 1).toString();
      if (!receiptsByMonth[m]) receiptsByMonth[m] = [];
      const c = classifyLines(p);
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
        ReverseCharge: Number(p.ReverseChargeVATAmount || p.CISRCVatAmount || 0),
        SubmissionDate: p.SubmissionDate,
      });
    }

    // Provide helpers for formatting if not globally defined
    const slimDateTime = (d) =>
      d ? moment.tz(d, "Europe/London").format("DD/MM/YYYY") : "";
    const formatCurrency = (n) => `£${Number(n || 0).toFixed(2)}`;

    const nextYearShort = (Number(year) + 1).toString().slice(-2);
    const dynamicTitle = `${supplier.Name} | Heron Constructive Solutions LTD | ${year}-${nextYearShort} CIS Returns`;
    return res.render(path.join("tailwindcss", "cis", "yearlyReturns"), {
      title: dynamicTitle,
      year: +year,
      supplier,
      receiptsByMonth,
      monthNames,
      pageBreakMonths: [],
      slimDateTime,
      formatCurrency,
      debug,
    });
  } catch (err) {
    next(err);
  }
};

// Shared helper: classify line items of a purchase into labour/materials/CIS
function classifyLines(p) {
  const hasLineItems = Array.isArray(p.LineItems) && p.LineItems.length > 0;
  const hasLines = Array.isArray(p.Lines) && p.Lines.length > 0;
  const lines = hasLineItems ? p.LineItems : hasLines ? p.Lines : [];
  let labourCost = 0, materialsCost = 0, cisAmount = 0;
  for (const line of lines) {
    if (!line) continue;
    const chargeType = line.ChargeType != null ? Number(line.ChargeType) : null;
    const qty = Number(line.Quantity ?? line.Qty) || 0;
    const rate = Number(line.Rate ?? line.UnitPrice ?? line.Price ?? line.Unit) || 0;
    const amount =
      line.Amount != null && line.Amount !== ""
        ? Number(line.Amount)
        : line.NetAmount != null && line.NetAmount !== ""
          ? Number(line.NetAmount)
          : rate * qty;
    if (chargeType === 18685896) { materialsCost += amount; continue; }
    if (chargeType === 18685897) { labourCost += amount; continue; }
    if (chargeType === 18685964) { cisAmount += Math.abs(amount); continue; }
    const nc = Number(line.NominalCode) || null;
    const nn = (line.NominalName || line.Description || "").toString().toLowerCase();
    if (nc && cisMappings.materialsNominalCodes.includes(nc)) { materialsCost += amount; continue; }
    if (nc && cisMappings.labourNominalCodes.includes(nc)) { labourCost += amount; continue; }
    if (nc && Array.isArray(cisMappings.cisDeductionNominalCodes) && cisMappings.cisDeductionNominalCodes.includes(nc)) { cisAmount += Math.abs(amount); continue; }
    if (nn.includes("material")) { materialsCost += amount; continue; }
    if (nn.includes("labour") || nn.includes("labor") || nn.includes("subcontract")) { labourCost += amount; continue; }
  }
  const grossAmount = labourCost + materialsCost;
  const netAmount = grossAmount - cisAmount;
  const payDates = Array.isArray(p.PaymentLines)
    ? p.PaymentLines.map((pl) => pl.PayDate || pl.Date).filter(Boolean)
    : [];
  const payDate = p.PaidDate || (payDates.length ? payDates[0] : null);
  return { labourCost, materialsCost, cisAmount, grossAmount, netAmount, payDate };
}

// Shared helper: build a subcontractor entry for the "ForAll" views
function buildSubEntry(supplier, purchases) {
  const slimDT = (d) => d ? moment.tz(d, "Europe/London").format("DD/MM/YYYY") : "";
  // OLD: const cisRate = supplier.CISRate != null ? Number(supplier.CISRate) : null;
  // NEW: use WithholdingTaxRate; -1 means N/A
  const whtRate = supplier.WithholdingTaxRate != null ? Number(supplier.WithholdingTaxRate) : null;
  const cisRate = (whtRate != null && whtRate >= 0) ? whtRate : null;
  const invoices = purchases.map((p) => {
    const c = classifyLines(p);
    const taxMonth = p.TaxMonth || (c.payDate ? taxService.calculateTaxYearAndMonth(c.payDate).taxMonth : null);
    const taxYear  = p.TaxYear  || (c.payDate ? taxService.calculateTaxYearAndMonth(c.payDate).taxYear  : null);
    return {
      invoiceNumber:   p.SupplierReference || p.Number,
      kashflowNumber:  p.Number,
      invoiceDate:     p.IssuedDate,
      remittanceDate:  c.payDate,
      grossAmount:     c.grossAmount,
      labourCost:      c.labourCost,
      materialCost:    c.materialsCost,
      cisAmount:       c.cisAmount,
      netAmount:       c.netAmount,
      reverseCharge:   Number(p.ReverseChargeVATAmount || p.CISRCVatAmount || 0),
      month:           taxMonth,
      year:            taxYear,
      submissionDate:  p.SubmissionDate,
    };
  });
  // OLD: cisNumber: supplier.CISNumber || "",
  // NEW: derive first reference from WithholdingTaxReferences array
  const refs = Array.isArray(supplier.WithholdingTaxReferences) ? supplier.WithholdingTaxReferences : [];
  return {
    name:            supplier.Name,
    company:         "",
    deduction:       Number.isFinite(cisRate) ? cisRate : null,
    isGross:         cisRate === 0,
    cisNumber:       refs[0] || "",
    isReverseCharge: !!(supplier.IsCISReverseCharge || supplier.isReverseCharge),
    invoices,
  };
}

exports.renderYearlyReturnsForAll = async (req, res, next) => {
  try {
    const { year } = req.params;
    if (!year) return res.status(400).send("Year required");

    const slimDateTime = (d) => d ? moment.tz(d, "Europe/London").format("DD/MM/YYYY") : "";
    const formatCurrency = (n) => `£${Number(n || 0).toFixed(2)}`;

    const taxYearRange = taxService.getTaxYearStartEnd(+year);

    // All subcontractor suppliers
    // OLD: .find({ $or: [{ Subcontractor: true }, { IsSubcontractor: true }] })
    const suppliers = await mdb.REST.supplier
      .find({ WithholdingTaxRate: { $gte: 0 } })
      .sort({ Name: 1 })
      .lean();

    const subcontractors = [];
    for (const supplier of suppliers) {
      const purchases = await mdb.REST.purchase
        .find({
          SupplierId: supplier.Id,
          $or: [
            { TaxYear: +year },
            { TaxYear: null,             PaidDate: { $gte: taxYearRange.start, $lte: taxYearRange.end } },
            { TaxYear: { $exists: false }, PaidDate: { $gte: taxYearRange.start, $lte: taxYearRange.end } },
          ],
        })
        .sort({ TaxMonth: 1, Number: 1 })
        .lean();

      const paid = purchases.filter(
        (p) => (Array.isArray(p.PaymentLines) && p.PaymentLines.length > 0) || !!p.PaidDate,
      );
      if (paid.length === 0) continue;
      subcontractors.push(buildSubEntry(supplier, paid));
    }

    const nextYearShort = (Number(year) + 1).toString().slice(-2);
    return res.render(path.join("tailwindcss", "cis", "yearlyReturnsForAll"), {
      title: `CIS Yearly Returns ${year}-${nextYearShort} | All Subcontractors`,
      year: +year,
      subcontractors,
      slimDateTime,
      formatCurrency,
    });
  } catch (err) {
    next(err);
  }
};

exports.renderMonthlyReturnsForAll = async (req, res, next) => {
  try {
    const { year, month } = req.params;
    if (!year || !month) return res.status(400).send("Year and Month required");

    const slimDateTime = (d) => d ? moment.tz(d, "Europe/London").format("DD/MM/YYYY") : "";
    const formatCurrency = (n) => `£${Number(n || 0).toFixed(2)}`;

    const taxMonthRange = taxService.getCurrentMonthlyReturn(+year, +month);

    // All subcontractor suppliers
    // OLD: .find({ $or: [{ Subcontractor: true }, { IsSubcontractor: true }] })
    const suppliers = await mdb.REST.supplier
      .find({ WithholdingTaxRate: { $gte: 0 } })
      .sort({ Name: 1 })
      .lean();

    const subcontractors = [];
    for (const supplier of suppliers) {
      const purchases = await mdb.REST.purchase
        .find({
          SupplierId: supplier.Id,
          $or: [
            { TaxYear: +year, TaxMonth: +month },
            { TaxYear: null,             PaidDate: { $gte: taxMonthRange.periodStart, $lte: taxMonthRange.periodEnd } },
            { TaxYear: { $exists: false }, PaidDate: { $gte: taxMonthRange.periodStart, $lte: taxMonthRange.periodEnd } },
          ],
        })
        .sort({ Number: 1 })
        .lean();

      const paid = purchases.filter(
        (p) => (Array.isArray(p.PaymentLines) && p.PaymentLines.length > 0) || !!p.PaidDate,
      );
      if (paid.length === 0) continue;
      subcontractors.push(buildSubEntry(supplier, paid));
    }

    const monthName = moment
      .tz({ year: +year, month: 3, day: 6 }, "Europe/London")
      .add(+month - 1, "months")
      .format("MMMM");
    const nextYearShort = (Number(year) + 1).toString().slice(-2);
    return res.render(path.join("tailwindcss", "cis", "monthlyReturnsForAll"), {
      title: `CIS Monthly Returns ${year}-${nextYearShort} — ${monthName} | All Subcontractors`,
      year: +year,
      month: +month,
      monthName,
      subcontractors,
      slimDateTime,
      formatCurrency,
    });
  } catch (err) {
    next(err);
  }
};
