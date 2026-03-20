// mongoose/services/paperless/purchaseDraftService.js
// Build a KashFlow-style purchase draft JSON from a PAPERLESS OcrDocument.
// This is consumed by an external creator; we only produce the draft here.

const mdb = require("../mongooseDatabaseService");

// Default name-based mapping from custom field names to target purchase fields
const defaultMap = {
  SupplierName: ["Supplier", "Supplier Name", "Vendor", "Vendor Name"],
  SupplierCode: ["Supplier Code", "Vendor Code"],
  // Prefer explicit invoice number over generic reference labels
  SupplierReference: [
    "Invoice Number",
    "Invoice No",
    "Invoice #",
    "Inv No",
    "Inv #",
    "Supplier Reference",
    "Reference",
    "Ref",
    "Doc No",
    "Document Number",
  ],
  IssuedDate: ["Invoice Date", "Date", "Document Date"],
  DueDate: [
    "Due Date",
    "Invoice Due Date",
    "Payment Due",
    "Payment Due Date",
    "Due By",
    "Pay By",
    "Pay By Date",
  ],
  NetAmount: ["Net", "Net Amount", "Subtotal", "Total Goods"],
  VATAmount: ["VAT", "VAT Amount", "Tax", "Tax Amount", "Total VAT"],
  GrossAmount: ["Gross", "Total", "Total Amount", "Amount", "Invoice Total"],
  Currency: ["Currency", "Curr", "ISO Currency"],
  Notes: ["Notes", "Memo", "Description", "Summary"],
  LineItems: ["LineItems", "Line Items", "Items"], // optional JSON string or array
};

function normalizeName(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}
function normalizeKey(s) {
  return normalizeName(s).replace(/[^a-z0-9]+/g, "");
}

function findCustomField(customFields, names) {
  if (!Array.isArray(customFields) || customFields.length === 0)
    return undefined;
  const nameList = Array.isArray(names) ? names : [];
  const wanted = new Set(nameList.map(normalizeName));
  const wantedKeys = new Set(nameList.map(normalizeKey));

  // Pass 1: exact normalized match
  for (const cf of customFields) {
    const n = normalizeName(cf.fieldName);
    if (wanted.has(n)) return cf.value;
  }
  // Pass 2: normalized key (strips spaces/punct) match
  for (const cf of customFields) {
    const k = normalizeKey(cf.fieldName);
    if (wantedKeys.has(k)) return cf.value;
  }
  // Pass 3: prefix match on normalized key (fallback)
  for (const cf of customFields) {
    const k = normalizeKey(cf.fieldName);
    for (const w of wantedKeys) {
      if (w && k.startsWith(w)) return cf.value;
    }
  }
  return undefined;
}

function parseMoney(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  const cleaned = v.replace(/[^0-9.,-]/g, "").replace(/,(?=\d{3}\b)/g, "");
  // Prefer dot as decimal; if only comma present, swap it
  const normalized =
    cleaned.indexOf(".") >= 0 ? cleaned : cleaned.replace(",", ".");
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : undefined;
}

function parseDate(v) {
  if (!v) return undefined;
  if (v instanceof Date && !isNaN(v)) return v;
  if (typeof v === "string") {
    // Support common formats: YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY
    const s = v.trim();
    const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m) {
      const [, dd, mm, yyyy] = m;
      const d = new Date(
        Date.UTC(parseInt(yyyy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10)),
      );
      return isNaN(d) ? undefined : d;
    }
    const d2 = new Date(s);
    return isNaN(d2) ? undefined : d2;
  }
  return undefined;
}

function coalesce(...vals) {
  return vals.find((v) => v !== undefined && v !== null && v !== "");
}

/**
 * Build a purchase draft object from an OcrDocument record.
 * @param {object} ocr - OcrDocument document (lean or hydrated)
 * @param {object} opts - { mapping, currencyDefault }
 * @returns {object} draft
 */
