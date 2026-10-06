/**
 * Pure helpers for the entry screen's suggestions (document-suggestions.js),
 * kept apart so the tests can import them without a DOM.
 */
import { parseMoney, parseDate, parseReference, FIELDS } from './invoice-field-finder.js';
import { parseNumber } from './invoice-line-finder.js';

const TYPE = Object.fromEntries(FIELDS.map((f) => [f.field, f.type]));
const money = (v) => `£${Number(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v) => (v === '' || v == null ? null : Number(String(v).replace(/[£,\s]/g, '')));
/** The VAT rates a line can have, in percent (UK: zero, reduced, standard). */
export const VAT_RATES = [0, 5, 20];

/**
 * A line's VAT % as typed: the rate, null when blank, or NaN when it isn't
 * one of VAT_RATES. "20" and "20%" are both 20. Amounts are refused: VAT % is
 * a percentage, and £4.67 of VAT typed into it would otherwise be 4.67%.
 */
export function parseVatRate(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = /^(\d+(?:\.0+)?)\s*%?$/.exec(s);
  const n = m ? Number(m[1]) : NaN;
  return VAT_RATES.includes(n) ? n : NaN;
}

/** Why a line's VAT % won't do, or null when it's blank or a rate. */
export function vatRateProblem(v, lineNo) {
  if (!Number.isNaN(parseVatRate(v))) return null;
  return `Line ${lineNo} VAT % is "${String(v).trim()}". VAT % is a percentage (${VAT_RATES.join(', ')}), not an amount.`;
}

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
  lines.forEach((l, i) => {
    const problem = isBlank(l) ? null : vatRateProblem(l.vatRate, i + 1);
    if (problem) out.push(problem);
  });
  const ls = lines.filter((l) => !isBlank(l)).map((l) => {
    const q = num(l.quantity);
    const p = num(l.price);
    const t = num(l.total) ?? (q != null && p != null ? Math.round(q * p * 100) / 100 : null);
    const rate = parseVatRate(l.vatRate);
    return { t, rate: Number.isNaN(rate) ? null : rate };
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
 * True when the lines in the form are the document's lines: same quantity,
 * price, total and VAT %. Totals alone aren't enough: bricks entered at
 * 794.51 (per thousand) instead of 0.7945 still total 0.79.
 * @param {Array} typed  non-blank form lines, as typed
 * @param {Array} found  lines read from the document
 */
export function sameLines(typed, found) {
  const close = (a, b, tol) => (b == null ? true : a != null && Math.abs(a - b) < tol);
  return typed.length === found.length && typed.every((l, i) => {
    const d = found[i];
    return close(num(l.total), d.total, 0.005)
      && close(num(l.quantity), d.quantity, 1e-6)
      && close(num(l.price), d.price, 0.00005)
      && close(num(l.vatRate), d.vatRate, 1e-6);
  });
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
    } else if (type === 'vatRate') {
      // Only a rate: clicking the VAT amount column must not fill "4.67"
      const n = parseVatRate(t);
      if (n != null && !Number.isNaN(n)) return String(n);
    } else if (type === 'quantity') {
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

export default { liveChecks, pickValue, parseVatRate, vatRateProblem, sameLines, VAT_RATES };
