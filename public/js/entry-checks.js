/**
 * Pure helpers for the entry screen's suggestions (document-suggestions.js),
 * kept apart so the tests can import them without a DOM.
 */
import { parseMoney, parseDate, parseReference, FIELDS } from './invoice-field-finder.js';
import { parseNumber } from './invoice-line-finder.js';

const TYPE = Object.fromEntries(FIELDS.map((f) => [f.field, f.type]));
const money = (v) => `£${Number(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v) => (v === '' || v == null ? null : Number(String(v).replace(/[£,\s]/g, '')));
const isBlank = (l) => ['description', 'quantity', 'price', 'total', 'vatRate'].every((f) => !l[f] && l[f] !== 0);

/**
 * Lines, VAT and totals that don't add up, from what's in the form right now.
 * @param {object} header  { totalGoods, totalVat, invoiceTotal } as typed
 * @param {Array} lines    [{ description, quantity, price, total, vatRate }] as typed
 */
export function liveChecks(header, lines) {
  const out = [];
  const goods = num(header.totalGoods);
  const vat = num(header.totalVat);
  const total = num(header.invoiceTotal);
  const ls = lines.filter((l) => !isBlank(l)).map((l) => {
    const q = num(l.quantity);
    const p = num(l.price);
    const t = num(l.total) ?? (q != null && p != null ? Math.round(q * p * 100) / 100 : null);
    return { t, rate: num(l.vatRate) };
  });
  const off = (a, b, tol = 0.01) => Math.abs(a - b) > tol + 1e-9;
  const withTotals = ls.filter((l) => l.t != null && Number.isFinite(l.t));
  if (goods != null && withTotals.length) {
    const sum = withTotals.reduce((s, l) => s + l.t, 0);
    if (off(sum, goods)) out.push(`Lines add up to ${money(sum)}, but total goods is ${money(goods)}.`);
  }
  if (vat != null && withTotals.length && withTotals.every((l) => l.rate != null)) {
    const lineVat = withTotals.reduce((s, l) => s + (l.t * l.rate) / 100, 0);
    // Suppliers round VAT per line or on the total, so allow a penny a line
    if (off(lineVat, vat, Math.max(0.02, 0.01 * withTotals.length))) {
      out.push(`VAT at the line rates comes to ${money(lineVat)}, but total VAT is ${money(vat)}.`);
    }
  }
  if (goods != null && vat != null && total != null && off(goods + vat, total)) {
    out.push(`Goods ${money(goods)} + VAT ${money(vat)} is ${money(goods + vat)}, not the invoice total ${money(total)}.`);
  }
  return out;
}

/**
 * The value for a field from text clicked on the PDF: the whole text, or else
 * the word under the pointer. Null when neither fits the field.
 * @param {string} field  a header field ("invoiceTotal") or "line.<name>"
 */
export function pickValue(field, text, word) {
  const tries = [text, word].filter(Boolean).map((t) => t.trim());
  const type = field.startsWith('line.') ? field.slice(5) : TYPE[field];
  for (const t of tries) {
    if (type === 'money' || type === 'total' || type === 'price') {
      const n = parseMoney(t) ?? (parseNumber(t) != null ? parseNumber(t).toFixed(2) : null);
      if (n != null) return type === 'price' ? String(Number(n)) : n;
    } else if (type === 'date') {
      const d = parseDate(t);
      if (d) return d;
    } else if (type === 'quantity' || type === 'vatRate') {
      const n = parseNumber(t);
      if (n != null) return String(n);
    } else if (type === 'reference') {
      const r = parseReference(t);
      if (r) return r;
    } else if (type === 'description') {
      return t.replace(/\.{3,}/g, ' ').replace(/\s+/g, ' ');
    }
  }
  return null;
}

export default { liveChecks, pickValue };