function buildPurchaseDraftFromOcr(ocr, opts = {}) {
  if (!ocr || typeof ocr !== "object") throw new Error("ocr document required");
  const mapping = { ...defaultMap, ...(opts.mapping || {}) };
  const cf = Array.isArray(ocr.customFields) ? ocr.customFields : [];

  const supplierName = coalesce(
    findCustomField(cf, mapping.SupplierName),
    ocr.correspondent && ocr.correspondent.name,
  );
  const supplierCode = findCustomField(cf, mapping.SupplierCode);
  // Supplier reference: prefer explicit invoice number; robust fallback if blank
  let supplierRef = findCustomField(cf, mapping.SupplierReference);
  if (
    supplierRef == null ||
    (typeof supplierRef === "string" && supplierRef.trim() === "")
  ) {
    // Fallback: strict match on "invoice number" ignoring non-alphanumeric
    const normKey = (s) =>
      String(s || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
    const invCf = cf.find((x) => normKey(x.fieldName) === "invoicenumber");
    if (
      invCf &&
      invCf.value != null &&
      !(typeof invCf.value === "string" && invCf.value.trim() === "")
    ) {
      supplierRef = invCf.value;
    }
  }

  const issuedDate = coalesce(
    parseDate(findCustomField(cf, mapping.IssuedDate)),
    parseDate(ocr.created),
  );
  const dueDate = parseDate(findCustomField(cf, mapping.DueDate));

  const net = parseMoney(findCustomField(cf, mapping.NetAmount));
  const vat = parseMoney(findCustomField(cf, mapping.VATAmount));
  const gross = parseMoney(findCustomField(cf, mapping.GrossAmount));
  const currency = coalesce(
    findCustomField(cf, mapping.Currency),
    opts.currencyDefault || process.env.DEFAULT_CURRENCY || "GBP",
  );

  let netAmount = net,
    vatAmount = vat,
    grossAmount = gross;
  if (netAmount != null && grossAmount != null && vatAmount == null) {
    const v = +(grossAmount - netAmount).toFixed(2);
    vatAmount = Number.isFinite(v) ? v : vatAmount;
  }
  if (netAmount == null && grossAmount != null && vatAmount != null) {
    const n = +(grossAmount - vatAmount).toFixed(2);
    netAmount = Number.isFinite(n) ? n : netAmount;
  }
  if (grossAmount == null && netAmount != null && vatAmount != null) {
    const g = +(netAmount + vatAmount).toFixed(2);
    grossAmount = Number.isFinite(g) ? g : grossAmount;
  }

  // When all three amounts are present but Net + VAT ≠ Gross, one is likely an OCR
  // extraction failure.  A zero Net paired with positive Gross/VAT is the most common
  // case (OCR returns "0" for Total Goods when it can't read the field).
  if (netAmount != null && vatAmount != null && grossAmount != null) {
    const headerSum = +(netAmount + vatAmount).toFixed(2);
    if (Math.abs(headerSum - grossAmount) > 0.01) {
      if (netAmount === 0 && grossAmount > 0) {
        const recalcNet = +(grossAmount - vatAmount).toFixed(2);
        if (Number.isFinite(recalcNet) && recalcNet > 0) {
          netAmount = recalcNet;
        }
      } else if (grossAmount === 0 && netAmount + vatAmount > 0) {
        grossAmount = headerSum;
      }
    }
  }

  // Line items: try to read as JSON; else single-line fallback
  let lineItemsRaw = findCustomField(cf, mapping.LineItems);
  let lineItems = undefined;
  let enumeratedItems = undefined; // debug capture of _LineN parsing
  let corrections = []; // debug capture of auto-corrections applied to lines
  if (lineItemsRaw != null) {
    if (Array.isArray(lineItemsRaw)) {
      lineItems = lineItemsRaw;
    } else if (typeof lineItemsRaw === "string") {
      try {
        lineItems = JSON.parse(lineItemsRaw);
      } catch (_) {
        /* ignore */
      }
    }
  }

  // Parse enumerated custom fields like Description_Line1, Qty_Line1, Price_Line1, Net_Line1, VAT_Line1, Gross_Line1, Nominal_Line1
  // Any suffix _LineN (or variations like _line N) will be grouped by N into line items.
  const lineGroups = new Map(); // index -> partial line object
  const toKey = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  const num = (v) => {
    if (v == null || v === "") return undefined;
    if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
    const n = parseMoney(String(v));
    return Number.isFinite(n) ? n : undefined;
  };
  for (const c of cf) {
    if (!c || !c.fieldName) continue;
    const name = String(c.fieldName).trim();
    // Support various patterns:
    // 1) Description_Line1  => base: Description, idx: 1
    // 2) Description 1      => base: Description, idx: 1
    // 3) Description_line_1 => base: Description, idx: 1
    // 4) Description_1      => base: Description, idx: 1
    // 5) Line1_Description  => base: Description, idx: 1
    // 6) line 1 description => base: description, idx: 1
    let baseRaw = null;
    let idx = null;
    let m = name.match(/(.+?)[_\s-]*line\s*(\d+)\s*$/i); // base + 'lineN'
    if (!m) m = name.match(/(.+?)[_\s-]*(\d+)\s*$/i); // base + 'N'
    if (m) {
      baseRaw = m[1];
      idx = parseInt(m[2], 10);
    } else {
      // Try 'lineN_base'
      let m2 = name.match(/^line\s*(\d+)[_\s-]*(.+)$/i);
      if (!m2) m2 = name.match(/^(\d+)[_\s-]+(.+)$/i); // 'N_base'
      if (m2) {
        idx = parseInt(m2[1], 10);
        baseRaw = m2[2];
      }
    }
    if (!Number.isFinite(idx) || idx <= 0 || !baseRaw) continue;
    const base = toKey(baseRaw);
    if (!lineGroups.has(idx)) lineGroups.set(idx, {});
    const entry = lineGroups.get(idx);
    // Map base tokens to fields
    if (base === "description" || base === "desc")
      entry.Description = String(c.value ?? "").toString();
    else if (base === "qty" || base === "quantity")
      entry.Quantity = num(c.value);
    else if (base === "price" || base === "unitprice" || base === "rate")
      entry.UnitPrice = num(c.value);
    else if (
      base === "net" ||
      base === "netamount" ||
      base === "subtotal" ||
      base === "totalgoods"
    )
      entry.NetAmount = num(c.value);
    else if (
      base === "vat" ||
      base === "vatamount" ||
      base === "tax" ||
      base === "taxamount" ||
      base === "totalvat"
    ) {
      // Capture original string to detect percentage intent (e.g., "20%" or integer 20)
      const raw = c.value;
      entry.__VATOrig = raw;
      entry.__VATHasDecimal =
        typeof raw === "string" ? /[.,]/.test(raw) : false;
      entry.__VATHasPercentSymbol =
        typeof raw === "string" ? /%/.test(raw) : false;
      entry.VATAmount = num(raw);
    }
    // For enumerated lines, fields named "Total_LineN" typically represent the line NET total.
    // Map ambiguous 'total' to NetAmount here to respect provided per-line totals
    // and avoid discrepancies from qty*price rounding. Reserve 'gross' tokens for GrossAmount.
    else if (base === "total" || base === "totalamount") {
      entry.NetAmount = num(c.value);
      entry.__NetCameFromTotalField = true;
    } else if (
      base === "gross" ||
      base === "grossamount" ||
      base === "invoicetotal"
    ) {
      entry.GrossAmount = num(c.value);
    } else if (base === "nominal" || base === "nominalcode") {
      const n = num(c.value);
      entry.NominalCode = Number.isFinite(n) ? Number(n) : undefined;
    }
  }
  if (lineGroups.size > 0) {
    // Compose sorted line items
    const items = [];
    const indices = Array.from(lineGroups.keys()).sort((a, b) => a - b);
    for (const i of indices) {
      const li = lineGroups.get(i) || {};
      // If VAT is provided as a percent, convert to monetary amount and carry VATLevel
      const maybePercent = (v, hasDecimal, hasPct) => {
        if (hasPct) return true;
        if (v == null) return false;
        if (typeof v !== "number" || !Number.isFinite(v)) return false;
        if (hasDecimal) return false; // likely a monetary value, not integer percent
        // Treat whole numbers in [0,100] as percent
        return v >= 0 && v <= 100 && Math.floor(v) === v;
      };
      const asMoney = (x) => (Number.isFinite(x) ? +x.toFixed(2) : undefined);
      const origVATNumeric = li.VATAmount;
      if (
        maybePercent(
          origVATNumeric,
          !!li.__VATHasDecimal,
          !!li.__VATHasPercentSymbol,
        )
      ) {
        // Preserve the VAT percentage as VATLevel for KashFlow payload, rounded to nearest 5%
        if (
          typeof origVATNumeric === "number" &&
          Number.isFinite(origVATNumeric)
        ) {
          li.VATLevel = Math.round(origVATNumeric / 5) * 5;
        }
        const pct = origVATNumeric / 100;
        // Prefer Net to compute VAT; derive Net first when possible
        let netBase = li.NetAmount;
        if (netBase == null && li.Quantity != null && li.UnitPrice != null) {
          netBase = asMoney(li.Quantity * li.UnitPrice);
          if (netBase != null) li.NetAmount = netBase;
        }
        if (netBase != null) {
          li.VATAmount = asMoney(netBase * pct);
          if (li.GrossAmount == null)
            li.GrossAmount = asMoney(netBase + li.VATAmount);
        } else if (li.GrossAmount != null) {
          // If only Gross present, back-compute Net from percentage
          const netFromGross = asMoney(li.GrossAmount / (1 + pct));
          if (netFromGross != null) {
            li.NetAmount = netFromGross;
            li.VATAmount = asMoney(li.GrossAmount - netFromGross);
          }
        }
      }
      // Compute derived amounts if possible
      if (li.NetAmount == null && li.Quantity != null && li.UnitPrice != null) {
        const n = +(li.Quantity * li.UnitPrice).toFixed(2);
        if (Number.isFinite(n)) li.NetAmount = n;
      }
      // If NetAmount is present but inconsistent with Qty×UnitPrice, correct it
      if (
        li.Quantity != null &&
        li.UnitPrice != null &&
        typeof li.NetAmount === "number" &&
        Number.isFinite(li.NetAmount)
      ) {
        const expectedNet = +(li.Quantity * li.UnitPrice).toFixed(2);
        if (
          Number.isFinite(expectedNet) &&
          Math.abs(li.NetAmount - expectedNet) >= 0.01
        ) {
          corrections.push({
            Line: i,
            Field: "NetAmount",
            From: li.NetAmount,
            To: expectedNet,
            Reason: "Qty×UnitPrice",
          });
          li.NetAmount = expectedNet;
        }
      }
      if (
        li.GrossAmount == null &&
        li.NetAmount != null &&
        li.VATAmount != null
      ) {
        const g = +(li.NetAmount + li.VATAmount).toFixed(2);
        if (Number.isFinite(g)) li.GrossAmount = g;
      }
      if (
        li.VATAmount == null &&
        li.NetAmount != null &&
        li.GrossAmount != null
      ) {
        const v = +(li.GrossAmount - li.NetAmount).toFixed(2);
        if (Number.isFinite(v)) li.VATAmount = v;
      }
      // If NetAmount changed or exists, ensure dependent fields are consistent
      if (typeof li.NetAmount === "number" && Number.isFinite(li.NetAmount)) {
        if (typeof li.VATLevel === "number" && Number.isFinite(li.VATLevel)) {
          const pct = li.VATLevel / 100;
          const newVat = +(li.NetAmount * pct).toFixed(2);
          if (li.VATAmount == null || Math.abs(li.VATAmount - newVat) >= 0.01) {
            corrections.push({
              Line: i,
              Field: "VATAmount",
              From: li.VATAmount ?? null,
              To: newVat,
              Reason: "VATLevel% of Net",
            });
            li.VATAmount = newVat;
          }
          const newGross = +(li.NetAmount + (li.VATAmount || 0)).toFixed(2);
          if (
            li.GrossAmount == null ||
            Math.abs(li.GrossAmount - newGross) >= 0.01
          ) {
            corrections.push({
              Line: i,
              Field: "GrossAmount",
              From: li.GrossAmount ?? null,
              To: newGross,
              Reason: "Net + VAT",
            });
            li.GrossAmount = newGross;
          }
        } else if (
          li.VATAmount != null &&
          typeof li.VATAmount === "number" &&
          Number.isFinite(li.VATAmount)
        ) {
          const newGross = +(li.NetAmount + li.VATAmount).toFixed(2);
          if (
            li.GrossAmount == null ||
            Math.abs(li.GrossAmount - newGross) >= 0.01
          ) {
            corrections.push({
              Line: i,
              Field: "GrossAmount",
              From: li.GrossAmount ?? null,
              To: newGross,
              Reason: "Net + VAT",
            });
            li.GrossAmount = newGross;
          }
        } else if (
          li.GrossAmount != null &&
          typeof li.GrossAmount === "number" &&
          Number.isFinite(li.GrossAmount)
        ) {
          const newVat = +(li.GrossAmount - li.NetAmount).toFixed(2);
          if (li.VATAmount == null || Math.abs(li.VATAmount - newVat) >= 0.01) {
            corrections.push({
              Line: i,
              Field: "VATAmount",
              From: li.VATAmount ?? null,
              To: newVat,
              Reason: "Gross - Net",
            });
            li.VATAmount = newVat;
          }
        }
      }
      // Only include lines that have at least a description or a numeric amount/qty
      const hasContent =
        (li.Description && String(li.Description).trim() !== "") ||
        [
          li.Quantity,
          li.UnitPrice,
          li.NetAmount,
          li.VATAmount,
          li.GrossAmount,
          li.NominalCode,
        ].some((v) => v != null && v !== "");
      if (hasContent) {
        items.push({
          Description: li.Description || undefined,
          Quantity: li.Quantity != null ? li.Quantity : undefined,
          UnitPrice: li.UnitPrice != null ? li.UnitPrice : undefined,
          NetAmount: li.NetAmount != null ? li.NetAmount : undefined,
          VATAmount: li.VATAmount != null ? li.VATAmount : undefined,
          VATLevel: li.VATLevel != null ? li.VATLevel : undefined,
          GrossAmount: li.GrossAmount != null ? li.GrossAmount : undefined,
          NominalCode: li.NominalCode != null ? li.NominalCode : undefined,
        });
      }
    }
    if (items.length > 0) {
      lineItems = items;
      enumeratedItems = items;
      // If header totals are missing, derive them from line sums
      const sums = items.reduce(
        (acc, it) => {
          acc.net += typeof it.NetAmount === "number" ? it.NetAmount : 0;
          acc.vat += typeof it.VATAmount === "number" ? it.VATAmount : 0;
          acc.gross += typeof it.GrossAmount === "number" ? it.GrossAmount : 0;
          return acc;
        },
        { net: 0, vat: 0, gross: 0 },
      );
      sums.net = +sums.net.toFixed(2);
      sums.vat = +sums.vat.toFixed(2);
      sums.gross = +sums.gross.toFixed(2);
      if (netAmount == null) netAmount = sums.net;
      if (vatAmount == null) vatAmount = sums.vat;
      if (grossAmount == null) grossAmount = sums.gross;

      // Reconcile small rounding drift between header VAT and sum of line VATs by nudging a single line
      // This addresses cases like 5 lines at 20% where per-line rounding leads to a 0.01 difference
      if (typeof vatAmount === "number") {
        const sumVat = sums.vat;
        const drift = +(vatAmount - sumVat).toFixed(2);
        // Only attempt to adjust when the drift is a single penny (or very small)
        if (Math.abs(drift) >= 0.005 && Math.abs(drift) <= 0.02) {
          // Pick the last line that has a numeric VATAmount (common accounting practice)
          let adjustIdx = -1;
          for (let k = items.length - 1; k >= 0; k--) {
            if (typeof items[k].VATAmount === "number") {
              adjustIdx = k;
              break;
            }
          }
          if (adjustIdx >= 0) {
            const li = items[adjustIdx];
            li.VATAmount = +((li.VATAmount || 0) + drift).toFixed(2);
            if (typeof li.NetAmount === "number") {
              li.GrossAmount = +(li.NetAmount + li.VATAmount).toFixed(2);
            } else if (typeof li.GrossAmount === "number") {
              li.NetAmount = +(li.GrossAmount - li.VATAmount).toFixed(2);
            }
            // mark debug for UI/traceability
            var __ROUND_ADJUST__ = {
              LineAdjusted: adjustIdx + 1,
              Field: "VATAmount",
              Drift: drift,
            };
          }
        }
      }

      // Penny-balance net/gross to match consistent header when VAT already matches
      //
      // Rationale:
      //  - When the header totals (Net/VAT/Gross) are present and internally consistent,
      //    we treat them as the source of truth.
      //  - Small rounding noise can leave the sum of line Net/Gross off by a penny or two
      //    even when the sum of line VAT already matches the header VAT.
      //  - In that specific, safe scenario, nudge a single line (the last one with NetAmount)
      //    by the tiny drift so the lines sum exactly to the header, without altering VAT.
      try {
        // Compute current sums from the (possibly corrected) line items
        const sums2 = items.reduce(
          (acc, it) => {
            acc.net += typeof it.NetAmount === "number" ? it.NetAmount : 0;
            acc.vat += typeof it.VATAmount === "number" ? it.VATAmount : 0;
            acc.gross +=
              typeof it.GrossAmount === "number" ? it.GrossAmount : 0;
            return acc;
          },
          { net: 0, vat: 0, gross: 0 },
        );
        // Round to two decimals to emulate accounting precision
        sums2.net = +sums2.net.toFixed(2);
        sums2.vat = +sums2.vat.toFixed(2);
        sums2.gross = +sums2.gross.toFixed(2);
        // We only consider balancing when all header amounts exist and form a coherent total
        const headerPresent =
          typeof netAmount === "number" &&
          typeof vatAmount === "number" &&
          typeof grossAmount === "number";
        const headerConsistent =
          headerPresent &&
          Math.abs(netAmount + vatAmount - grossAmount) <= 0.01;
        // Measure the drift between header totals and summed lines, per bucket
        const netDrift = headerPresent
          ? +(netAmount - sums2.net).toFixed(2)
          : 0;
        const vatDrift = headerPresent
          ? +(vatAmount - sums2.vat).toFixed(2)
          : 0;
        const grossDrift = headerPresent
          ? +(grossAmount - sums2.gross).toFixed(2)
          : 0;
        // Only act when:
        //  - Header is internally consistent
        //  - VAT already matches (within < 0.5p tolerance)
        //  - Net/Gross differ by <= 2p (tiny drift), and by the same magnitude (within < 0.5p)
        if (
          headerConsistent &&
          Math.abs(vatDrift) < 0.005 &&
          Math.abs(netDrift) > 0 &&
          Math.abs(netDrift) <= 0.02 &&
          Math.abs(Math.abs(netDrift) - Math.abs(grossDrift)) < 0.005
        ) {
          // Adjust the last line that has a NetAmount to absorb the small net/gross drift
          let idx = -1;
          for (let k = items.length - 1; k >= 0; k--) {
            if (typeof items[k].NetAmount === "number") {
              idx = k;
              break;
            }
          }
          if (idx >= 0) {
            const li = items[idx];
            // Apply the drift to that line's NetAmount, preserving two-decimal precision
            const newNet = +((li.NetAmount || 0) + netDrift).toFixed(2);
            // Safety: do not create negative Net for the adjusted line
            if (newNet >= 0) {
              li.NetAmount = newNet;
              // Keep VAT unchanged; recompute Gross from Net + VAT if possible.
              // If VAT is missing but Gross exists, nudge Gross directly to keep totals consistent.
              if (typeof li.VATAmount === "number") {
                li.GrossAmount = +(li.NetAmount + li.VATAmount).toFixed(2);
              } else if (typeof li.GrossAmount === "number") {
                li.GrossAmount = +(li.GrossAmount + netDrift).toFixed(2);
              }
              // Debug breadcrumb for traceability. Note: this sentinel is not attached to draft.Debug here.
              var __PENNY_BALANCE__ = {
                LineAdjusted: idx + 1,
                Field: "NetAmount",
                Drift: netDrift,
              };
            }
          }
        }
      } catch (_) {
        /* ignore balancing errors */
      }
    }
  }

  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    // Fallback single line item based on amounts
    lineItems = [
      {
        Description: ocr.title || "Document",
        Quantity: 1,
        UnitPrice: netAmount ?? grossAmount ?? 0,
        NetAmount: netAmount,
        VATAmount: vatAmount,
        GrossAmount: grossAmount,
      },
    ];
  }

  // Sanitize line items: drop fields we don't want to carry forward
  if (Array.isArray(lineItems) && lineItems.length > 0) {
    lineItems = lineItems.map((li) => {
      if (!li || typeof li !== "object") return li;
      // Explicitly remove Disallowed and product-related fields
      const {
        Disallowed,
        Product,
        ProductCode,
        ProductName,
        StockInfo,
        ...rest
      } = li;
      return rest;
    });
  }

  // Final safety: if we have line items, consider aligning header totals to the sum of lines
  if (Array.isArray(lineItems) && lineItems.length > 0) {
    const sums = lineItems.reduce(
      (acc, it) => {
        acc.net += typeof it.NetAmount === "number" ? it.NetAmount : 0;
        acc.vat += typeof it.VATAmount === "number" ? it.VATAmount : 0;
        acc.gross += typeof it.GrossAmount === "number" ? it.GrossAmount : 0;
        return acc;
      },
      { net: 0, vat: 0, gross: 0 },
    );
    sums.net = +sums.net.toFixed(2);
    sums.vat = +sums.vat.toFixed(2);
    sums.gross = +sums.gross.toFixed(2);
    const deltas = {
      net: netAmount != null ? +(netAmount - sums.net).toFixed(2) : null,
      vat: vatAmount != null ? +(vatAmount - sums.vat).toFixed(2) : null,
      gross:
        grossAmount != null ? +(grossAmount - sums.gross).toFixed(2) : null,
    };
    const differs = (v) => v != null && Math.abs(v) > 0.01;
    // If all three header totals are present and internally consistent, prefer header values
    const headerHasAll =
      netAmount != null && vatAmount != null && grossAmount != null;
    const headerConsistent = headerHasAll
      ? Math.abs(netAmount + vatAmount - grossAmount) <= 0.01
      : false;
    if (differs(deltas.net) || differs(deltas.vat) || differs(deltas.gross)) {
      if (headerConsistent) {
        // Keep header numbers; record the difference for UI/debugging
        var __HEADER_PRESERVED_DIFF__ = {
          Header: { Net: netAmount, VAT: vatAmount, Gross: grossAmount },
          FromLines: { Net: sums.net, VAT: sums.vat, Gross: sums.gross },
          Delta: deltas,
        };
      } else {
        // Preserve originals in debug, then align to sums for correctness
        const original = {
          NetAmount: netAmount,
          VATAmount: vatAmount,
          GrossAmount: grossAmount,
        };
        netAmount = sums.net;
        vatAmount = sums.vat;
        grossAmount = sums.gross;
        // Stash debug note
        const adj = {
          FromLines: { Net: sums.net, VAT: sums.vat, Gross: sums.gross },
          Original: original,
          Delta: deltas,
        };
        if (!enumeratedItems) enumeratedItems = []; // ensure Debug object creation below
        // We'll attach to Debug below together with any existing info
        var __HEADER_ALIGNED_FROM_LINES__ = adj; // sentinel to pick up later
      }
    }
  }

  // Notes not required for draft view; omit ReadableString population
  const paperlessToken = `PAPERLESS:${ocr.paperlessId}`;

  const draft = {
    // Identification and matching
    SupplierName: supplierName || undefined,
    SupplierCode: supplierCode || undefined,
    SupplierReference:
      supplierRef != null &&
      !(typeof supplierRef === "string" && supplierRef.trim() === "")
        ? supplierRef
        : undefined,

    // Dates
    IssuedDate: issuedDate || undefined,
    DueDate: dueDate || undefined,

    // Money
    Currency: currency || undefined,
    NetAmount: netAmount,
    VATAmount: vatAmount,
    GrossAmount: grossAmount,

    // Details (omit ReadableString on draft)
    LineItems: lineItems,

    // Optional helpful extras
    Paperless: {
      Id: ocr.paperlessId,
      Title: ocr.title,
      Correspondent: ocr.correspondent || null,
      DocumentType: ocr.documentType || null,
      Tags: ocr.tags || [],
      OriginalFileName: ocr.originalFileName || null,
      ArchivedFileName: ocr.archivedFileName || null,
    },
  };

  // Attach debug info if enumerated custom fields were parsed
  if (
    (Array.isArray(enumeratedItems) && enumeratedItems.length > 0) ||
    typeof __HEADER_ALIGNED_FROM_LINES__ === "object" ||
    typeof __HEADER_PRESERVED_DIFF__ === "object" ||
    (Array.isArray(corrections) && corrections.length > 0)
  ) {
    // Provide helpful totals for the UI to compare
    let sums;
    if (Array.isArray(enumeratedItems) && enumeratedItems.length > 0) {
      sums = enumeratedItems.reduce(
        (acc, it) => {
          acc.Net += typeof it.NetAmount === "number" ? it.NetAmount : 0;
          acc.VAT += typeof it.VATAmount === "number" ? it.VATAmount : 0;
          acc.Gross += typeof it.GrossAmount === "number" ? it.GrossAmount : 0;
          return acc;
        },
        { Net: 0, VAT: 0, Gross: 0 },
      );
      sums.Net = +sums.Net.toFixed(2);
      sums.VAT = +sums.VAT.toFixed(2);
      sums.Gross = +sums.Gross.toFixed(2);
    }
    draft.Debug = {
      ...(draft.Debug || {}),
      ...(Array.isArray(enumeratedItems) && enumeratedItems.length > 0
        ? { EnumeratedLineItems: enumeratedItems, TotalsFromLines: sums }
        : {}),
      ...(__HEADER_ALIGNED_FROM_LINES__
        ? { HeaderAlignedFromLines: __HEADER_ALIGNED_FROM_LINES__ }
        : {}),
      ...(__HEADER_PRESERVED_DIFF__
        ? { HeaderPreserved: __HEADER_PRESERVED_DIFF__ }
        : {}),
      ...(typeof __ROUND_ADJUST__ === "object"
        ? { RoundingAdjustment: __ROUND_ADJUST__ }
        : {}),
      ...(Array.isArray(corrections) && corrections.length > 0
        ? { Corrections: corrections }
        : {}),
    };
  }

  return draft;
}

