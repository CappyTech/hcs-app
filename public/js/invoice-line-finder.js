/**
 * Line items, payment terms and VAT numbers, read off an invoice's text layer.
 *
 * Works on the same items as invoice-field-finder.js (PDF units, origin
 * bottom-left) and, like it, has no DOM: the entry screen and the server both
 * import it.
 *
 * Lines: find the table's heading row (it may be split over two or three
 * text rows, one word per item), name each column (description, qty, price,
 * amount, VAT…), then give every cell below to the column it sits in, until
 * the totals or a big gap. Rows with no figures either carry on the line above
 * ("14ltr / 3 gallon") or, when the figures sit on the row below them
 * (Stark: description, then "6.00 EA  3.74  22.44"), start the next line.
 */
import { groupRows, charBox, unionBox, parseMoney, parseDate, startsLabel } from './invoice-field-finder.js';

// Column names, most specific first. Each must match the whole phrase, so
// "Quantity Description" (two headings that sit close) is not a name at all.
const COLUMN_TYPES = [
  ['vatRate', /^(vat|tax)\s*(%|rate|code)$|^(vat|tax)\s*rate\s*%?$|^%$|^v$|^rate\s*%$/i],
  ['vatAmount', /^(vat|tax)(\s*(amount|amt|value|applied|£))?$/i],
  ['discount', /^disc(ount)?\.?(\s*(amt|amount|%|value))?$/i],
  ['price', /^(unit\s*)?(price|rate|cost)(\s*\/\s*rate)?(\s*(£|gbp))?$|^each$|^price\s*each$/i],
  ['qty', /^(qty|quantity|qty\s*\/\s*hrs|hrs|hours|no\.?\s*of\s*units)$/i],
  ['net', /^(net(\s*(amt|amount|value|total))?|goods(\s*value)?|amount(\s*(gbp|£))?|amt|line\s*total|total(\s*net)?|value|charge|sub\s*-?\s*total)$/i],
  ['gross', /^gross(\s*(amt|amount|value))?$/i],
  ['uom', /^(unit|uom|per)$/i],
  ['code', /^((part|item|stock|product)\s*(no\.?|code|number|#)|code|ref(erence)?|sku|line)$/i],
  ['date', /^(date|date\s*(from|to)|from|to|period)$/i],
  ['desc', /^(description|details|particulars|product|parts|items?|service|narrative|labou?r|materials|hire|charges)$/i],
];
const columnType = (text) => (COLUMN_TYPES.find(([, re]) => re.test(text.trim())) || [null])[0];

const VAT_CODES = { S: 20, Z: 0, E: 0, X: 0, R: 5, L: 5 };
const STANDARD_RATES = [0, 5, 20];

/** "6.00 EA" → 6, "£1,234.50" → 1234.5, "20%" → 20; null if not a number. */
export function parseNumber(text) {
  const s = String(text || '').trim().replace(/^£\s?/, '').replace(/,/g, '');
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*(%|[a-z]{1,4}\.?)?$/i);
  return m ? Number(m[1]) : null;
}

const cleanText = (s) => s.replace(/\.{3,}/g, ' ').replace(/\s+/g, ' ').trim();

/** Words of a row, merged into phrases where they sit close together. */
function phrases(row) {
  const out = [];
  for (const it of row.items) {
    const last = out.at(-1);
    // Close words join ("Unit" "Price"), unless each is a heading of its own and
    // together they aren't one ("Quantity" "Description" set 7pt apart)
    const close = last && it.x - (last.x + last.w) < Math.min(last.h, it.h) * 0.8;
    const twoHeadings = close && columnType(last.str) && columnType(it.str) && !columnType(`${last.str} ${it.str}`);
    if (close && !twoHeadings) {
      last.str += ` ${it.str}`;
      last.w = it.x + it.w - last.x;
    } else {
      out.push({ str: it.str, x: it.x, y: it.y, w: it.w, h: it.h, page: it.page });
    }
  }
  return out;
}

/**
 * A heading: one to three rows close together, words in one column joined
 * top to bottom ("Unit" over "Price"). Returns its columns, left to right.
 */
function headingAt(rows, ri) {
  let best = null;
  for (let span = 1; span <= 3 && ri + span <= rows.length; span++) {
    const group = rows.slice(ri, ri + span);
    if (group.some((r) => r.page !== rows[ri].page)) break;
    if (span > 1 && group.at(-2).y - group.at(-1).y > rows[ri].h * 1.6) break;
    const cols = [];
    for (const r of group) {
      for (const p of phrases(r)) {
        const over = cols.find((c) => p.x < c.x + c.w + 2 && p.x + p.w > c.x - 2);
        if (over) {
          over.str += ` ${p.str}`;
          const x2 = Math.max(over.x + over.w, p.x + p.w);
          over.x = Math.min(over.x, p.x);
          over.w = x2 - over.x;
        } else cols.push({ ...p });
      }
    }
    cols.sort((a, b) => a.x - b.x);
    for (const c of cols) c.type = columnType(c.str);
    // "Product" then "Description": the first holds codes
    const descs = cols.filter((c) => c.type === 'desc');
    descs.slice(0, -1).forEach((c) => { c.type = 'code'; });
    const types = new Set(cols.map((c) => c.type).filter(Boolean));
    const hasAmount = types.has('net') || types.has('gross');
    // A hire invoice may have only "Description" and "Value", and a labour
    // table only "Labour" and "Amount", so price and qty are optional
    const ok = hasAmount && (types.has('desc') || (types.has('code') && cols.length >= 3));
    if (ok && (!best || types.size > best.types.size)) best = { cols, types, rows: span, y: group.at(-1).y, h: rows[ri].h };
  }
  return best;
}

/** Which column a cell belongs to: numbers by their centre, words by their left edge. */
function columnFor(cols, it) {
  const isNum = parseNumber(it.str) != null || /^[A-Z]$/.test(it.str.trim());
  const at = isNum ? it.x + it.w / 2 : it.x + 1;
  let idx = 0;
  for (let i = 0; i < cols.length; i++) if (at >= cols[i].x - 3) idx = i;
  return cols[idx];
}

/** The line's VAT rate, from a rate/code cell or from VAT amount ÷ net. */
function vatRateOf(cells, net) {
  const amount = cells.vatAmount != null ? parseMoney(cells.vatAmount) ?? parseNumber(cells.vatAmount) : null;
  if (amount != null && net) {
    const r = (Number(amount) / net) * 100;
    const snap = STANDARD_RATES.find((s) => Math.abs(s - r) < 1);
    return snap ?? Math.round(r);
  }
  // A rate column, or a "VAT" column holding codes (Stark prints "S")
  const raw = (cells.vatRate || cells.vatAmount || '').trim();
  if (!raw) return null;
  if (VAT_CODES[raw.toUpperCase()] != null) return VAT_CODES[raw.toUpperCase()];
  const n = parseNumber(raw);
  return n != null && n >= 0 && n <= 100 ? n : null;
}

/**
 * The invoice's line items.
 * @returns {Array<{description, code, quantity, price, total, vatRate, page, box}>}
 */
export function findLines(items) {
  const rows = groupRows(items);
  const lines = [];
  // Every table on the page: parts, then labour, and so on
  for (let ri = 0; ri < rows.length; ri++) {
    const head = headingAt(rows, ri);
    if (!head) continue;
    const table = readTable(rows, ri + head.rows, head);
    lines.push(...table.lines);
    ri = Math.max(ri, table.end - 1);
  }
  return lines;
}

// The column holding each line's net amount: "Net" beats "Amount", which beats
// "Sub Total" (Screwfix's is gross) and "Gross"
const amountRank = (c) => (c.type === 'gross' ? 4 : /\bnet\b|goods/i.test(c.str) ? 0 : /amount|value|charge|line\s*total/i.test(c.str) ? 1 : /total/i.test(c.str) ? 2 : 3);

function readTable(rows, start, head) {
  const { cols } = head;
  const amountCol = cols.filter((c) => c.type === 'net' || c.type === 'gross').sort((a, b) => amountRank(a) - amountRank(b))[0];
  const parsed = [];
  let lastY = head.y;
  let r = start;
  for (; r < rows.length; r++) {
    const row = rows[r];
    if (row.page !== rows[start - 1].page) break;
    if (lastY - row.y > Math.max(head.h, row.h) * 4.5) break;
    if (startsLabel(row.items[0].str) || /^\s*(sub[\s-]?total|totals?|carriage|vat\s*summary|total\s*(goods|net))\b/i.test(row.items[0].str)) break;
    lastY = row.y;
    const cells = {};
    const text = [];
    const code = [];
    for (const it of row.items) {
      const col = columnFor(cols, it);
      if (col.type === 'desc') text.push(it.str);
      else if (col.type === 'code') code.push(it.str);
      else if (col.type && col.type !== 'date') cells[col === amountCol ? 'amount' : col.type] = ((cells[col === amountCol ? 'amount' : col.type] || '') + ' ' + it.str).trim();
    }
    const amount = cells.amount != null ? parseMoney(cells.amount) ?? (parseNumber(cells.amount) != null ? parseNumber(cells.amount).toFixed(2) : null) : null;
    parsed.push({ row, cells, text: cleanText(text.join(' ')), code: cleanText(code.join(' ')), amount });
  }

  const lines = [];
  let pending = null; // description rows waiting for their figures (Stark)
  parsed.forEach((p, i) => {
    if (p.amount != null) {
      const net = Number(p.amount);
      const quantity = p.cells.qty != null ? parseNumber(p.cells.qty) : null;
      const quoted = p.cells.price != null ? parseNumber(p.cells.price) : null;
      // TODO(discounts): p.cells.discount is read but not used, so a discounted
      // line ("2 × 10.00, 10%, 18.00") keeps the printed price and the entry
      // screen warns "2 × 10.00 is 20.00, not 18.00". The total is still right,
      // and the send refuses lines that don't add up. Build this against the
      // first real discounted invoice, not before:
      //   1. save it as a fixture (/paperless/reading → tests/fixtures/invoices/)
      //   2. percent → price × (1 − d/100); amount → price − d ÷ quantity
      //   3. agree how it shows: net price per unit, or the discount kept apart
      //      (entry form, KashFlow payload)
      //   4. make consistencyWarnings (documentEntryService) and liveChecks accept it
      const per = pricedPer(quantity, quoted, net, p.cells.uom);
      const price = per > 1 ? Math.round((quoted / per) * 10000) / 10000 : quoted;
      const before = pending;
      pending = null;
      const description = p.text || before?.text || p.code || before?.code || '';
      lines.push({
        description,
        code: p.code || before?.code || null,
        quantity,
        price,
        ...(per > 1 ? { pricePer: per, quotedPrice: quoted } : {}),
        total: net,
        vatRate: vatRateOf(p.cells, net),
        page: p.row.page,
        box: unionBox([...(before ? before.rows.flatMap((r) => r.items) : []), ...p.row.items].map((it) => charBox(it))),
      });
      return;
    }
    const words = [p.code, p.text].filter(Boolean).join(' ');
    if (!words) return;
    const next = parsed[i + 1];
    const nextIsBareFigures = next && next.amount != null && !next.text;
    if (nextIsBareFigures || !lines.length) {
      pending = pending
        ? { text: cleanText(`${pending.text} ${p.text}`), code: pending.code || p.code, rows: [...pending.rows, p.row] }
        : { text: p.text, code: p.code, rows: [p.row] };
    } else {
      const line = lines.at(-1);
      line.description = cleanText(`${line.description} ${p.text || p.code}`);
      line.box = unionBox([line.box, ...p.row.items.map((it) => charBox(it))]);
    }
  });
  return { lines: lines.filter((l) => l.description || l.quantity != null), end: r };
}

// Units that mean the price is per hundred or per thousand ("TH": bricks, blocks)
const PER_UNIT = [[1000, /^(th|thou|m|mil|1000|per\s*1000|\/1000)$/i], [100, /^(c|h|hun|100|per\s*100|\/100)$/i]];

/**
 * 1, 100 or 1000: what the printed price is per. Bricks are priced per
 * thousand (Jewson: 1.00 EA at 794.51 TH = 0.79), so quantity × price is the
 * total only after dividing. Taken from the unit column when it says so, else
 * only when the figures leave no doubt (quantity × price ÷ 100 or 1000 is the
 * total, and quantity × price isn't).
 */
function pricedPer(quantity, price, total, unit) {
  if (!(quantity > 0) || !(price > 0) || !Number.isFinite(total)) return 1;
  const near = (a, b) => Math.abs(a - b) <= Math.max(0.011, Math.abs(b) * 0.005);
  if (near(quantity * price, total)) return 1;
  const hinted = PER_UNIT.find(([, re]) => re.test(String(unit || '').trim()))?.[0];
  for (const per of hinted ? [hinted] : [1000, 100]) {
    if (near((quantity * price) / per, total)) return per;
  }
  return 1;
}

/**
 * Lines with no VAT rate printed (hire and garage invoices have no VAT column)
 * take the invoice's own rate, when VAT ÷ goods comes out at a standard rate.
 * Returns new line objects; `vatRateFrom: 'totals'` marks the ones filled in.
 */
export function fillMissingRates(lines, totalGoods, totalVat) {
  const g = Number(totalGoods);
  const v = Number(totalVat);
  if (!lines.some((l) => l.vatRate == null) || !(g > 0) || !Number.isFinite(v)) return lines;
  const rate = STANDARD_RATES.find((s) => Math.abs((v / g) * 100 - s) < 0.5);
  if (rate == null) return lines;
  return lines.map((l) => (l.vatRate == null ? { ...l, vatRate: rate, vatRateFrom: 'totals' } : l));
}

// ── Payment terms → due date ─────────────────────────────────────────

const TERMS = [
  // "30 days end of month", "30 days EOM"
  { re: /\b(\d{1,3})\s*days?\s*(from\s*)?(the\s*)?(end\s*of\s*(the\s*)?month|eom)\b/i, eom: true },
  // "end of month following", "EOM following"
  { re: /\b(end\s*of\s*(the\s*)?month|eom)\s*following\b/i, days: 0, eomFollowing: true },
  // "30 days net", "strictly 30 days", "payment within 30 days", "net 30". A bare
  // "within 28 days" is usually returns or queries ("call within 28 days to arrange
  // collection"), so "within" only counts after payment wording.
  { re: /\b(?:net\s*(\d{1,3})(?:\s*days?)?|(\d{1,3})\s*days?\s*(?:net|nett|from\s*(?:date\s*of\s*)?invoice|of\s*invoice)|(?:strictly|(?:payment|payable|pay|due|settle(?:ment)?)\s*(?:is\s*)?(?:due\s*)?within|(?:payment\s*)?terms:?)\s*(\d{1,3})\s*days?)\b/i },
];

const ymd = (d) => d.toISOString().slice(0, 10);

/**
 * Payment terms printed on the invoice, and the due date they give from the
 * invoice date ('YYYY-MM-DD'). Null if no terms are found.
 */
export function findPaymentTerms(items, invoiceDate) {
  for (const it of items) {
    for (const t of TERMS) {
      const m = it.str.match(t.re);
      if (!m) continue;
      const days = t.days ?? Number(m.slice(1).find((g) => g && /^\d+$/.test(g)));
      if (!Number.isFinite(days) || days > 180) continue;
      const at = it.str.indexOf(m[0]);
      const found = { text: m[0].trim(), days, eom: !!t.eom, eomFollowing: !!t.eomFollowing, page: it.page, box: charBox(it, at, at + m[0].length) };
      const base = invoiceDate && parseDate(invoiceDate);
      if (base) {
        const d = new Date(`${base}T00:00:00Z`);
        if (t.eomFollowing) {
          d.setUTCMonth(d.getUTCMonth() + 2, 0); // last day of next month
        } else if (t.eom) {
          d.setUTCMonth(d.getUTCMonth() + 1, 0); // end of this month…
          d.setUTCDate(d.getUTCDate() + days); // …then the days
        } else {
          d.setUTCDate(d.getUTCDate() + days);
        }
        found.dueDate = ymd(d);
      }
      return found;
    }
  }
  return null;
}

// ── VAT registration numbers ─────────────────────────────────────────

/** Strip a VAT number to its digits ("GB 162 395 011" → "162395011"). */
export function normaliseVatNumber(s) {
  const d = String(s || '').toUpperCase().replace(/^GB/, '').replace(/[^0-9]/g, '');
  return d.length === 9 || d.length === 12 ? d : null;
}

/** Every UK VAT number printed on the document, with where it is. */
export function findVatNumbers(items) {
  const out = [];
  const seen = new Set();
  // 9 digits (or 12 for a branch), spaced any way: "GB 162 395 011", "394 1212 63"
  const re = /\b(?:GB\s*)?\d(?:\s?\d){8}(?:(?:\s?\d){3})?\b/g;
  const rows = groupRows(items);
  for (const row of rows) {
    const line = row.items.map((it) => it.str).join(' ');
    const labelled = /\bvat\b|\bGB\s*\d/i.test(line);
    if (!labelled) continue;
    for (const it of row.items) {
      for (const m of it.str.matchAll(re)) {
        // Must look like a VAT number: GB prefix, or on a row that says VAT
        if (!/^GB/i.test(m[0]) && !/\bvat\b/i.test(line)) continue;
        // An EORI number is "GB" + 12 digits too (Cemex prints both)
        if (/eori\b[^0-9]*$/i.test(it.str.slice(0, m.index))) continue;
        const n = normaliseVatNumber(m[0]);
        if (!n || seen.has(n)) continue;
        seen.add(n);
        out.push({ number: n, text: m[0].trim(), page: it.page, box: charBox(it, m.index, m.index + m[0].length) });
      }
    }
  }
  return out;
}

export default { findLines, fillMissingRates, findPaymentTerms, findVatNumbers, normaliseVatNumber, parseNumber };
