const mongoose = require("mongoose");
const path = require("path");
const mdb = require("../services/mongooseDatabaseService");
const logger = require("../../services/loggerService");
const moment = require("moment-timezone");
const taxService = require("../../services/taxService");
const cisMappings = require("../config/cisMappings");
const { normalizeWhtRate } = require("../../services/cisService");

exports.renderCISDashboardMongo = async (req, res, next) => {
  try {
    const specifiedYear = parseInt(req.params.year);
    const specifiedMonth = parseInt(req.params.month);

    if (
      isNaN(specifiedYear) ||
      isNaN(specifiedMonth) ||
      specifiedMonth < 1 ||
      specifiedMonth > 12
    ) {
      return res.status(400).send("Invalid year or month.");
    }

    const taxYear = taxService.getTaxYearStartEnd(specifiedYear);
    const currentMonthlyReturn = taxService.getCurrentMonthlyReturn(
      specifiedYear,
      specifiedMonth,
    );

    logger.info(
      `Rendering CIS Dashboard for Year: ${specifiedYear}, Month: ${specifiedMonth}`,
    );

    // Fetch purchases for the period. Prefer TaxYear/TaxMonth match; also include PaidDate OR any PaymentLines within window; fallback to IssuedDate window.
    // Note: Do NOT filter deletedAt at DB level — handle soft-deletes client-side to match weekly logic.
    const orConditions = [
      { TaxYear: specifiedYear, TaxMonth: specifiedMonth },
      {
        PaidDate: {
          $gte: new Date(currentMonthlyReturn.periodStart),
          $lte: new Date(currentMonthlyReturn.periodEnd),
        },
      },
      // Any payment line in the window counts as paid in this tax month
      {
        PaymentLines: {
          $elemMatch: {
            $or: [
              {
                PayDate: {
                  $gte: new Date(currentMonthlyReturn.periodStart),
                  $lte: new Date(currentMonthlyReturn.periodEnd),
                },
              },
              {
                Date: {
                  $gte: new Date(currentMonthlyReturn.periodStart),
                  $lte: new Date(currentMonthlyReturn.periodEnd),
                },
              },
            ],
          },
        },
      },
      {
        IssuedDate: {
          $gte: new Date(currentMonthlyReturn.periodStart),
          $lte: new Date(currentMonthlyReturn.periodEnd),
        },
      },
    ];
    // Optional broader scan: include any purchases with PaymentLines and filter by window in app logic.
    if (req.query.scanLines === "1") {
      logger.info(
        "[CIS] scanLines mode: broadening query to include all purchases with PaymentLines for in-app date filtering",
      );
      orConditions.push({ PaymentLines: { $exists: true, $ne: [] } });
    }
    const purchasesRaw = await mdb.REST.purchase
      .find({ $or: orConditions })
      .lean();

    // Period-aware deletion filter: treat records as deleted only if deleted before the period starts
    const periodStartMsForDelete = new Date(
      currentMonthlyReturn.periodStart,
    ).getTime();
    const toDateDel = (d) => {
      if (!d) return null;
      if (d instanceof Date) return isNaN(d.getTime()) ? null : d;
      if (typeof d === "number") {
        const dt = new Date(d);
        return isNaN(dt.getTime()) ? null : dt;
      }
      if (typeof d === "string") {
        const s = d.trim();
        if (
          s === "" ||
          s.toLowerCase() === "null" ||
          s.toLowerCase() === "undefined"
        )
          return null;
        if (s.startsWith("0000-00-00")) return null;
        let dt = new Date(s);
        if (!isNaN(dt.getTime())) return dt;
        const hasSpaceDateTime = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?/.test(
          s,
        );
        if (hasSpaceDateTime) {
          const m = moment.tz(
            s,
            ["YYYY-MM-DD HH:mm:ss", "YYYY-MM-DD HH:mm"],
            "Europe/London",
          );
          if (m.isValid()) return m.toDate();
        }
        const m2 = moment.tz(s, "Europe/London");
        return m2.isValid() ? m2.toDate() : null;
      }
      return null;
    };
    const isSoftDeleted = (doc) => {
      if (!doc) return false;
      // Ignore isDeleted/deleted boolean alone; only consider timestamp relative to period end
      const d = doc.deletedAt ?? doc.DeletedAt;
      const dt = toDateDel(d);
      if (!dt) return false;
      return dt.getTime() < periodStartMsForDelete;
    };
    const purchases =
      req.query.ignoreDeleted === "1"
        ? purchasesRaw || []
        : (purchasesRaw || []).filter((p) => !isSoftDeleted(p));

    // Only paid purchases are allowed in CIS, and they must be paid within the tax-month window
    const start = new Date(currentMonthlyReturn.periodStart);
    const end = new Date(currentMonthlyReturn.periodEnd);
    const startMs = start.getTime();
    const endMs = end.getTime();
    const toDate = (d) => {
      if (!d) return null;
      if (d instanceof Date) return isNaN(d.getTime()) ? null : d;
      if (typeof d === "number") {
        const dt = new Date(d);
        return isNaN(dt.getTime()) ? null : dt;
      }
      if (typeof d === "string") {
        // Fast path: native parse (works for ISO)
        let dt = new Date(d);
        if (!isNaN(dt.getTime())) return dt;
        // Handle common non-ISO format "YYYY-MM-DD HH:mm:ss" (no T)
        const trimmed = d.trim();
        const hasSpaceDateTime = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?/.test(
          trimmed,
        );
        if (hasSpaceDateTime) {
          const m = moment.tz(
            trimmed,
            ["YYYY-MM-DD HH:mm:ss", "YYYY-MM-DD HH:mm"],
            "Europe/London",
          );
          if (m.isValid()) return m.toDate();
        }
        // Try a more lenient moment parse in London tz as a last resort
        const m2 = moment.tz(trimmed, "Europe/London");
        return m2.isValid() ? m2.toDate() : null;
      }
      return null;
    };
    const inWindow = (dLike) => {
      const dt = toDate(dLike);
      if (!dt) return false;
      const t = dt.getTime();
      return t >= startMs && t <= endMs;
    };
    const hasPaymentLineInWindow = (p) =>
      Array.isArray(p.PaymentLines) &&
      p.PaymentLines.some((pl) => inWindow(pl?.PayDate || pl?.Date));
    const paidPurchases = purchases.filter((p) => {
      // If the purchase already has an explicit TaxYear/TaxMonth, honour it
      // and skip date-window matching to avoid double-counting across months.
      if (p.TaxYear != null && p.TaxMonth != null) {
        return p.TaxYear === specifiedYear && p.TaxMonth === specifiedMonth;
      }
      return inWindow(p.PaidDate) || hasPaymentLineInWindow(p);
    });

    // Suppliers for those purchases — only those with a valid HMRC verification number
    // Normalize supplier IDs to numbers to avoid type-mismatch on lookup
    const supplierIDs = [
      ...new Set(
        (paidPurchases || [])
          .map((p) => Number(p?.SupplierId))
          .filter((n) => Number.isFinite(n)),
      ),
    ];
    // Optional debugging escape hatch: include all suppliers if requested
    const includeAllSuppliers =
      req.query.includeAll === "1" ||
      req.query.includeNonSubcontractors === "1";
    const VERIFICATION_REGEX = /^V\d{7,10}(\/[A-Z]{1,2})?$/;
    const supplierQuery = includeAllSuppliers
      ? { Id: { $in: supplierIDs } }
      : {
          Id: { $in: supplierIDs },
          WithholdingTaxReferences: {
            $elemMatch: {
              Name: 'Verification Number',
              Value: { $regex: VERIFICATION_REGEX }
            }
          }
        };
    const subbieSuppliers = await mdb.REST.supplier
      .find(supplierQuery)
      .sort({ Name: 1 })
      .lean();

    const allowedSupplierIds = new Set(
      subbieSuppliers.map((s) => String(s.Id)),
    );
    const filteredPurchases = paidPurchases.filter((p) =>
      allowedSupplierIds.has(String(p.SupplierId)),
    );

    // CIS rate map per supplier id
    const cisRateBySupplierId = new Map();
    for (const s of subbieSuppliers) {
      // OLD: let rate = s.CISRate != null ? Number(s.CISRate) : null;
      // NEW: use WithholdingTaxRate; -1 means N/A, treat as null
      let rate = s.WithholdingTaxRate != null ? Number(s.WithholdingTaxRate) : null;
      if (!Number.isFinite(rate) || rate < 0) rate = null; // null means unknown
      cisRateBySupplierId.set(String(s.Id), rate);
    }

    // Totals per supplier
    const supplierTotals = {};
    const cisDebug = process.env.CIS_DEBUG_NOMINALS === "true";
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

      const hasLineItems =
        Array.isArray(purchase.LineItems) && purchase.LineItems.length > 0;
      const hasLines =
        Array.isArray(purchase.Lines) && purchase.Lines.length > 0;
      const lines = hasLineItems
        ? purchase.LineItems
        : hasLines
          ? purchase.Lines
          : [];
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
            firstLineKeys: lines[0] ? Object.keys(lines[0]) : [],
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
            if (name)
              nominalNameCounts.set(
                name,
                (nominalNameCounts.get(name) || 0) + 1,
              );
          }
        }
        const chargeType =
          line.ChargeType != null ? Number(line.ChargeType) : null;
        const qty = Number(line.Quantity ?? line.Qty) || 0;
        const rate =
          Number(line.Rate ?? line.UnitPrice ?? line.Price ?? line.Unit) || 0;
        const amount =
          line.Amount != null && line.Amount !== ""
            ? Number(line.Amount)
            : line.NetAmount != null && line.NetAmount !== ""
              ? Number(line.NetAmount)
              : rate * qty;

        // Primary: ChargeType enum IDs (from KashFlow API)
        if (chargeType === cisMappings.chargeTypes.materials) {
          supplierTotals[supplierId].materialsCost += amount;
          continue;
        }
        if (chargeType === cisMappings.chargeTypes.labour) {
          supplierTotals[supplierId].labourCost += amount;
          continue;
        }
        if (chargeType === cisMappings.chargeTypes.cisDeduction) {
          supplierTotals[supplierId].cisDeductions += Math.abs(amount);
          continue;
        }

        // REST heuristic classification
        const nc = Number(line.NominalCode) || null;
        const nn = (line.NominalName || line.Description || "")
          .toString()
          .toLowerCase();
        if (nc && cisMappings.materialsNominalCodes.includes(nc)) {
          supplierTotals[supplierId].materialsCost += amount;
          continue;
        }
        if (nc && cisMappings.labourNominalCodes.includes(nc)) {
          supplierTotals[supplierId].labourCost += amount;
          continue;
        }
        if (
          nc &&
          Array.isArray(cisMappings.cisDeductionNominalCodes) &&
          cisMappings.cisDeductionNominalCodes.includes(nc)
        ) {
          supplierTotals[supplierId].cisDeductions += Math.abs(amount);
          continue;
        }
        // Fallback by name hints
        if (nn.includes("material")) {
          supplierTotals[supplierId].materialsCost += amount;
          continue;
        }
        if (
          nn.includes("labour") ||
          nn.includes("labor") ||
          nn.includes("subcontract")
        ) {
          supplierTotals[supplierId].labourCost += amount;
          continue;
        }
      }

      // Emit debug log if enabled
      if (cisDebug) {
        const codesSorted = Array.from(nominalCodeCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([code, count]) => ({ code, count }));
        const namesSorted = Array.from(nominalNameCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([name, count]) => ({ name, count }));
        const summary = {
          year: specifiedYear,
          month: specifiedMonth,
          suppliersConsidered: subbieSuppliers.length,
          purchasesConsidered: filteredPurchases.length,
          topNominalCodes: codesSorted.slice(0, 20),
          topNominalNames: namesSorted.slice(0, 20),
          usedLineItems: debugStats.usedLineItems,
          usedLines: debugStats.usedLines,
          emptyLines: debugStats.emptyLines,
          samples: debugSamples,
        };
        // File transport keeps meta; console prints the message only, so include JSON in message too
        logger.info("[CIS_DEBUG_NOMINALS] " + JSON.stringify(summary));
        logger.info(
          "[CIS_DEBUG_NOMINALS] Distinct NominalCodes and NominalNames (full)",
          {
            year: summary.year,
            month: summary.month,
            suppliersConsidered: summary.suppliersConsidered,
            purchasesConsidered: summary.purchasesConsidered,
            nominalCodes: codesSorted.slice(0, 100),
            nominalNames: namesSorted.slice(0, 100),
          },
        );
      }

      // Reverse charge may not be present on purchases model; keep zero if absent
      supplierTotals[supplierId].reverseChargeVAT += Number(
        purchase.CISRCVatAmount || 0,
      );
      supplierTotals[supplierId].reverseChargeNet += Number(
        purchase.CISRCNetAmount || 0,
      );
      supplierTotals[supplierId].grossAmount =
        supplierTotals[supplierId].materialsCost +
        supplierTotals[supplierId].labourCost;
    }

    // Compute fallback CIS deduction from labour * CISRate when explicit cis line is zero
    for (const [sid, totals] of Object.entries(supplierTotals)) {
      const rate = normalizeWhtRate(cisRateBySupplierId.get(sid));
      totals.calculatedCISDeduction = rate ? totals.labourCost * rate : 0;
    }

    // Submission flags based on purchases
    const allPurchasesSubmitted =
      filteredPurchases.length > 0 &&
      filteredPurchases.every(
        (p) => p.SubmissionDate && p.SubmissionDate !== "0000-00-00 00:00:00",
      );
    const submissionDate =
      allPurchasesSubmitted && filteredPurchases.length > 0
        ? filteredPurchases[0].SubmissionDate
        : null;

    const previousMonth = specifiedMonth === 1 ? 12 : specifiedMonth - 1;
    const previousYear =
      specifiedMonth === 1 ? specifiedYear - 1 : specifiedYear;
    const nextMonth = specifiedMonth === 12 ? 1 : specifiedMonth + 1;
    const nextYear = specifiedMonth === 12 ? specifiedYear + 1 : specifiedYear;

    // Use the actual Date for periodEnd to avoid double-formatting and preserve type for slimDateTime
    const periodEnd = moment(currentMonthlyReturn.periodEnd);
    const submissionStartDate = periodEnd.clone().date(7).toDate();
    const submissionEndDate = periodEnd.clone().date(11).toDate();

    // Decorate purchases for view list
    const purchasesForView = filteredPurchases.map((p) => {
      // Compute a display paid date preferring header PaidDate in-window, else first payment line in-window
      let displayPaidDate = inWindow(p.PaidDate) ? toDate(p.PaidDate) : null;
      if (!displayPaidDate && Array.isArray(p.PaymentLines)) {
        const lineDates = p.PaymentLines.map((pl) =>
          toDate(pl?.PayDate || pl?.Date),
        )
          .filter(
            (dt) => dt && dt.getTime() >= startMs && dt.getTime() <= endMs,
          )
          .sort((a, b) => a - b);
        displayPaidDate = lineDates.length ? lineDates[lineDates.length - 1] : null;
      }
      const isPaid = !!displayPaidDate;
      const displayDateRaw = isPaid
        ? displayPaidDate
        : toDate(p.IssuedDate) || null;
      const m = displayDateRaw
        ? moment.tz(displayDateRaw, "Europe/London")
        : null;
      const due = p.DueDate ? moment.tz(p.DueDate, "Europe/London") : null;
      return {
        ...p,
        isPaid,
        displayDateLabel: isPaid ? "Paid" : "Issued",
        displayDate: m ? m.format("Do MMM YYYY") : "",
        timeZoneTag: m ? (m.isDST() ? "BST" : "GMT") : "",
        dueDateStr: due ? due.format("Do MMM YYYY") : "",
      };
    });

    // Light diagnostics to help understand empty results in production (info-level)
    try {
      if (purchasesRaw.length > 0 && purchases.length === 0) {
        const sample = purchasesRaw
          .slice(0, 5)
          .map((p) => ({
            id: p.Id,
            deletedAt: p.deletedAt,
            DeletedAt: p.DeletedAt,
            deleted: p.deleted,
            isDeleted: p.isDeleted,
          }));
        logger.info(
          `[CIS] all filtered as deleted; sample deletedAt values: ${JSON.stringify(sample)}`,
        );
      }
      if (paidPurchases.length > 0 && subbieSuppliers.length === 0) {
        const ids = [
          ...new Set(
            paidPurchases.map((p) => p?.SupplierId).filter((x) => x != null),
          ),
        ].slice(0, 10);
        const supplierProbe = (subbieSuppliers || [])
          .filter((s) => ids.map(String).includes(String(s.Id)))
          .map((s) => ({
            Id: s.Id,
            Name: s.Name,
            // OLD: Subcontractor: s.Subcontractor, IsSubcontractor: s.IsSubcontractor,
            WithholdingTaxRate: s.WithholdingTaxRate,
          }));
        logger.info(
          `[CIS] paid purchases exist but no subcontractors detected; sample suppliers: ${JSON.stringify(supplierProbe)}`,
        );
      }
      logger.info(
        `[CIS] query: purchasesRaw=${purchasesRaw.length}, notDeleted=${purchases.length}, paid=${paidPurchases.length}, suppliers=${subbieSuppliers.length}, filtered=${filteredPurchases.length}, includeAllSuppliers=${includeAllSuppliers}`,
      );
    } catch (e) {
      logger.warn("[CIS] diagnostic logging failed: %s", e.message);
    }

    res.render(path.join("tailwindcss", "cis", "cisDashboard"), {
      title: "CIS Submission Dashboard",
      supplierCount: subbieSuppliers.length,
      purchaseCount: filteredPurchases.length,
      suppliers: subbieSuppliers,
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
      debug:
        req.query.debug === "1"
          ? await (async () => {
              // Per-condition counts
              const conditionCounts = {};
              for (let i = 0; i < orConditions.length; i++) {
                conditionCounts[`condition_${i}`] =
                  await mdb.REST.purchase.countDocuments(orConditions[i]);
              }
              // Database-wide stats
              const totalPurchases = await mdb.REST.purchase.countDocuments({});
              const taxYearMonthAgg = await mdb.REST.purchase.aggregate([
                {
                  $group: {
                    _id: { TaxYear: "$TaxYear", TaxMonth: "$TaxMonth" },
                    count: { $sum: 1 },
                  },
                },
                { $sort: { "_id.TaxYear": -1, "_id.TaxMonth": -1 } },
                { $limit: 20 },
              ]);
              const latestPaid = await mdb.REST.purchase
                .find({ PaidDate: { $ne: null } })
                .sort({ PaidDate: -1 })
                .limit(3)
                .select("Id Number SupplierName PaidDate TaxYear TaxMonth")
                .lean();
              const latestIssued = await mdb.REST.purchase
                .find({ IssuedDate: { $ne: null } })
                .sort({ IssuedDate: -1 })
                .limit(3)
                .select("Id Number SupplierName IssuedDate TaxYear TaxMonth")
                .lean();
              const latestPaymentLine = await mdb.REST.purchase
                .find({ "PaymentLines.0": { $exists: true } })
                .sort({ "PaymentLines.PayDate": -1 })
                .limit(3)
                .select("Id Number SupplierName PaymentLines TaxYear TaxMonth")
                .lean();

              return {
                params: { year: specifiedYear, month: specifiedMonth },
                periodStart: currentMonthlyReturn.periodStart,
                periodEnd: currentMonthlyReturn.periodEnd,
                mongoQuery: JSON.parse(JSON.stringify({ $or: orConditions })),
                conditionCounts,
                purchasesRawCount: purchasesRaw.length,
                purchasesAfterDeleteFilter: purchases.length,
                paidPurchasesCount: paidPurchases.length,
                supplierIDsFromPaid: supplierIDs.slice(0, 20),
                suppliersFoundCount: subbieSuppliers.length,
                subbieCount: subbieSuppliers.length,
                filteredPurchasesCount: filteredPurchases.length,
                includeAllSuppliers,
                dbStats: {
                  totalPurchases,
                  missingTaxYearMonth: await mdb.REST.purchase.countDocuments({
                    $or: [
                      { TaxYear: null },
                      { TaxYear: { $exists: false } },
                      { TaxMonth: null },
                      { TaxMonth: { $exists: false } },
                    ],
                  }),
                  taxYearMonthDistribution: taxYearMonthAgg.map((r) => ({
                    ...r._id,
                    count: r.count,
                  })),
                  latestPaidDates: latestPaid,
                  latestIssuedDates: latestIssued,
                  latestPaymentLineDates: latestPaymentLine.map((p) => ({
                    Id: p.Id,
                    Number: p.Number,
                    SupplierName: p.SupplierName,
                    TaxYear: p.TaxYear,
                    TaxMonth: p.TaxMonth,
                    PaymentLineDates: (p.PaymentLines || [])
                      .map((pl) => pl?.PayDate || pl?.Date)
                      .slice(0, 3),
                  })),
                  // Check field types: sample a purchase with PaidDate to see if it's a Date or string
                  fieldTypeCheck: await (async () => {
                    const sample = await mdb.REST.purchase.collection.findOne({
                      PaidDate: { $ne: null },
                    });
                    if (!sample) return null;
                    return {
                      PaidDate_value: sample.PaidDate,
                      PaidDate_type: typeof sample.PaidDate,
                      PaidDate_isDate: sample.PaidDate instanceof Date,
                      IssuedDate_value: sample.IssuedDate,
                      IssuedDate_type: typeof sample.IssuedDate,
                      IssuedDate_isDate: sample.IssuedDate instanceof Date,
                      TaxYear_value: sample.TaxYear,
                      TaxYear_type: typeof sample.TaxYear,
                      TaxMonth_value: sample.TaxMonth,
                      TaxMonth_type: typeof sample.TaxMonth,
                    };
                  })(),
                  // Purchases with dates in the window but no TaxYear/TaxMonth
                  purchasesInWindowMissingTax: await mdb.REST.purchase
                    .find({
                      $and: [
                        {
                          $or: [
                            { TaxYear: null },
                            { TaxYear: { $exists: false } },
                          ],
                        },
                        {
                          $or: [
                            {
                              PaidDate: {
                                $gte: new Date(
                                  currentMonthlyReturn.periodStart,
                                ),
                                $lte: new Date(currentMonthlyReturn.periodEnd),
                              },
                            },
                            {
                              IssuedDate: {
                                $gte: new Date(
                                  currentMonthlyReturn.periodStart,
                                ),
                                $lte: new Date(currentMonthlyReturn.periodEnd),
                              },
                            },
                          ],
                        },
                      ],
                    })
                    .limit(5)
                    .select(
                      "Id Number SupplierName PaidDate IssuedDate TaxYear TaxMonth",
                    )
                    .lean(),
                },
                sampleRawPurchases: purchasesRaw.slice(0, 5).map((p) => ({
                  Id: p.Id,
                  Number: p.Number,
                  SupplierId: p.SupplierId,
                  SupplierName: p.SupplierName,
                  PaidDate: p.PaidDate,
                  IssuedDate: p.IssuedDate,
                  TaxYear: p.TaxYear,
                  TaxMonth: p.TaxMonth,
                  PaymentLinesCount: Array.isArray(p.PaymentLines)
                    ? p.PaymentLines.length
                    : 0,
                  PaymentLineDates: (p.PaymentLines || [])
                    .slice(0, 3)
                    .map((pl) => pl?.PayDate || pl?.Date || null),
                  deletedAt: p.deletedAt || p.DeletedAt || null,
                })),
                sampleSuppliers: subbieSuppliers.slice(0, 10).map((s) => ({
                  Id: s.Id,
                  Name: s.Name,
                  // OLD: Subcontractor: s.Subcontractor, IsSubcontractor: s.IsSubcontractor, CISRate: s.CISRate,
                  WithholdingTaxRate: s.WithholdingTaxRate,
                  WithholdingTaxReferences: s.WithholdingTaxReferences,
                })),
              };
            })()
          : null,
    });
  } catch (error) {
    logger.error(`Error rendering CIS dashboard Mongo: ${error.message}`, {
      stack: error.stack,
    });
    req.flash("error", "Failed to load the CIS dashboard. Please try again.");
    next(error);
  }
};

exports.redirectCIS = (req, res, next) => {
  const { taxYear, taxMonth } = taxService.calculateTaxYearAndMonth(moment());
  return res.redirect(`/CIS/Dashboard/${taxYear}/${taxMonth}`);
};