/** Load by paperlessId and build draft */
async function buildPurchaseDraftById(paperlessId, opts = {}) {
  await mdb.connect();
  const { OcrDocument } = mdb.PAPERLESS;
  if (!OcrDocument) throw new Error("OcrDocument model not loaded");
  const ocr = await OcrDocument.findOne({
    paperlessId: Number(paperlessId),
  }).lean();
  if (!ocr)
    throw new Error(`OcrDocument not found for paperlessId=${paperlessId}`);
  return buildPurchaseDraftFromOcr(ocr, opts);
}

module.exports = {
  buildPurchaseDraftFromOcr,
  buildPurchaseDraftById,
  defaultMap,
};

/**
 * Convert a generic draft into a KashFlow POST payload (per v2 Purchases API).
 * - Shapes Currency as an object (Code, Name optional, ExchangeRate optional)
 * - Converts LineItems to use Rate (unit price) and adds sequential Number
 * - Formats dates as ISO strings acceptable by API (server may accept ISO)
 * - Carries Supplier fields through
 */
function formatKFDate(d) {
  if (!d) return undefined;
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return undefined;
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = dt.getUTCFullYear();
  const mm = pad(dt.getUTCMonth() + 1);
  const dd = pad(dt.getUTCDate());
  const HH = pad(dt.getUTCHours());
  const MM = pad(dt.getUTCMinutes());
  const SS = pad(dt.getUTCSeconds());
  // "YYYY-MM-DD HH:mm:ss" (commonly accepted by KF JSON API)
  return `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS}`;
}

