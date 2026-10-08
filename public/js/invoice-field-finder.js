/**
 * Invoice field finder for the document entry screen.
 *
 * Reads the positioned text PDF.js gives for each page (the Paperless archive
 * PDF carries an OCR text layer) and guesses the invoice number, dates and
 * totals by finding a label ("Document No.", "Total VAT", …) and the value
 * printed beside it or just below it. Each guess carries the box of the text
 * it came from, so the viewer can draw around it.
 *
 * Pure functions, no DOM: the browser imports this as a module and the tests
 * import it straight from disk. Boxes are in PDF units (origin bottom-left),
 * ready for viewport.convertToViewportPoint().
 */

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// A month as a word: its three-letter short form, "Sept", or in full
const MONTH_WORD = /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)$/i;

const pad = (n) => String(n).padStart(2, '0');

/** UK-order date text → 'YYYY-MM-DD', or null. */
export function parseDate(text) {
  const s = String(text || '').trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
  let d; let m; let y;
  let r = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (r) [, d, m, y] = r.map(Number);
  if (!r) {
    // "28 Sep 2026", "28-Sept-26", or run together as Beers print it: "16Dec25"
    r = s.match(/^(\d{1,2})[\s-]*([a-z]{3,9})\.?,?[\s-]*(\d{2}|\d{4})$/i);
    if (r && MONTH_WORD.test(r[2])) { d = Number(r[1]); m = MONTHS[r[2].slice(0, 3).toLowerCase()]; y = Number(r[3]); } else r = null;
  }
  if (!r) {
    r = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (r) [, y, m, d] = r.map(Number);
  }
  if (!r || !m) return null;
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Money text → '1234.56', or null. Needs pence, so quantities don't count. */
export function parseMoney(text) {
  let s = String(text || '').trim().replace(/\s*(GBP|CR|DR)$/i, '').replace(/^GBP\s*/i, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  s = s.replace(/^£\s?/, '');
  if (!/^(\d{1,3}(,\d{3})+|\d+)\.\d{2}$/.test(s)) return null;
  const v = s.replace(/,/g, '');
  return neg ? `-${v}` : v;
}

/** An invoice number: has a digit, no spaces, and isn't a date or an amount. */
export function parseReference(text) {
  const s = String(text || '').trim().replace(/^[#:\s]+/, '').replace(/[.,;:]+$/, '');
  if (!s || s.length > 30 || /\s/.test(s) || !/\d/.test(s)) return null;
  if (parseDate(s) || parseMoney(s) || /^£/.test(s)) return null;
  return s;
}

const PARSERS = { reference: parseReference, date: parseDate, money: parseMoney };

/**
 * Labels per field, best first. `below` lets the value sit under the label
 * (header-over-value layouts); off for bare words like "Total" and "Date",
 * which head table columns too often.
 */
export const FIELDS = [
  {
    field: 'invoiceNumber', label: 'Invoice number', type: 'reference',
    labels: [
      { re: /(tax\s+)?invoice\s*(no\b\.?|number|num\b\.?|#|ref(erence)?\b)/iy, below: true },
      { re: /inv\.?\s*(no\b\.?|#)/iy, below: true },
      { re: /(document|doc\.?)\s*(no\b\.?|number|#)/iy, below: true },
      { re: /invoice\b(?!\s*(date|to|address|total|period))/iy, below: false, rank: 3 },
    ],
  },
  {
    field: 'invoiceDate', label: 'Invoice date', type: 'date',
    labels: [
      { re: /(invoice|tax\s*point|document|doc\.?)\s*date\b/iy, below: true },
      { re: /(date\s*(of\s*)?(invoice|issue|supply)|issue\s*date|date\s*issued)\b/iy, below: true },
      { re: /date\b/iy, below: false, rank: 2 },
    ],
  },
  {
    field: 'dueDate', label: 'Due date', type: 'date',
    labels: [
      { re: /(payment\s*)?due(\s*date)?\b/iy, below: true },
      { re: /pay(ment)?\s*by\b/iy, below: true },
      // Beers: "Invoice due for payment by 31Jan26"
      { re: /invoice\s*due(\s*for\s*payment)?(\s*by)?\b/iy, below: false },
    ],
  },
  {
    field: 'totalGoods', label: 'Total goods', type: 'money',
    labels: [
      { re: /(total\s*goods|goods\s*total|net\s*total|total\s*net|sub[\s-]?total|total\s*\(?\s*(ex(cl(uding)?)?\.?|before)\s*(vat|tax)\)?|net\s*amount|goods\s*value)(?=\W|$)/iy, below: true },
    ],
  },
  {
    field: 'totalVat', label: 'Total VAT', type: 'money',
    labels: [
      { re: /(total\s*vat|vat\s*total|vat\s*amount|tax\s*amount|total\s*tax|vat\s*@\s*\d+(\.\d+)?\s*%)/iy, below: true },
      // Bare "VAT", the amount further along the row past any rate: Beers prints
      // "V AT   20.00%   8.28" (the OCR splits the word). Ranked last; the
      // goods + VAT = total check settles it when it's wrong.
      { re: /v\s?at\b(?!\s*(reg|no\b|number|code|rate|summary|analysis|%))/iy, below: false, rank: 3 },
    ],
  },
  {
    field: 'invoiceTotal', label: 'Invoice total', type: 'money',
    labels: [
      { re: /(total\s*due|inv(oice|\.)?\s*total|amount\s*due|balance\s*due|grand\s*total|total\s*\(?\s*inc(l(uding)?)?\.?\s*(vat|tax)\)?|total\s*payable|amount\s*payable|total\s*amount|total\s*paid)(?=\W|$)/iy, below: true },
      // Bare "Total" (or "Total Charge"), but not the goods or VAT subtotals
      { re: /total\b(?!\s*\(?\s*(goods|vat|net|ex|excl|excluding|before|tax|qty|quantity|weight|items?|discount|units?)\b)/iy, below: false, rank: 3 },
    ],
  },
];

// Any label at all: a value search stops when it runs into one
const ANY_LABEL = FIELDS.flatMap((f) => f.labels.map((l) => l.re));

/** PDF.js text items for one page → our plain shape. */
export function toItems(textItems, pageNumber) {
  const out = [];
  for (const it of textItems || []) {
    const str = String(it.str || '');
    if (!str.trim() || !it.transform) continue;
    const [a, b, c, d, x, y] = it.transform;
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01) continue; // rotated text
    const h = it.height || Math.hypot(c, d) || Math.abs(a) || 10;
    // Some fonts draw "-" from a private-use slot, so the text reads U+E088 and
    // the like ("INV" "\uE088" "22121" on Xero invoices). A lone one is a hyphen.
    const clean = /^[\uE000-\uF8FF]$/.test(str) ? '-' : str;
    out.push({ str: clean, x, y, w: it.width || 0, h, page: pageNumber });
  }
  return out;
}

/** Group items sharing a baseline into rows, top of page first, left to right. */
export function groupRows(items) {
  const sorted = [...items].sort((p, q) => p.page - q.page || q.y - p.y || p.x - q.x);
  const rows = [];
  for (const it of sorted) {
    const row = rows.find((r) => r.page === it.page && Math.abs(r.y - it.y) <= Math.min(r.h, it.h) * 0.45);
    if (row) { row.items.push(it); row.h = Math.max(row.h, it.h); } else rows.push({ page: it.page, y: it.y, h: it.h, items: [it] });
  }
  for (const r of rows) r.items.sort((p, q) => p.x - q.x);
  return rows;
}

/** Box around chars [from, to) of one item, sized by share of its width. */
export function charBox(it, from = 0, to = it.str.length) {
  const per = it.str.length ? it.w / it.str.length : 0;
  return {
    page: it.page, x: it.x + per * from, y: it.y - it.h * 0.25, w: per * (to - from), h: it.h * 1.25,
    // The text it was cut from, for fitBox: characters aren't all the same width
    src: { str: it.str, from, to, x: it.x, w: it.w },
  };
}

/**
 * charBox assumes every character is the same width, so a box around part of
 * a line in a proportional font ("Invoice No. A26825510698") drifts. Given a
 * way to measure the item's text as drawn, place it exactly.
 * @param {object} box       from charBox (has .src)
 * @param {(prefix: string) => number|null} measure  width of a prefix of the item's text, any scale
 */
export function fitBox(box, measure) {
  const src = box?.src;
  if (!src || !measure || (src.from === 0 && src.to === src.str.length)) return box;
  const all = measure(src.str);
  if (!(all > 0)) return box;
  const a = measure(src.str.slice(0, src.from));
  const b = measure(src.str.slice(0, src.to));
  if (a == null || b == null) return box;
  return { ...box, x: src.x + (src.w * a) / all, w: (src.w * (b - a)) / all };
}

export function unionBox(boxes) {
  const bs = boxes.filter(Boolean);
  if (!bs.length) return null;
  const x1 = Math.min(...bs.map((b) => b.x));
  const y1 = Math.min(...bs.map((b) => b.y));
  const x2 = Math.max(...bs.map((b) => b.x + b.w));
  const y2 = Math.max(...bs.map((b) => b.y + b.h));
  return { page: bs[0].page, x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * Match `re` (sticky) at the start of item `i` in a row, spanning further
 * items if the label is split ("Invoice" "No."). Returns where it ends.
 */
function matchLabelAt(row, i, re) {
  let text = '';
  const starts = [];
  for (let k = i; k < row.items.length && k < i + 4; k++) {
    // Words of one label sit close; a wide gap is the next column
    if (k > i && row.items[k].x - (row.items[k - 1].x + row.items[k - 1].w) > row.items[k - 1].h * 1.5) break;
    if (k > i) text += ' ';
    starts.push(text.length);
    text += row.items[k].str;
  }
  re.lastIndex = text.length - text.trimStart().length;
  const m = re.exec(text);
  if (!m) return null;
  const end = m.index + m[0].length;
  let k = starts.length - 1;
  while (k > 0 && starts[k] > end) k--;
  if (starts[k] === end && k > 0 && text[end - 1] === ' ') k--;
  return { lastItem: i + k, charEnd: end - starts[k], labelBox: unionBox(row.items.slice(i, i + k + 1).map((it) => charBox(it))) };
}

export const startsLabel = (str) => ANY_LABEL.some((re) => { re.lastIndex = 0; return re.test(str.trimStart()); });

/**
 * Items touching items[k] on its right: one value the PDF split up
 * ("INV" "-" "22121", "£" "45.42"). Returns null if nothing touches.
 */
function touchingRun(items, k, lead = items[k].str) {
  const run = [items[k]];
  while (items[k + run.length] && items[k + run.length].x - (run.at(-1).x + run.at(-1).w) < items[k].h * 0.25) run.push(items[k + run.length]);
  if (run.length < 2) return null;
  return { text: (lead + run.slice(1).map((r) => r.str).join('')).trim(), box: unionBox(run.map((r) => charBox(r))) };
}

/**
 * Value pieces to try after a label: the rest of the label's own item
 * ("Date: 01/02/2026"), then items further along the row, then items under it.
 */
function* valuePieces(rows, rowIdx, hit, below, pageWidth) {
  const row = rows[rowIdx];
  const labelItem = row.items[hit.lastItem];
  const rest = labelItem.str.slice(hit.charEnd);
  const restTrim = rest.replace(/^[\s:#.\-–]+/, '');
  if (restTrim.trim()) {
    const from = labelItem.str.length - restTrim.length;
    yield { text: restTrim.trim(), box: charBox(labelItem, from, from + restTrim.trimEnd().length), sameRow: true };
  }
  const right = hit.labelBox.x + hit.labelBox.w;
  for (let k = hit.lastItem + 1; k < row.items.length; k++) {
    const it = row.items[k];
    if (it.x - right > pageWidth * 0.9) break;
    const s = it.str.replace(/^[\s:#]+/, '');
    if (startsLabel(s)) break;
    if (!s.trim()) continue;
    const run = touchingRun(row.items, k, s);
    if (run) yield { ...run, sameRow: true };
    yield { text: s.trim(), box: charBox(it, it.str.length - s.length, it.str.trimEnd().length), sameRow: true };
    // A two-part value, e.g. "£" "45.42" or "28 Sep" "2026"
    const next = row.items[k + 1];
    if (next && next.x - (it.x + it.w) < it.h * 1.5) {
      yield { text: `${s.trim()} ${next.str.trim()}`, box: unionBox([charBox(it), charBox(next)]), sameRow: true };
    }
  }
  if (!below) return;
  const lb = hit.labelBox;
  for (let r = rowIdx + 1; r < rows.length; r++) {
    const under = rows[r];
    if (under.page !== row.page) break;
    if (row.y - under.y > row.h * 3) break;
    for (let k = 0; k < under.items.length; k++) {
      const it = under.items[k];
      const overlaps = it.x < lb.x + lb.w + it.h && it.x + it.w > lb.x - it.h;
      if (!overlaps || startsLabel(it.str)) continue;
      const run = touchingRun(under.items, k);
      if (run) yield { ...run, sameRow: false };
      yield { text: it.str.trim(), box: charBox(it, 0, it.str.trimEnd().length), sameRow: false };
    }
  }
}

/**
 * Every candidate for every field, best first per field.
 * @param {Array} items  from toItems(), all pages
 * @param {object} [opts] { pageWidth }
 */
/**
 * Labels that wrap onto a second line, label text in the same column:
 *
 *   Sales Invoice
 *   No:  3015645870
 *
 * Returns a stand-in row (upper items + the lower row from that column on)
 * for matchLabelAt/valuePieces to work on, sitting where the lower row is.
 */
function* wrappedRows(rows) {
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    for (let rk = ri + 1; rk < rows.length; rk++) {
      const lower = rows[rk];
      if (lower.page !== row.page || row.y - lower.y > row.h * 2.6) break;
      for (let i = 0; i < row.items.length; i++) {
        const head = row.items[i];
        const m = lower.items.findIndex((it) => Math.abs(it.x - head.x) <= head.h);
        if (m < 0) continue;
        for (let j = i; j < Math.min(row.items.length, i + 3); j++) {
          if (j > i && row.items[j].x - (row.items[j - 1].x + row.items[j - 1].w) > head.h * 1.5) break;
          const upper = row.items.slice(i, j + 1);
          yield { rk, upperCount: upper.length, row: { page: lower.page, y: lower.y, h: Math.max(row.h, lower.h), items: [...upper, ...lower.items.slice(m)] } };
        }
      }
    }
  }
}

/**
 * Totals laid out as a table, the figures under column headings:
 *
 *              Gross    Net     VAT
 *   Sub total  £23.99   £19.99  £4.00
 *
 * Each figure on a "Total"/"Sub total" row takes its field from the heading
 * above it, if the heading says Net, VAT or Gross/Total.
 */
const TOTALS_ROW = /(sub[\s-]?)?totals?\b/iy;
const HEADING_FIELD = [
  ['totalVat', /\b(vat|tax)\b(?!\s*(%|rate|code|reg))/i],
  ['totalGoods', /\b(net|goods|nett)\b/i],
  ['invoiceTotal', /\b(gross|total|amount)\b/i],
];
function columnTotals(rows) {
  const out = [];
  rows.forEach((row, ri) => {
    const first = row.items[0];
    if (!first) return;
    TOTALS_ROW.lastIndex = 0;
    if (!TOTALS_ROW.test(first.str.trimStart())) return;
    // A table row has several figures; "Subtotal  10.29" is the plain label case
    if (row.items.filter((it) => parseMoney(it.str) != null).length < 2) return;
    for (const it of row.items.slice(1)) {
      const value = parseMoney(it.str);
      if (value == null) continue;
      // Headings: text above this figure's column, within a few lines
      const words = [];
      for (let r = ri - 1; r >= 0 && rows[r].page === row.page && rows[r].y - row.y < row.h * 6; r--) {
        for (const h of rows[r].items) {
          if (h.x < it.x + it.w && h.x + h.w > it.x && parseMoney(h.str) == null) words.unshift(h.str);
        }
      }
      const heading = words.join(' ');
      const hit = HEADING_FIELD.find(([, re]) => re.test(heading));
      if (!hit) continue;
      const def = FIELDS.find((f) => f.field === hit[0]);
      out.push({
        field: def.field, label: def.label, value, text: it.str.trim(), page: row.page,
        box: charBox(it, it.str.length - it.str.trimStart().length, it.str.trimEnd().length),
        labelBox: charBox(first), generic: false, score: 20 + row.page,
      });
    }
  });
  return out;
}

/**
 * Label words someone added for a supplier ("Charged to Account" for the
 * invoice total), as labels the finder can use. Ranked ahead of the built-in
 * ones; spacing in the phrase is matched loosely.
 */
export function customLabels(phrases = []) {
  return (phrases || [])
    .map((p) => String(p || '').trim())
    .filter((p) => p.length >= 2 && p.length <= 60)
    .map((p) => ({
      re: new RegExp(p.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'iy'),
      below: true,
      rank: -1,
      custom: p,
    }));
}

export function findCandidates(items, { pageWidth = 595, labels = {} } = {}) {
  const rows = groupRows(items);
  const wrapped = [...wrappedRows(rows)];
  const fromColumns = columnTotals(rows);
  const out = {};
  for (const def of FIELDS) {
    const parse = PARSERS[def.type];
    const found = [];
    const take = (rs, ri, row, i, lbl, li, penalty, mustReach = 0) => {
      const hit = matchLabelAt(row, i, lbl.re);
      if (!hit || hit.lastItem < mustReach) return;
      for (const piece of valuePieces(rs, ri, hit, lbl.below, pageWidth)) {
        const value = parse(piece.text);
        if (value == null) continue;
        found.push({
          field: def.field,
          label: def.label,
          value,
          text: piece.text,
          page: row.page,
          box: piece.box,
          labelBox: hit.labelBox,
          generic: lbl.rank === 3,
          ...(lbl.custom ? { customLabel: lbl.custom } : {}),
          score: (lbl.rank ?? li) * 10 + (piece.sameRow ? 0 : 3) + penalty + row.page,
        });
        return;
      }
    };
    // Built-in labels keep their own rank, so custom ones don't push them down
    [...customLabels(labels?.[def.field]), ...def.labels.map((l, i) => (l.rank != null ? l : { ...l, rank: i }))].forEach((lbl, li) => {
      rows.forEach((row, ri) => {
        for (let i = 0; i < row.items.length; i++) take(rows, ri, row, i, lbl, li, 0);
      });
      // Only labels that need the second line count, or it's a plain match again
      for (const w of wrapped) {
        const rs = rows.slice();
        rs[w.rk] = w.row;
        for (let s = 0; s < w.upperCount; s++) take(rs, w.rk, w.row, s, lbl, li, 2, w.upperCount);
      }
    });
    found.push(...fromColumns.filter((c) => c.field === def.field));
    found.sort((p, q) => p.score - q.score);
    // Same value found twice (e.g. "Total Due" and "Charged to Account") — keep the best
    const seen = new Set();
    out[def.field] = found.filter((c) => (seen.has(c.value) ? false : seen.add(c.value)));
  }
  return out;
}

const near = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005;

const LEARNED_NEAR = 18; // PDF units: about two lines of text

/** How far a candidate's box is from where this supplier's invoices put the field. */
const distance = (box, spot) => (box.page !== spot.page ? Infinity : Math.hypot(box.x + box.w - (spot.x + spot.w), box.y - spot.y));

/**
 * A value printed at a learned spot, for when no label points at it.
 * Right edges line up better than left ones: amounts and numbers are right-aligned.
 */
function valueAtSpot(items, def, spot) {
  const parse = PARSERS[def.type];
  let best = null;
  for (const it of items) {
    const box = charBox(it);
    const d = distance(box, spot);
    if (d > LEARNED_NEAR) continue;
    for (const t of [it.str.trim(), ...it.str.trim().split(/\s+/)]) {
      const value = parse(t);
      if (value == null) continue;
      const at = it.str.indexOf(t);
      if (!best || d < best.d) best = { d, value, text: t, box: charBox(it, at, at + t.length) };
      break;
    }
  }
  return best && { field: def.field, label: def.label, value: best.value, text: best.text, page: spot.page, box: best.box, labelBox: null, generic: false, learned: true, score: 15 + spot.page };
}

/**
 * The best guess per field. Totals that add up (goods + VAT = total) win over
 * a higher-ranked label that doesn't fit.
 * @param {object} [opts] { pageWidth, layout: { field: {page, x, y, w, h} } } —
 *   layout is where this supplier's earlier invoices had each field
 */
export function findFields(items, opts = {}) {
  const cands = findCandidates(items, opts);
  const layout = opts.layout || {};
  for (const def of FIELDS) {
    const spot = layout[def.field];
    if (!spot) continue;
    const list = cands[def.field];
    // A candidate where this supplier always prints the field goes first
    for (const c of list) if (distance(c.box, spot) <= LEARNED_NEAR) { c.score -= 25; c.learned = true; }
    if (!list.some((c) => c.learned)) {
      const at = valueAtSpot(items, def, spot);
      if (at && !list.some((c) => c.value === at.value)) list.push(at);
    }
    list.sort((p, q) => p.score - q.score);
  }
  const pick = Object.fromEntries(Object.entries(cands).map(([k, v]) => [k, v[0] || null]));
  const fits = (g, v, t) => g && v && t && g !== t && near(Number(g.value) + Number(v.value), t.value);
  if (fits(pick.totalGoods, pick.totalVat, pick.invoiceTotal)) return pick;
  // A bare "Total" line can be the goods figure ("Total Charge" above "VAT" and "TOTAL")
  const G = [...cands.totalGoods, ...cands.invoiceTotal.filter((c) => c.generic).map((c) => ({ ...c, field: 'totalGoods', label: 'Total goods' }))];
  let best = null;
  for (const g of G) for (const v of cands.totalVat) for (const t of cands.invoiceTotal) {
    if (g.value === t.value || !fits(g, v, t)) continue;
    const s = g.score + v.score + t.score;
    if (!best || s < best.s) best = { s, g, v, t };
  }
  if (best) Object.assign(pick, { totalGoods: best.g, totalVat: best.v, invoiceTotal: best.t });
  return pick;
}

/** Normalise a form value the same way, so it can be compared with a guess. */
export function normalise(type, value) {
  if (value == null || value === '') return null;
  if (type === 'money') return parseMoney(String(value)) ?? parseMoney(Number(value).toFixed(2));
  if (type === 'date') return parseDate(value);
  return String(value).trim().toUpperCase();
}

/** Where on the document a value (typed or from Paperless) appears, if anywhere. */
export function locateValue(items, field, value) {
  const def = FIELDS.find((f) => f.field === field);
  if (!def) return null;
  const want = normalise(def.type, value);
  if (!want) return null;
  const parse = PARSERS[def.type];
  for (const it of items) {
    const words = it.str.split(/\s+/).filter(Boolean);
    const tries = [it.str.trim(), ...words];
    for (const t of tries) {
      const got = parse(t);
      if (got != null && normalise(def.type, got) === want) {
        const at = it.str.indexOf(t);
        return { field, value: got, text: t, page: it.page, box: charBox(it, at, at + t.length) };
      }
    }
  }
  return null;
}

export default { FIELDS, customLabels, fitBox, toItems, groupRows, findCandidates, findFields, locateValue, normalise, parseDate, parseMoney, parseReference, unionBox, charBox, startsLabel };
