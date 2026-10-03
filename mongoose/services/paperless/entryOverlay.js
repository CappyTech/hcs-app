/**
 * entryOverlay.js — puts what was keyed in on the hcs-app entry screen (H5)
 * in front of the Paperless custom fields, for the KashFlow draft builder.
 *
 * No imports on purpose: purchaseDraftService uses it, and the entry service
 * pulls in the Paperless client and the ingest code.
 */

const isoDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

/**
 * The entry as Paperless-named custom fields. Empty values are left out so
 * the Paperless value shows through. When the entry has lines, they replace
 * Paperless's lines entirely, so a line deleted in hcs-app can't reappear.
 * @returns {{fields: Array<{fieldName, value, source}>, replacesLines: boolean}}
 */
export function entryAsCustomFields(entry) {
  if (!entry || !entry.savedAt) return { fields: [], replacesLines: false };
  const out = [];
  const put = (fieldName, value) => { if (value != null && value !== '') out.push({ fieldName, value, source: 'hcs-app' }); };
  put('Invoice Number', entry.invoiceNumber);
  put('Invoice Date', isoDate(entry.invoiceDate));
  put('Invoice Due Date', isoDate(entry.dueDate));
  put('Total Goods', entry.totalGoods);
  put('Total VAT', entry.totalVat);
  put('Invoice Total', entry.invoiceTotal);
  const lines = entry.lines || [];
  lines.forEach((l, i) => {
    const n = i + 1;
    put(`Description_Line${n}`, l.description);
    put(`Qty_Line${n}`, l.quantity);
    put(`Price_Line${n}`, l.price);
    put(`Total_Line${n}`, l.total);
    put(`VAT_Line${n}`, l.vatRate);
  });
  return { fields: out, replacesLines: lines.length > 0 };
}

const LINE_FIELD = /(.+?)[_\s-]*line\s*\d+\s*$|^line\s*\d+/i;

/**
 * Custom fields for the draft: the entry's first, then Paperless's. Paperless
 * line fields are dropped when the entry has its own lines.
 */
export function customFieldsWithEntry(ocr) {
  const paperless = Array.isArray(ocr?.customFields) ? ocr.customFields : [];
  const { fields, replacesLines } = entryAsCustomFields(ocr?.entry);
  if (fields.length === 0) return paperless;
  const kept = replacesLines ? paperless.filter((cf) => !LINE_FIELD.test(String(cf.fieldName || ''))) : paperless;
  return [...fields, ...kept];
}

export default { entryAsCustomFields, customFieldsWithEntry };
