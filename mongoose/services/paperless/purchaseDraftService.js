// mongoose/services/paperless/purchaseDraftService.js
// Build a KashFlow-style purchase draft JSON from a PAPERLESS OcrDocument.
// This is consumed by an external creator; we only produce the draft here.

const mdb = require('../mongooseDatabaseService');

// Default name-based mapping from custom field names to target purchase fields
const defaultMap = {
  SupplierName: ['Supplier', 'Supplier Name', 'Vendor', 'Vendor Name'],
  SupplierCode: ['Supplier Code', 'Vendor Code'],
  // Prefer explicit invoice number over generic reference labels
  SupplierReference: ['Invoice Number', 'Invoice No', 'Invoice #', 'Inv No', 'Inv #', 'Supplier Reference', 'Reference', 'Ref', 'Doc No', 'Document Number'],
  IssuedDate: ['Invoice Date', 'Date', 'Document Date'],
  DueDate: ['Due Date', 'Payment Due'],
  NetAmount: ['Net', 'Net Amount', 'Subtotal', 'Total Goods'],
  VATAmount: ['VAT', 'VAT Amount', 'Tax', 'Tax Amount', 'Total VAT'],
  GrossAmount: ['Gross', 'Total', 'Total Amount', 'Amount', 'Invoice Total'],
  Currency: ['Currency', 'Curr', 'ISO Currency'],
  Notes: ['Notes', 'Memo', 'Description', 'Summary'],
  LineItems: ['LineItems', 'Line Items', 'Items'], // optional JSON string or array
};

function normalizeName(s) { return String(s || '').trim().toLowerCase(); }
function normalizeKey(s) { return normalizeName(s).replace(/[^a-z0-9]+/g, ''); }

function findCustomField(customFields, names) {
  if (!Array.isArray(customFields) || customFields.length === 0) return undefined;
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
  // Pass 3: contains match (fallback)
  for (const cf of customFields) {
    const k = normalizeKey(cf.fieldName);
    for (const w of wantedKeys) {
      if (w && k.includes(w)) return cf.value;
    }
  }
  return undefined;
}

function parseMoney(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const cleaned = v.replace(/[^0-9.,-]/g, '').replace(/,(?=\d{3}\b)/g, '');
  // Prefer dot as decimal; if only comma present, swap it
  const normalized = cleaned.indexOf('.') >= 0 ? cleaned : cleaned.replace(',', '.');
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : undefined;
}

function parseDate(v) {
  if (!v) return undefined;
  if (v instanceof Date && !isNaN(v)) return v;
  if (typeof v === 'string') {
    // Support common formats: YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY
    const s = v.trim();
    const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m) {
      const [ , dd, mm, yyyy ] = m;
      const d = new Date(Date.UTC(parseInt(yyyy,10), parseInt(mm,10)-1, parseInt(dd,10)));
      return isNaN(d) ? undefined : d;
    }
    const d2 = new Date(s);
    return isNaN(d2) ? undefined : d2;
  }
  return undefined;
}

function coalesce(...vals) { return vals.find(v => v !== undefined && v !== null && v !== ''); }

/**
 * Build a purchase draft object from an OcrDocument record.
 * @param {object} ocr - OcrDocument document (lean or hydrated)
 * @param {object} opts - { mapping, currencyDefault }
 * @returns {object} draft
 */
function buildPurchaseDraftFromOcr(ocr, opts = {}) {
  if (!ocr || typeof ocr !== 'object') throw new Error('ocr document required');
  const mapping = { ...defaultMap, ...(opts.mapping || {}) };
  const cf = Array.isArray(ocr.customFields) ? ocr.customFields : [];

  const supplierName = coalesce(
    findCustomField(cf, mapping.SupplierName),
    ocr.correspondent && ocr.correspondent.name
  );
  const supplierCode = findCustomField(cf, mapping.SupplierCode);
  // Supplier reference: prefer explicit invoice number; robust fallback if blank
  let supplierRef = findCustomField(cf, mapping.SupplierReference);
  if (supplierRef == null || (typeof supplierRef === 'string' && supplierRef.trim() === '')) {
    // Fallback: strict match on "invoice number" ignoring non-alphanumeric
    const normKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const invCf = cf.find(x => normKey(x.fieldName) === 'invoicenumber');
    if (invCf && invCf.value != null && !(typeof invCf.value === 'string' && invCf.value.trim() === '')) {
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
  const currency = coalesce(findCustomField(cf, mapping.Currency), opts.currencyDefault || process.env.DEFAULT_CURRENCY || 'GBP');

  let netAmount = net, vatAmount = vat, grossAmount = gross;
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

  // Line items: try to read as JSON; else single-line fallback
  let lineItemsRaw = findCustomField(cf, mapping.LineItems);
  let lineItems = undefined;
  if (lineItemsRaw != null) {
    if (Array.isArray(lineItemsRaw)) {
      lineItems = lineItemsRaw;
    } else if (typeof lineItemsRaw === 'string') {
      try { lineItems = JSON.parse(lineItemsRaw); } catch (_) { /* ignore */ }
    }
  }
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    // Fallback single line item based on amounts
    lineItems = [{
      Description: ocr.title || 'Document',
      Quantity: 1,
      UnitPrice: netAmount ?? grossAmount ?? 0,
      NetAmount: netAmount,
      VATAmount: vatAmount,
      GrossAmount: grossAmount,
    }];
  }

  const notes = findCustomField(cf, mapping.Notes) || ocr.title;
  const paperlessToken = `PAPERLESS:${ocr.paperlessId}`;

  const draft = {
    // Identification and matching
    SupplierName: supplierName || undefined,
    SupplierCode: supplierCode || undefined,
    SupplierReference: (supplierRef != null && !(typeof supplierRef === 'string' && supplierRef.trim() === '')) ? supplierRef : undefined,
    AdditionalFieldValue: paperlessToken, // critical for linking back

    // Dates
    IssuedDate: issuedDate || undefined,
    DueDate: dueDate || undefined,

    // Money
    Currency: currency || undefined,
    NetAmount: netAmount,
    VATAmount: vatAmount,
    GrossAmount: grossAmount,

    // Details
    ReadableString: notes || undefined,
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
    }
  };

  return draft;
}