function buildKashFlowPayloadFromDraft(draft, opts = {}) {
  if (!draft || typeof draft !== "object") throw new Error("draft required");
  // Per Purchase_Create request model, send a minimal, request-safe payload
  const currencyCode =
    draft.Currency ||
    opts.currencyDefault ||
    process.env.DEFAULT_CURRENCY ||
    "GBP";
  const defaultNominal =
    typeof draft.DefaultNominalCode === "number"
      ? draft.DefaultNominalCode
      : undefined;

  const vatLevels = Array.isArray(opts.vatLevels)
    ? opts.vatLevels.filter((n) => typeof n === "number" && Number.isFinite(n))
    : [];
  const vatTolerance = (() => {
    const raw = process.env.KASHFLOW_VATLEVEL_TOLERANCE;
    if (raw == null || String(raw).trim() === "") return 0.5;
    const n = parseFloat(String(raw));
    return Number.isFinite(n) ? n : 0.5;
  })();

  const computeVatLevelFromAmounts = (li) => {
    if (!li || typeof li !== "object") return undefined;
    if (typeof li.VATLevel === "number" && Number.isFinite(li.VATLevel))
      return li.VATLevel;
    const vatAmount = li.VATAmount;
    if (typeof vatAmount !== "number" || !Number.isFinite(vatAmount))
      return undefined;

    let netBase = li.NetAmount;
    if (
      (netBase == null || !Number.isFinite(netBase)) &&
      typeof li.GrossAmount === "number" &&
      Number.isFinite(li.GrossAmount)
    ) {
      netBase = +(li.GrossAmount - vatAmount).toFixed(2);
    }
    if (
      (netBase == null || !Number.isFinite(netBase)) &&
      typeof li.Quantity === "number" &&
      Number.isFinite(li.Quantity)
    ) {
      const unit =
        typeof li.UnitPrice === "number" && Number.isFinite(li.UnitPrice)
          ? li.UnitPrice
          : typeof li.Rate === "number" && Number.isFinite(li.Rate)
            ? li.Rate
            : undefined;
      if (typeof unit === "number") netBase = +(li.Quantity * unit).toFixed(2);
    }

    if (
      typeof netBase !== "number" ||
      !Number.isFinite(netBase) ||
      netBase <= 0
    ) {
      // If vat is explicitly 0 and we can't derive net, assume 0%.
      if (vatAmount === 0) return 0;
      return undefined;
    }

    const pct = +((vatAmount / netBase) * 100).toFixed(4);
    if (!Number.isFinite(pct)) return undefined;
    // Round to nearest 5% increment (0, 5, 10, 15, 20, …)
    const roundTo5 = (v) => Math.round(v / 5) * 5;
    if (!vatLevels || vatLevels.length === 0) return roundTo5(pct);

    let best = vatLevels[0];
    let bestDiff = Math.abs(pct - best);
    for (let i = 1; i < vatLevels.length; i++) {
      const r = vatLevels[i];
      const d = Math.abs(pct - r);
      if (d < bestDiff) {
        best = r;
        bestDiff = d;
      }
    }
    // Snap to known KF level when close enough, otherwise still pick closest.
    if (bestDiff <= vatTolerance) return best;
    return best;
  };

  const payload = {
    // Header (request fields only)
    SupplierCode: draft.SupplierCode,
    // Prefer SupplierCode; include SupplierId if available for robustness
    SupplierId:
      typeof draft.SupplierId === "number" ? draft.SupplierId : undefined,
    SupplierReference: draft.SupplierReference,
    IssuedDate: formatKFDate(draft.IssuedDate),
    DueDate: formatKFDate(draft.DueDate),
    ProjectNumber:
      typeof draft.ProjectNumber === "number" ? draft.ProjectNumber : undefined,
    // Optional request fields if present on draft
    IsCISReverseCharge:
      typeof draft.IsCISReverseCharge === "boolean"
        ? draft.IsCISReverseCharge
        : undefined,
    Type: typeof draft.Type === "string" ? draft.Type : undefined,
    Currency: {
      Code: currencyCode,
      // Only ExchangeRate is part of request model; others are response-only
      ExchangeRate:
        typeof opts.exchangeRate === "number" ? opts.exchangeRate : undefined,
    },
    LineItems: Array.isArray(draft.LineItems)
      ? draft.LineItems.map((li) => {
          const resolvedVatLevel = computeVatLevelFromAmounts(li);
          return {
            Description: li.Description,
            Quantity: li.Quantity ?? 1,
            // KashFlow expects Rate (unit price). If only NetAmount was provided, fallback to that.
            Rate: li.UnitPrice ?? li.Rate ?? li.NetAmount ?? 0,
            VATLevel: resolvedVatLevel,
            VATAmount: li.VATAmount,
            VATExempt:
              typeof li.VATExempt === "boolean" ? li.VATExempt : undefined,
            NominalCode:
              typeof li.NominalCode === "number"
                ? li.NominalCode
                : defaultNominal,
            // Optional request fields
            ProjectNumber: li.ProjectNumber,
          };
        })
      : [],
    PaymentLines: Array.isArray(draft.PaymentLines)
      ? draft.PaymentLines.map((pl) => ({
          AccountId: pl.AccountId,
          Amount: pl.Amount,
          Date: formatKFDate(pl.Date),
          Method: pl.Method,
          Note: pl.Note,
          BankTransactionId: pl.BankTransactionId,
          // Support optional request fields if supplied upstream
          BulkId: pl.BulkId,
          BFSTransactionId: pl.BFSTransactionId,
          PaymentProcessor: pl.PaymentProcessor,
        }))
      : undefined,
  };

  // Optionally omit fields so the KashFlow API can apply its own defaults
  // Configure via env:
  // - KASHFLOW_OMIT_HEADER_FIELDS: comma-separated list of root payload keys to remove
  // - KASHFLOW_OMIT_LINE_FIELDS: comma-separated list of LineItems keys to remove
  // - KASHFLOW_DEFER_DEFAULTS=true: drop common defaultable fields when they are zero/falsey
  try {
    const omitHeader = (process.env.KASHFLOW_OMIT_HEADER_FIELDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const omitLine = (process.env.KASHFLOW_OMIT_LINE_FIELDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const deferDefaults = process.env.KASHFLOW_DEFER_DEFAULTS === "true";

    // Header omissions
    for (const k of omitHeader) {
      if (k in payload) delete payload[k];
    }
    if (deferDefaults) {
      // Let API decide header defaults where safe
      if (payload.ProjectNumber === 0) delete payload.ProjectNumber;
      if (payload.IsCISReverseCharge === false)
        delete payload.IsCISReverseCharge;
    }

    // Line omissions and default deferrals
    if (Array.isArray(payload.LineItems)) {
      payload.LineItems = payload.LineItems.map((li) => {
        if (!li || typeof li !== "object") return li;
        // explicit omissions
        for (const k of omitLine) {
          if (k in li) delete li[k];
        }
        if (deferDefaults) {
          // Common defaultable fields: let API decide
          if (li.VATExempt === false) delete li.VATExempt;
          // Keep VATLevel even when it is 0 (zero-rated). Deleting it can cause KashFlow to default to a non-zero VAT rate.
          if (li.ProjectNumber === 0) delete li.ProjectNumber;
          if (li.GrossAmount === 0) delete li.GrossAmount;
          if (li.ProductCode === 0) delete li.ProductCode;
          if (li.ProductName === "") delete li.ProductName;
        }
        return li;
      });
    }
  } catch (_) {
    /* ignore filtering issues */
  }

  // Remove undefined keys recursively to keep payload tidy
  const prune = (obj) => {
    if (!obj || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(prune);
    Object.keys(obj).forEach((k) => {
      if (obj[k] === undefined) delete obj[k];
      else obj[k] = prune(obj[k]);
    });
    return obj;
  };

  return prune(payload);
}

module.exports.buildKashFlowPayloadFromDraft = buildKashFlowPayloadFromDraft;