/** Load by paperlessId and build draft */
async function buildPurchaseDraftById(paperlessId, opts = {}) {
  await mdb.connect();
  const { OcrDocument } = mdb.PAPERLESS;
  if (!OcrDocument) throw new Error('OcrDocument model not loaded');
  const ocr = await OcrDocument.findOne({ paperlessId: Number(paperlessId) }).lean();
  if (!ocr) throw new Error(`OcrDocument not found for paperlessId=${paperlessId}`);
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
 * - Carries Supplier fields and AdditionalFieldValue through
 */
function formatKFDate(d) {
  if (!d) return undefined;
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt)) return undefined;
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = dt.getFullYear();
  const mm = pad(dt.getMonth() + 1);
  const dd = pad(dt.getDate());
  const HH = pad(dt.getHours());
  const MM = pad(dt.getMinutes());
  const SS = pad(dt.getSeconds());
  // "YYYY-MM-DD HH:mm:ss" (commonly accepted by KF JSON API)
  return `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS}`;
}

function buildKashFlowPayloadFromDraft(draft, opts = {}) {
  if (!draft || typeof draft !== 'object') throw new Error('draft required');
  const currencyCode = draft.Currency || opts.currencyDefault || process.env.DEFAULT_CURRENCY || 'GBP';
  const defaultNominal = typeof draft.DefaultNominalCode === 'number' ? draft.DefaultNominalCode : undefined;

  const payload = {
    // Header
    Number: typeof draft.Number === 'number' ? draft.Number : undefined,
    SupplierName: draft.SupplierName,
    SupplierCode: draft.SupplierCode,
    SupplierReference: draft.SupplierReference,
    SupplierId: typeof draft.SupplierId === 'number' ? draft.SupplierId : undefined,
    AdditionalFieldValue: draft.AdditionalFieldValue,
    IssuedDate: formatKFDate(draft.IssuedDate),
    DueDate: formatKFDate(draft.DueDate),
    PaidDate: formatKFDate(draft.PaidDate),
    NetAmount: draft.NetAmount,
    VATAmount: draft.VATAmount,
    GrossAmount: draft.GrossAmount,
    HomeCurrencyGrossAmount: draft.HomeCurrencyGrossAmount,
    TotalPaidAmount: draft.TotalPaidAmount,
    Status: draft.Status,
    ProjectNumber: typeof draft.ProjectNumber === 'number' ? draft.ProjectNumber : undefined,
    PurchaseInECMemberState: typeof draft.PurchaseInECMemberState === 'boolean' ? draft.PurchaseInECMemberState : undefined,
    IsWhtDeductionToBeApplied: typeof draft.IsWhtDeductionToBeApplied === 'boolean' ? draft.IsWhtDeductionToBeApplied : undefined,
    Currency: {
      Code: currencyCode,
      Name: opts.currencyName || undefined,
      ExchangeRate: typeof opts.exchangeRate === 'number' ? opts.exchangeRate : undefined,
      Symbol: opts.currencySymbol || undefined,
      DisplaySymbolOnRight: typeof opts.displaySymbolOnRight === 'boolean' ? opts.displaySymbolOnRight : undefined,
    },
    LineItems: Array.isArray(draft.LineItems) ? draft.LineItems.map((li, idx) => ({
      Number: idx + 1,
      Description: li.Description,
      Quantity: li.Quantity ?? 1,
      Rate: li.UnitPrice ?? li.Rate ?? li.NetAmount ?? 0,
      VATAmount: li.VATAmount,
      TaxCode: li.TaxCode,
      NominalCode: (typeof li.NominalCode === 'number' ? li.NominalCode : defaultNominal),
      ProductCode: li.ProductCode,
      ProductName: li.ProductName,
      ProjectNumber: li.ProjectNumber,
      ProjectName: li.ProjectName,
      VATExempt: typeof li.VATExempt === 'boolean' ? li.VATExempt : undefined,
      // VATLevel is read-only per docs; omit on POST
      HomeCurrencyRate: li.HomeCurrencyRate,
      HomeCurrencyVATAmount: li.HomeCurrencyVATAmount,
      NominalName: li.NominalName,
    })) : [],
    PaymentLines: Array.isArray(draft.PaymentLines) ? draft.PaymentLines.map(pl => ({
      AccountId: pl.AccountId,
      Amount: pl.Amount,
      Date: formatKFDate(pl.Date),
      Method: pl.Method,
      Note: pl.Note,
      BankTransactionId: pl.BankTransactionId,
      // Id/Permalink/BulkId/BulkPaymentNumber are server-managed; omit on POST
    })) : undefined,
    ReadableString: draft.ReadableString,
  };

  // Remove undefined keys recursively to keep payload tidy
  const prune = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(prune);
    Object.keys(obj).forEach(k => {
      if (obj[k] === undefined) delete obj[k];
      else obj[k] = prune(obj[k]);
    });
    return obj;
  };

  return prune(payload);
}

module.exports.buildKashFlowPayloadFromDraft = buildKashFlowPayloadFromDraft;
