/**
 * statementReadingService.js — read a supplier statement and set it against
 * KashFlow (Paperless migration, phase 2 item 6).
 *
 * A supplier statement lists what the supplier thinks we owe: invoices,
 * credits, payments received and a closing balance. Reviewing one means
 * checking that list against the purchases in KashFlow for that supplier.
 * This service does the comparing, so the reviewer sees the differences
 * instead of two documents.
 *
 *   parseStatement(text)        the OCR text as header figures + lines
 *   reconcile(parsed, purchases) matched / on the statement only / in KashFlow only
 *   readStatement(paperlessId)  the two above, stored on OcrDocument.statement
 *
 * The parser is deliberately tolerant. Every supplier lays a statement out
 * differently, so a line that can't be read is kept as raw text and counted,
 * never dropped. Nothing here changes a document's state: reading only
 * informs the person marking it reviewed.
 */

import mdb from '../mongooseDatabaseService.js';
import logger from '../../../services/loggerService.js';
import { isDocumentType, documentTypeQuery } from '../../config/paperlessTypesConfig.js';
import { supplierFor, extractItems, packItem, unpackItem, READER_VERSION } from './documentReadingService.js';
import { groupRows, charBox, unionBox } from '../../../public/js/invoice-field-finder.js';
import __paperlessClient from './paperlessClient.js';

// Bump when the parser or matcher changes enough that stored readings should be redone
export const STATEMENT_READER_VERSION = 4; // 4: read by column from the PDF's positioned text, with a supplier's taught layout
/** Days either side of a statement line's date that a purchase may be issued and still match on amount. */
export const DATE_TOLERANCE_DAYS = 5;
const MAX_LINES = 400;
const MAX_PURCHASES = 1500;
const RAW_KEEP = 160;

// ── Text helpers ─────────────────────────────────────────────────────

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
// 28/08/2026, 28-08-26, 28.08.2026, 30 Sep 2026, 30-Sep-26, 30 September 2026
const DATE_RE = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b|\b(\d{1,2})[ -]([A-Za-z]{3,9})[ -](\d{2}|\d{4})\b/g;
// £1,234.56  -£12.00  (12.00)  12.00CR  1234.56-
const MONEY_RE = /(-|\()?£?\s?(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})(\)|-|\s?(?:CR|DR)\b)?/gi;
const TIME_RE = /\b\d{1,2}:\d{2}\b/g;

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => {
  const yy = y < 100 ? 2000 + y : y;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(yy, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? `${yy}-${pad(m)}-${pad(d)}` : null;
};

/** Every date on a line, as ISO strings, in order. */
export function findDates(line) {
  const out = [];
  for (const m of String(line || '').matchAll(DATE_RE)) {
    const value = m[1] ? iso(Number(m[3]), Number(m[2]), Number(m[1]))
      : (MONTHS[m[5].toLowerCase()] ? iso(Number(m[6]), MONTHS[m[5].toLowerCase()], Number(m[4])) : null);
    if (value) out.push({ value, text: m[0], index: m.index });
  }
  return out;
}

/** Every money amount on a line, signed (CR, brackets and a trailing minus are negative). */
export function findMoney(line, { dates = findDates(line) } = {}) {
  const s = String(line || '');
  const out = [];
  for (const m of s.matchAll(MONEY_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    // A dotted date ("03.09.26") or a dotted number ("1.2.34") isn't an amount
    if (dates.some((d) => start < d.index + d.text.length && end > d.index)) continue;
    if (/^\.\d/.test(s.slice(end)) || /\d\.$/.test(s.slice(0, start))) continue;
    const n = Number(`${m[2].replace(/,/g, '')}.${m[3]}`);
    if (!Number.isFinite(n)) continue;
    const tail = (m[4] || '').trim().toUpperCase();
    const negative = m[1] === '-' || m[1] === '(' || tail === ')' || tail === '-' || tail === 'CR';
    out.push({ value: negative ? -n : n, text: m[0], index: m.index });
  }
  return out;
}

/** A reference as compared: letters and digits only, upper case. */
export const normRef = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const PAYMENT_WORDS = /\b(payment|paid|receipt|remittance|bacs|cheque|chq|transfer|rebill|top[ -]?up|thank you)\b/i;
// "Cre" and "Crn" are the type column's short form on some statements ("Inv" / "Cre")
const CREDIT_WORDS = /\b(credit|cr note|c\/n|refund|cre|crn)\b/i;
const BALANCE_WORDS = /\b(balance|b\/f|c\/f|brought forward|carried forward|opening|closing|total|sub[ -]?total|amount due|outstanding|overdue|current|30 days|60 days|90 days)\b/i;

/** What kind of statement line this is, from its words. */
export function lineKind(text) {
  if (PAYMENT_WORDS.test(text)) return 'payment';
  if (CREDIT_WORDS.test(text)) return 'credit';
  if (BALANCE_WORDS.test(text)) return 'balance';
  return 'invoice';
}

/**
 * Reference tokens on a line: anything with a digit that isn't a date, time
 * or amount. "INV-1001", "0767/08028363", "260461". Words joined by a slash
 * or hyphen stay together.
 */
export function findRefs(line, { dates = findDates(line), money = findMoney(line) } = {}) {
  const taken = [...dates, ...money].map((x) => [x.index, x.index + x.text.length]);
  for (const m of String(line || '').matchAll(TIME_RE)) taken.push([m.index, m.index + m[0].length]);
  const out = [];
  for (const m of String(line || '').matchAll(/[A-Za-z0-9][A-Za-z0-9/._-]*\d[A-Za-z0-9/._-]*|\d[A-Za-z0-9/._-]*/g)) {
    const start = m.index;
    const end = start + m[0].length;
    if (taken.some(([a, b]) => start < b && end > a)) continue;
    const token = m[0].replace(/[._-]+$/, '');
    if (normRef(token).length < 3) continue;
    out.push(token);
  }
  return out;
}

// ── Parsing ──────────────────────────────────────────────────────────

const slimRaw = (s) => (s.length > RAW_KEEP ? `${s.slice(0, RAW_KEEP - 1)}…` : s);

const CLOSING_WORDS = 'closing balance|balance due|amount due|total due|total outstanding|balance outstanding|amount outstanding|balance now due|total payable|amount payable|balance payable|now payable|total amount payable|total now due';
const CLOSING_RE = new RegExp(`\\b(${CLOSING_WORDS})\\b`);
const CLOSING_COLUMN_RE = new RegExp(`\\b(${CLOSING_WORDS})\\s*$`);
const OPENING_RE = /\b(previous balance|opening balance|brought forward|b\/f)\b/;
// An ageing table's headings ending in "Total": "Prior  August  September  Current  On Account  Total"
const AGEING_TOTAL_RE = /\b(current|prior|older|days|period|on account)\b.*\btotal\s*$/;

/**
 * The columns of a statement's line table that carry a reference, in order,
 * from its heading row: "Date  Branch  Document Reference  Value  Outstanding"
 * gives ['code', 'doc']. A code column (branch, depot, account) holds the same
 * short number on every line; the document column is the one KashFlow knows.
 */
const COLUMN_RE = /\b(document reference|document (?:no|number)|doc(?:ument)? ?(?:no|number|ref)|invoice (?:no|number|ref)|inv no|transaction (?:no|ref)|our ref(?:erence)?|your ref(?:erence)?|order (?:no|number|ref)|cust(?:omer)? ref|reference|document|ref|number|branch|depot|account|a\/c|acct)\b/g;
const AMOUNT_HEADING_RE = /\b(value|amount|debit|credit|balance|outstanding|total|gross)\b/;
const columnKind = (label) => (/^(branch|depot|account|a\/c|acct)$/.test(label) ? 'code'
  : /^(your ref|order|cust)/.test(label) ? 'other' : 'doc');

/** "Date  Type  Reference  Amount  Outstanding Amount": a per-line Outstanding column and no Balance column. */
export function isOpenItemHeading(row) {
  const lower = String(row || '').toLowerCase();
  return /\bdate\b/.test(lower) && /\boutstanding\b/.test(lower) && !/\bbalance\b/.test(lower)
    && !/\btotal outstanding\b/.test(lower) && !/\d/.test(lower);
}

/** The reference columns of a heading row, or null when the row isn't one. */
export function referenceColumns(row) {
  const lower = String(row || '').toLowerCase();
  if (!/\bdate\b/.test(lower) || !AMOUNT_HEADING_RE.test(lower) || /\d/.test(lower)) return null;
  const kinds = [...lower.matchAll(COLUMN_RE)].map((m) => columnKind(m[1]));
  if (!kinds.length) return null;
  const doc = kinds.indexOf('doc');
  return { kinds, pick: doc >= 0 ? doc : Math.max(0, kinds.indexOf('other')) };
}

/**
 * A date under a "Date" heading in a header box: "Account  Date  Page" over
 * "100317  02/11/2026  1". Taken from the same column when the two rows line
 * up, or when it's the only date on the row.
 */
const headerBoxDate = (above, raw, dates) => {
  // The heading row may share its line with the address ("1 Example Street  Account  Date  Page"),
  // so digits are fine; dates and amounts are not
  if (!above || !dates.length || findDates(above).length || findMoney(above).length) return null;
  const labels = above.toLowerCase().replace(/:/g, '').split(' ');
  const at = labels.findIndex((w, i) => w === 'date' && !/^(due|invoice|payment|printed)$/.test(labels[i - 1] || ''));
  if (at < 0) return null;
  const values = raw.split(' ');
  if (values.length === labels.length) return dates.find((d) => d.text === values[at])?.value ?? null;
  return dates.length === 1 ? dates[0].value : null;
};

/** "Date 31/10/2026" on its own, as a header beside the address prints it. Not a due or invoice date. */
const isDateLabel = (raw, date) => {
  const before = raw.slice(0, date.index).toLowerCase();
  return /\bdate\s*:?\s*$/.test(before) && !/\b(due|invoice|payment|printed)\s+date\s*:?\s*$/.test(before);
};

/**
 * Read the OCR text of a statement.
 * @param {string} text
 * @returns {{header: object, lines: Array, unread: number, hasText: boolean}}
 *   header: { statementDate, periodStart, periodEnd, openingBalance, closingBalance, paymentsTotal }
 *   lines:  [{ raw, kind, date, ref, refs, amount, balance }], amount signed as printed
 *   unread: lines with a date or an amount that couldn't be read as a statement line
 */
export function parseStatement(text) {
  const rows = String(text || '').split(/\r?\n/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const header = { statementDate: null, periodStart: null, periodEnd: null, openingBalance: null, closingBalance: null, paymentsTotal: null };
  const lines = [];
  let unread = 0;
  let closingColumnAbove = false;
  let columns = null;
  let above = null;

  for (const raw of rows) {
    const prev = above;
    above = raw;
    const dates = findDates(raw);
    const money = findMoney(raw, { dates });
    const lower = raw.toLowerCase();

    // An ageing table: the headings end "Amount Due" and the figures sit on the
    // row below, so the last figure is the closing balance
    const figuresForClosing = closingColumnAbove && money.length && !dates.length;
    closingColumnAbove = !money.length && (CLOSING_COLUMN_RE.test(lower) || (AGEING_TOTAL_RE.test(lower) && !/\bdate\b/.test(lower)));
    if (figuresForClosing) {
      if (header.closingBalance == null) header.closingBalance = money.at(-1).value;
      continue;
    }

    // Header figures. The first mention wins; a statement repeats its header on every page.
    const labelledDate = !lines.length && dates.length === 1 && isDateLabel(raw, dates[0]);
    if (header.statementDate == null && (/statement\s*(date|of account)?\b/.test(lower) || labelledDate) && dates.length && !money.length) {
      header.statementDate = dates[0].value;
    }
    if (header.statementDate == null && !lines.length && !money.length) {
      header.statementDate = headerBoxDate(prev, raw, dates);
    }
    if (header.periodStart == null && /\b(period|from)\b/.test(lower) && dates.length >= 2) {
      header.periodStart = dates[0].value;
      header.periodEnd = dates[1].value;
      continue;
    }
    if (header.closingBalance == null && CLOSING_RE.test(lower) && money.length) {
      header.closingBalance = money.at(-1).value;
      continue;
    }
    if (header.openingBalance == null && OPENING_RE.test(lower) && money.length) {
      header.openingBalance = money.at(-1).value;
    }
    if (header.paymentsTotal == null && /^(total )?(payments?|receipts?)( received)?\b/.test(lower) && money.length && !dates.length) {
      header.paymentsTotal = Math.abs(money.at(-1).value);
      continue;
    }

    if (!money.length) {
      // The line table's headings say which column is the reference
      const cols = !dates.length && referenceColumns(raw);
      if (cols) columns = cols;
      // An open-item statement: each line's last figure is what's still
      // outstanding on it, not a running balance, and settled invoices and
      // their payments aren't listed at all
      if (!dates.length && isOpenItemHeading(raw)) header.openItems = true;
      // A date with nothing to it (a page header, a due date column) isn't a line
      continue;
    }
    const refs = findRefs(raw, { dates, money });
    let kind = lineKind(raw);
    // "Inv 1601 02108768 ... -66.90": a negative invoice line is a credit
    if (kind === 'invoice' && money[0].value < 0) kind = 'credit';
    if (kind === 'balance' && !refs.length && !dates.length) {
      // A totals row: "Total 114.00", "Balance 56.95". Only a closing figure
      // counts; "Previous balance" and "Opening balance" are the period's start.
      if (header.closingBalance == null && /^(closing )?balance\b/.test(lower)) header.closingBalance = money.at(-1).value;
      continue;
    }
    if (!refs.length && !dates.length) {
      // Money with nothing to tie it to
      unread += 1;
      continue;
    }
    if (lines.length >= MAX_LINES) { unread += 1; continue; }
    // Take the reference from the document column when the headings say which
    // one it is; a code column (branch, account) becomes the prefix
    const byColumn = Boolean(columns && columns.kinds.length > 1 && refs.length >= columns.kinds.length);
    const pick = byColumn ? columns.pick : 0;
    const code = byColumn ? columns.kinds.indexOf('code') : -1;
    lines.push({
      raw: slimRaw(raw),
      kind,
      date: dates[0]?.value ?? null,
      ref: refs[pick] ?? null,
      prefix: code >= 0 && code !== pick ? refs[code] : null,
      byColumn,
      refs,
      amount: money[0].value,
      balance: money.length > 1 ? money.at(-1).value : null,
    });
  }

  pickRepeatedCode(lines);
  periodFromLines(header, lines);
  return { header, lines, unread, hasText: rows.length > 0 };
}

/** No period printed: take it from the dated lines. */
function periodFromLines(header, lines) {
  const dated = lines.map((l) => l.date).filter(Boolean).sort();
  if (!header.periodStart && dated.length) {
    header.periodStart = dated[0];
    header.periodEnd = header.statementDate && header.statementDate > dated.at(-1) ? header.statementDate : dated.at(-1);
    header.periodSource = 'lines';
  } else if (header.periodStart) {
    header.periodSource = 'printed';
  }
}

/**
 * No headings to go by: a reference that is the same on most lines (a branch
 * or account code printed beside each document number) is not the document's
 * reference. The next one on the line is, and the code becomes its prefix.
 */
function pickRepeatedCode(lines) {
  const open = lines.filter((l) => !l.byColumn && (l.kind === 'invoice' || l.kind === 'credit'));
  if (open.length < 3) return;
  const counts = new Map();
  for (const l of open) if (l.ref && l.refs.length > 1) counts.set(normRef(l.ref), (counts.get(normRef(l.ref)) || 0) + 1);
  for (const [code, n] of counts) {
    if (n < 3 || n < open.length * 0.6) continue;
    for (const l of open) {
      if (normRef(l.ref) !== code || l.refs.length < 2) continue;
      const at = l.refs.findIndex((r) => normRef(r) === code);
      l.prefix = l.refs[at];
      l.ref = l.refs[at + 1] ?? l.refs.find((r, i) => i !== at) ?? null;
    }
  }
}

// ── Reading by position ──────────────────────────────────────────────
//
// The OCR text has lost where things sit on the page: a branch code, a
// document number, a dotted date in the details and the amount are just words
// on a line. The PDF's own text layer (documentReadingService.extractItems)
// still has each word's x position, so a statement with a heading row can be
// read column by column: the reference is whatever sits under "Reference",
// the amount whatever sits under "Value". A person can also point out a
// supplier's columns on the PDF (teachLayout), and that wins over the guess.

/** The statement columns a person can point out for a supplier. */
export const TAUGHT_ROLES = ['ref', 'amount', 'balance'];
export const STATEMENT_MAX_PAGES = 12;
const MONEY_ROLES = ['amount', 'credit', 'outstanding', 'balance'];
const REF_ROLES = ['code', 'doc', 'other'];
const HEADING_REACH = 60;
const TAUGHT_REACH = 20;

// A heading's words → what its column holds. Each pattern is the whole
// heading, so "Branch Document Reference Details" (headings PDF.js joined into
// one text item) splits into its headings rather than reading as one.
const HEADING_ROLES = [
  [/^(?:invoice |inv |doc(?:ument)? |trans(?:action)? |posting |entry |tran |tx )?date$/, 'date'],
  [/^(?:due|due date|payment date|date paid|paid date|paid on)$/, 'due'],
  [/^(?:type|trans(?:action)? type|doc(?:ument)? type|tran type|tx type)$/, 'type'],
  [/^(?:details?|description|particulars|narrative|memo|comments?|items?)$/, 'details'],
  [/^(?:running |cumulative |account )?balance$/, 'balance'],
  [/^(?:outstanding(?: amount| balance| value)?|amount outstanding|unpaid(?: amount)?|o\/s(?: amount)?|amount due|balance due|due amount|open(?: amount)?|remaining(?: amount)?|amount remaining)$/, 'outstanding'],
  [/^(?:credits?|cr|payments?|receipts?|paid amount|amount paid|paid)$/, 'credit'],
  [/^(?:debits?|dr|value|amount|gross|total|charges?|original(?: amount)?|(?:invoice|inv|document|doc|original|gross|transaction) (?:amount|value|total))$/, 'amount'],
  [/^(?:branch|depot|account|a\/c|acct|site|store)(?: (?:no|number|code|ref))?$/, 'code'],
  [/^(?:your ref(?:erence)?|order(?: (?:no|number|ref))?|cust(?:omer)? (?:ref(?:erence)?|order(?: no)?)|po(?: (?:no|number))?|purchase order(?: no)?)$/, 'other'],
  [/^(?:(?:document|doc|invoice|inv|transaction|trans|our|supplier|item|tx) )?(?:ref(?:erence)?|no|number|#)$|^(?:document|invoice|reference|ref|transaction|number)$/, 'doc'],
];
const LONGEST_HEADING = 4; // words
export const headingRole = (label) => {
  const l = String(label || '').toLowerCase().replace(/\(£\)|£|[:.]/g, ' ').replace(/\s+/g, ' ').trim();
  return l ? (HEADING_ROLES.find(([re]) => re.test(l))?.[1] ?? null) : null;
};

/** Each word of a row with its left and right edge (PDF units). */
function rowWords(row) {
  const out = [];
  for (const it of row.items) {
    for (const m of it.str.matchAll(/\S+/g)) {
      const b = charBox(it, m.index, m.index + m[0].length);
      out.push({ text: m[0], x0: b.x, x1: b.x + b.w, box: b });
    }
  }
  return out.sort((a, b) => a.x0 - b.x0);
}
const rowText = (row) => row.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
const r1 = (n) => Math.round(n * 10) / 10;
const plainBox = (b) => (b ? { page: b.page, x: r1(b.x), y: r1(b.y), w: r1(b.w), h: r1(b.h) } : null);
const rowBox = (row) => plainBox(unionBox(row.items.map((it) => charBox(it))));
const wordsText = (ws) => ws.map((w) => w.text).join(' ');

/**
 * A run of heading words as headings: the longest phrase that is one at each
 * point ("Outstanding Amount", then "Document Reference"); words that are no
 * heading join up into a column of their own, so nothing bleeds across it.
 */
function splitHeadings(run, cell) {
  const out = [];
  let i = 0;
  while (i < run.length) {
    let n = Math.min(LONGEST_HEADING, run.length - i);
    while (n > 0 && !headingRole(wordsText(run.slice(i, i + n)))) n -= 1;
    if (n) {
      out.push({ ws: run.slice(i, i + n), role: headingRole(wordsText(run.slice(i, i + n))) });
      i += n;
      continue;
    }
    const last = out.at(-1);
    if (last && last.role == null) last.ws.push(run[i]); else out.push({ ws: [run[i]], role: null });
    i += 1;
  }
  return out.map((c) => ({ ...cell(c.ws), role: c.role }));
}

/**
 * The columns of a heading row, or null when the row isn't one: no figures,
 * a Date column, and a column of amounts. Words printed apart are never one
 * heading; words close together are split into the headings they make.
 * @returns {Array<{label, role, x0, x1, box}>|null}
 */
export function headingColumns(row) {
  if (/\d/.test(rowText(row))) return null;
  const words = rowWords(row);
  if (words.length < 2) return null;
  const gap = Math.max(2, (row.h || 10) * 0.6);
  const runs = [];
  for (const w of words) {
    const last = runs.at(-1);
    if (last && w.x0 - last.at(-1).x1 <= gap) last.push(w); else runs.push([w]);
  }
  const cell = (ws) => ({ label: wordsText(ws), x0: ws[0].x0, x1: ws.at(-1).x1, box: plainBox(unionBox(ws.map((w) => w.box))) });
  const cells = runs.flatMap((run) => splitHeadings(run, cell));
  const roles = cells.map((c) => c.role);
  if (!roles.includes('date') || !roles.some((r) => MONEY_ROLES.includes(r))) return null;
  // One document column, the first; a later one is another reference
  let seenDoc = false;
  for (const c of cells) {
    if (c.role !== 'doc') continue;
    if (seenDoc) c.role = 'other';
    seenDoc = true;
  }
  if (!seenDoc) {
    const other = cells.find((c) => c.role === 'other');
    if (other) other.role = 'doc';
  }
  return cells;
}

/**
 * The column a word (or a pointed-out span) belongs to: the one it overlaps
 * most, or else the one it lines up with (left edges, centres or right
 * edges, since figures are right-aligned under headings that often aren't),
 * within reach.
 */
function columnFor(span, columns, reach) {
  let best = null;
  let most = 0;
  for (const c of columns) {
    const overlap = Math.min(span.x1, c.x1) - Math.max(span.x0, c.x0);
    if (overlap > most) { most = overlap; best = c; }
  }
  if (best) return best;
  let near = null;
  let closest = reach;
  const mid = (span.x0 + span.x1) / 2;
  for (const c of columns) {
    const d = Math.min(Math.abs(span.x0 - c.x0), Math.abs(span.x1 - c.x1), Math.abs(mid - (c.x0 + c.x1) / 2));
    if (d < closest) { closest = d; near = c; }
  }
  return near;
}

/** A taught layout as stored on SupplierLayout.statement → the spans the reader takes. */
const taughtSpans = (taught) => Object.entries(taught?.columns || {})
  .filter(([role, b]) => TAUGHT_ROLES.includes(role) && b && Number.isFinite(Number(b.x)) && Number(b.w) > 0)
  .map(([role, b]) => ({ role, x0: Number(b.x), x1: Number(b.x) + Number(b.w), label: b.label || null }));

const OWED_ROLES = ['outstanding', 'balance'];

/**
 * Put what a person pointed out over the guessed columns: the heading under
 * a taught span takes that role and any other column with it gives it up.
 * With no heading under it, the span is a column of its own.
 */
export function applyTaught(cells, taught) {
  const cols = cells.map((c) => ({ ...c }));
  for (const t of taughtSpans(taught)) {
    const hit = columnFor(t, cols, 25);
    const owed = taught.openItems === true ? 'outstanding' : taught.openItems === false ? 'balance'
      : OWED_ROLES.includes(hit?.role) ? hit.role : 'balance';
    const role = t.role === 'ref' ? 'doc' : t.role === 'amount' ? 'amount' : owed;
    for (const c of cols) {
      if (c === hit || c.role == null) continue;
      if (role === 'doc' && c.role === 'doc') c.role = 'other';
      else if (role === 'amount' && c.role === 'amount') c.role = null;
      else if (OWED_ROLES.includes(role) && OWED_ROLES.includes(c.role)) c.role = null;
    }
    if (hit) Object.assign(hit, { role, taught: true });
    else cols.push({ label: t.label, x0: t.x0, x1: t.x1, role, taught: true, box: null });
  }
  return cols.sort((a, b) => a.x0 - b.x0);
}

/**
 * One row under the headings, read column by column.
 * @returns {{line?: object, unread?: boolean}}
 */
function lineFromRow(row, columns, reach) {
  const byCol = new Map();
  const loose = [];
  for (const w of rowWords(row)) {
    const c = columnFor(w, columns, reach);
    if (!c) loose.push(w);
    else if (byCol.has(c)) byCol.get(c).push(w);
    else byCol.set(c, [w]);
  }
  const textIn = (c) => wordsText(byCol.get(c) || []);
  const ofRole = (...roles) => columns.filter((c) => roles.includes(c.role));
  const moneyIn = (role) => {
    for (const c of ofRole(role)) {
      const t = textIn(c);
      const m = t ? findMoney(t) : [];
      if (m.length) return m;
    }
    return null;
  };
  const raw = rowText(row);
  const looseText = wordsText(loose);

  // The date from the Date column; with none, from anything that isn't a due date or an amount
  const dateCols = ofRole('date');
  const dates = (dateCols.length ? dateCols : columns.filter((c) => c.role !== 'due' && !MONEY_ROLES.includes(c.role)))
    .flatMap((c) => findDates(textIn(c)));
  if (!dateCols.length) dates.push(...findDates(looseText));

  // The amount from the amount column (a credit column's is negative). With
  // neither, the outstanding figure is the line's amount.
  let amount = null;
  let fromOwed = false;
  const debit = moneyIn('amount');
  const credit = debit ? null : moneyIn('credit');
  if (debit) amount = debit[0].value;
  else if (credit) amount = -Math.abs(credit[0].value);
  else if (!ofRole('amount', 'credit').length) {
    const o = moneyIn('outstanding') || moneyIn('balance');
    if (o) { amount = o[0].value; fromOwed = true; }
  }
  const owed = moneyIn('balance') || moneyIn('outstanding');
  const balance = owed && !fromOwed ? owed.at(-1).value : null;

  const refsIn = (cols) => cols.flatMap((c) => { const t = textIn(c); return t ? findRefs(t) : []; });
  const docRefs = refsIn(ofRole('doc'));
  const code = refsIn(ofRole('code'))[0] ?? null;
  const refs = refsIn(columns.filter((c) => REF_ROLES.includes(c.role)));
  if (!docRefs.length) {
    // Nothing under the reference heading: a reference in the details (a payment's) still counts
    refs.push(...refsIn(columns.filter((c) => !REF_ROLES.includes(c.role) && !MONEY_ROLES.includes(c.role) && c.role !== 'date' && c.role !== 'due')));
    refs.push(...findRefs(looseText));
  }

  if (amount == null) return { unread: dates.length > 0 && findMoney(raw).length > 0 };
  if (!refs.length && !dates.length) return {}; // a totals row
  let kind = lineKind(raw);
  if (kind === 'invoice' && amount < 0) kind = 'credit';
  const notCode = (r) => !code || normRef(r) !== normRef(code);
  const ref = docRefs[0] ?? refs.find(notCode) ?? refs[0] ?? null;
  return {
    line: {
      raw: slimRaw(raw),
      kind,
      date: dates[0]?.value ?? null,
      ref,
      prefix: code && normRef(code) !== normRef(ref) ? code : null,
      byColumn: docRefs.length > 0,
      refs,
      amount,
      balance,
      box: rowBox(row),
    },
  };
}

/** A column as kept on the reading, for the entry screen. */
const slimColumn = (c, page) => ({
  role: c.role,
  label: c.label || null,
  taught: Boolean(c.taught),
  box: c.box ? plainBox(c.box) : { page, x: r1(c.x0), y: null, w: r1(c.x1 - c.x0), h: null },
});

/**
 * Read a statement from the PDF's positioned text, column by column.
 * @param {Array} items  {str, x, y, w, h, page}, as extractItems gives them
 * @param {object} [opts] { taught } the supplier's taught layout (SupplierLayout.statement)
 * @returns {object|null} what parseStatement returns, plus `columns`,
 *   `source: 'positions'` and a `box` on each line; null with no heading row
 *   to go by and nothing taught
 */
export function parseStatementItems(items, { taught = null } = {}) {
  if (!items?.length) return null;
  const rows = groupRows(items);
  const headings = new Map(rows.map((r) => [r, headingColumns(r)]).filter(([, h]) => h));
  const headedPages = new Set([...headings.keys()].map((r) => r.page));
  const spans = taughtSpans(taught);
  let columns = null;
  let reach = HEADING_REACH;
  let first = null;
  let page = null;
  const lines = [];
  let unread = 0;

  for (const row of rows) {
    if (row.page !== page) {
      page = row.page;
      // A page that prints its own headings is read from below them; one
      // that doesn't carries on with the last page's columns
      if (headedPages.has(page)) columns = null;
      else if (!columns && spans.length) { columns = applyTaught([], taught); reach = TAUGHT_REACH; }
      if (columns && !first) first = { columns, page };
    }
    const heading = headings.get(row);
    if (heading) {
      columns = applyTaught(heading, taught);
      reach = HEADING_REACH;
      first ||= { columns, page };
      continue;
    }
    if (!columns) continue;
    const got = lineFromRow(row, columns, reach);
    if (got.unread) unread += 1;
    if (!got.line) continue;
    if (lines.length >= MAX_LINES) { unread += 1; continue; }
    lines.push(got.line);
  }
  if (!first) return null;

  pickRepeatedCode(lines);
  // The header figures (statement date, balance, payments) from the same text, row by row
  const { header } = parseStatement(rows.map(rowText).join('\n'));
  if (header.periodSource === 'lines') { header.periodStart = null; header.periodEnd = null; delete header.periodSource; }
  periodFromLines(header, lines);
  const roles = first.columns.map((c) => c.role);
  if (typeof taught?.openItems === 'boolean') header.openItems = taught.openItems;
  else if (roles.includes('balance')) header.openItems = false;
  else if (roles.includes('outstanding')) header.openItems = true;
  if (!header.openItems) delete header.openItems;
  return {
    header,
    lines,
    unread,
    hasText: true,
    source: 'positions',
    columns: first.columns.filter((c) => c.role).map((c) => slimColumn(c, first.page)),
  };
}

/** Give the text reader's lines the box of the PDF row each was read from, where one matches. */
export function boxLines(lines, items) {
  if (!items?.length) return lines;
  const rows = groupRows(items).map((r) => ({ text: rowText(r), row: r }));
  for (const l of lines) {
    const key = String(l.raw || '').replace(/…$/, '');
    const hit = key && rows.find((r) => r.text.startsWith(key));
    if (hit) l.box = rowBox(hit.row);
  }
  return lines;
}

/**
 * Read a statement document: by position when the PDF has a text layer and a
 * heading row (or a taught layout) that gives lines, otherwise from the OCR text.
 * @param {{text?: string, items?: Array, taught?: object}} doc
 */
export function parseStatementDocument({ text = '', items = [], taught = null } = {}) {
  const byPosition = parseStatementItems(items, { taught });
  if (byPosition?.lines.length) return byPosition;
  const parsed = parseStatement(text);
  boxLines(parsed.lines, items);
  return { ...parsed, source: 'text', columns: byPosition?.columns || [] };
}

// ── Reconciling ──────────────────────────────────────────────────────

const toIso = (d) => {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};
const daysApart = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000; // ISO dates, so UTC
const sameMoney = (a, b) => a != null && b != null && Math.abs(Math.abs(a) - Math.abs(b)) < 0.011;
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * What was still owed on a purchase at a date (or now, with no date). The sync
 * leaves DueAmount at 0 on unpaid purchases, so this is gross minus paid, with
 * anything paid after the date added back: a statement shows what was owed on
 * its own date, not what's owed today.
 */
export function stillOwed(p, upTo = null) {
  if (p.Status === 'Cancelled') return 0;
  const now = p.Status === 'Paid' ? 0 : (Number(p.GrossAmount) || 0) - (Number(p.TotalPaidAmount) || 0);
  const paidSince = upTo
    ? (p.PaymentLines || []).filter((pl) => { const d = toIso(pl.Date || pl.PayDate); return d && d > upTo; })
      .reduce((s, pl) => s + Math.abs(Number(pl.Amount) || 0), 0)
    : 0;
  return round2(now + paidSince);
}

/** The purchase as kept on the reading: enough to show and link, nothing more. */
export const slimPurchase = (p) => ({
  uuid: p.uuid || null,
  number: p.Number ?? null,
  reference: p.SupplierReference || null,
  date: toIso(p.IssuedDate),
  gross: p.GrossAmount ?? null,
  paid: p.TotalPaidAmount ?? null,
  due: stillOwed(p),
  status: p.Status || null,
});

const MIN_PARTIAL = 5;
/** Does a reference end with `part` (normalised) after a separator? "1601/02108768" ends with "02108768". */
const endsAfterSeparator = (whole, part) => {
  const segs = String(whole || '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  for (let k = 1; k < segs.length; k += 1) if (normRef(segs.slice(-k).join('')) === part) return true;
  return false;
};

/**
 * How well statement reference `a` stands for purchase reference `b`:
 * 3 the same once normalised; 2 one is the other's tail after a separator
 * ("1601/02108768" and "02108768", either way round); 1 one is inside the
 * other; 0 no match. Partial matches need MIN_PARTIAL characters.
 */
export function refMatchScore(a, b) {
  const x = normRef(a);
  const y = normRef(b);
  if (!x || !y) return 0;
  if (x === y) return 3;
  const shorter = x.length < y.length ? x : y;
  const longer = shorter === x ? y : x;
  if (shorter.length < MIN_PARTIAL) return 0;
  if (endsAfterSeparator(shorter === x ? b : a, shorter)) return 2;
  return longer.includes(shorter) ? 1 : 0;
}

/** Does statement reference `a` stand for purchase reference `b`? */
export const refsMatch = (a, b) => refMatchScore(a, b) > 0;

/**
 * The references a statement line can be matched by: each one printed, except
 * a branch or account code on its own, plus neighbours joined ("1601" and
 * "02108768" printed in separate columns answer "1601/02108768").
 */
const lineRefs = (l) => {
  const code = normRef(l.prefix);
  const single = (l.refs || []).filter((r) => !code || normRef(r) !== code);
  const joined = [];
  if (l.prefix && l.ref) joined.push(`${l.prefix}/${l.ref}`);
  for (let i = 0; i + 1 < (l.refs || []).length; i += 1) joined.push(`${l.refs[i]}/${l.refs[i + 1]}`);
  return { single, joined };
};
/** The best score a line's references get against a purchase reference. A joined pair counts only when exact. */
const lineScore = (l, ref) => {
  const { single, joined } = lineRefs(l);
  if (joined.some((r) => normRef(r) === normRef(ref))) return 3;
  return Math.max(0, ...single.map((r) => refMatchScore(r, ref)));
};

/**
 * Set the statement's lines against the supplier's purchases.
 *
 * Pass 1 matches on the supplier's reference (what KashFlow holds in
 * SupplierReference). Lines sharing a reference that only one purchase answers
 * are one invoice printed in parts, so their sum is what's compared. Pass 2
 * matches what's left on amount and a date within DATE_TOLERANCE_DAYS. Each
 * purchase matches once.
 *
 * @param {{header, lines}} parsed  from parseStatement
 * @param {Array} purchases         REST purchases for this supplier
 * @returns {object} reconciliation, as stored on OcrDocument.statement.reconciliation
 */
export function reconcile(parsed, purchases = [], { toleranceDays = DATE_TOLERANCE_DAYS } = {}) {
  const { header, lines } = parsed;
  const pool = purchases.map((p) => ({ p, ref: normRef(p.SupplierReference), gross: p.GrossAmount, date: toIso(p.IssuedDate), used: false }));
  const matched = [];
  const onStatementOnly = [];
  const candidates = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.kind === 'invoice' || l.kind === 'credit');

  // Pass 1: by reference, the closest matches first (the same reference,
  // then one ending with the other, then one inside the other), so a loose
  // match never takes a purchase another line names exactly
  const done = new Set();
  const lineKey = (l) => `${normRef(l.prefix)}|${normRef(l.ref)}`;
  for (const tier of [3, 2, 1]) {
    for (const c of candidates) {
      if (done.has(c.i) || !c.l.refs.length) continue;
      const hits = pool.filter((x) => !x.used && x.ref && lineScore(c.l, x.ref) === tier);
      if (!hits.length) continue;
      done.add(c.i);
      // Lines sharing a document reference that one purchase answers are one
      // invoice printed in parts, but only when that shared reference is
      // itself what matched: a branch code on every line is not one invoice
      const parts = c.l.ref ? candidates.filter((o) => (o.i === c.i || !done.has(o.i)) && o.l.kind === c.l.kind && lineKey(o.l) === lineKey(c.l)) : [c];
      const shared = hits.length === 1 && (refMatchScore(c.l.ref, hits[0].ref) >= 2
        || (c.l.prefix && normRef(`${c.l.prefix}${c.l.ref}`) === hits[0].ref));
      if (parts.length > 1 && shared) {
        const [only] = hits;
        only.used = true;
        const partsTotal = round2(parts.reduce((s, o) => s + o.l.amount, 0));
        const purchase = slimPurchase(only.p);
        for (const o of parts) {
          done.add(o.i);
          matched.push({ line: o.i, by: 'reference', amountAgrees: sameMoney(partsTotal, only.gross), parts: parts.length, partsTotal, purchase });
        }
        continue;
      }
      const [hit] = hits;
      hit.used = true;
      matched.push({ line: c.i, by: 'reference', amountAgrees: sameMoney(c.l.amount, hit.gross), purchase: slimPurchase(hit.p) });
    }
  }
  const left = candidates.filter((c) => !done.has(c.i));
  // Pass 2: by amount and date
  for (const c of left) {
    const sameAmount = pool.filter((x) => !x.used && sameMoney(x.gross, c.l.amount));
    const hit = c.l.date
      ? sameAmount.filter((x) => x.date && daysApart(x.date, c.l.date) <= toleranceDays).sort((a, b) => daysApart(a.date, c.l.date) - daysApart(b.date, c.l.date))[0]
      : (sameAmount.length === 1 ? sameAmount[0] : null);
    if (hit) {
      hit.used = true;
      matched.push({ line: c.i, by: 'amount', amountAgrees: true, purchase: slimPurchase(hit.p) });
    } else onStatementOnly.push(c.i);
  }

  // Pass 3: a payment line that is itself a purchase paid in full that day
  // (a prepaid account's top-ups are entered as purchases), so it isn't
  // listed as missing from the statement
  for (const [i, l] of lines.entries()) {
    if (l.kind !== 'payment' || !l.date) continue;
    const hit = pool.filter((x) => !x.used && sameMoney(x.gross, l.amount) && x.date && daysApart(x.date, l.date) <= toleranceDays)
      .sort((a, b) => daysApart(a.date, l.date) - daysApart(b.date, l.date))[0];
    if (hit) {
      hit.used = true;
      matched.push({ line: i, by: 'payment', amountAgrees: true, purchase: slimPurchase(hit.p) });
    }
  }

  matched.sort((a, b) => a.line - b.line);

  // Purchases the statement doesn't list: inside its period when one is
  // printed; otherwise anything still unpaid in KashFlow up to the statement
  // date, since a statement of account lists what's outstanding
  const { periodStart, periodEnd } = header;
  const upTo = periodEnd || header.statementDate || null;
  const inKashflowOnly = (periodStart && periodEnd && header.periodSource === 'printed'
    ? pool.filter((x) => !x.used && x.date && x.date >= periodStart && x.date <= periodEnd)
    : pool.filter((x) => !x.used && stillOwed(x.p, upTo) > 0.005 && (!upTo || (x.date && x.date <= upTo)))
  ).map((x) => slimPurchase(x.p));

  // Payments: what the statement says it received against KashFlow's payment lines in the period.
  // A statement that prints no period and starts from nothing doesn't cover what
  // was already settled, so payments on purchases older than its first line aren't
  // on it. Anything brought forward means they could be, so they all count.
  const paymentLinesOnStatement = lines.filter((l) => l.kind === 'payment');
  const statementPayments = header.paymentsTotal ?? (paymentLinesOnStatement.length
    ? round2(paymentLinesOnStatement.reduce((s, l) => s + Math.abs(l.amount), 0))
    : null);
  const first = lines[0];
  // On an open-item statement the last figure is the line's outstanding amount, not a running balance
  const broughtForward = Boolean(header.openingBalance) || (!header.openItems && first?.balance != null && !sameMoney(first.balance, first.amount));
  const coveredByStatement = (p) => {
    if (header.periodSource !== 'lines' || broughtForward) return true;
    const issued = toIso(p.IssuedDate);
    return Boolean(issued) && issued >= periodStart;
  };
  const kashflowPayments = periodStart && periodEnd
    ? round2(purchases.filter(coveredByStatement).flatMap((p) => p.PaymentLines || [])
      .filter((pl) => { const d = toIso(pl.Date || pl.PayDate); return d && d >= periodStart && d <= periodEnd; })
      .reduce((s, pl) => s + Math.abs(Number(pl.Amount) || 0), 0))
    : null;

  // Balance: what the statement says is owed against what KashFlow had outstanding up to the period end
  const kashflowOutstanding = upTo
    ? round2(purchases.filter((p) => { const d = toIso(p.IssuedDate); return d && d <= upTo; })
      .reduce((s, p) => s + stillOwed(p, upTo), 0))
    : null;

  // A purchase printed in parts is one difference, however many lines it took
  const amountDiffers = new Set(matched.filter((m) => !m.amountAgrees).map((m) => m.purchase)).size;
  const differences = onStatementOnly.length + inKashflowOnly.length + amountDiffers;
  // An open-item statement leaves out settled invoices and their payments, so
  // its payments can't be set against KashFlow's; the balance check is the one that counts
  const payments = header.openItems
    ? { statement: statementPayments, kashflow: kashflowPayments, agree: null, openItems: true }
    : { statement: statementPayments, kashflow: kashflowPayments, agree: statementPayments != null && kashflowPayments != null ? sameMoney(statementPayments, kashflowPayments) : null };
  const balance = { statement: header.closingBalance, kashflow: kashflowOutstanding, agree: header.closingBalance != null && kashflowOutstanding != null ? sameMoney(header.closingBalance, kashflowOutstanding) : null };

  return {
    period: { start: periodStart || null, end: periodEnd || null, source: header.periodSource || null },
    matched,
    onStatementOnly,
    inKashflowOnly,
    payments,
    balance,
    summary: {
      lines: candidates.length,
      matched: matched.filter((m) => m.by !== 'payment').length,
      paymentsMatched: matched.filter((m) => m.by === 'payment').length,
      onStatementOnly: onStatementOnly.length,
      inKashflowOnly: inKashflowOnly.length,
      amountDiffers,
      differences,
      status: !candidates.length && !paymentLinesOnStatement.length ? 'no-lines' : differences === 0 && payments.agree !== false ? 'reconciled' : 'differences',
    },
  };
}

/** One line of English for the queue and the history, from a stored reading. */
export function summaryText(statement) {
  if (!statement) return null;
  if (statement.error) return `Couldn't read: ${statement.error}`;
  if (!statement.hasText) return 'No text to read';
  if (!statement.supplier) return 'No KashFlow supplier for this correspondent';
  const s = statement.reconciliation?.summary;
  if (!s) return null;
  if (s.status === 'no-lines') return 'No invoice lines read';
  const parts = [`${s.matched} matched`];
  if (s.onStatementOnly) parts.push(`${s.onStatementOnly} on statement only`);
  if (s.inKashflowOnly) parts.push(`${s.inKashflowOnly} in KashFlow only`);
  if (s.amountDiffers) parts.push(`${s.amountDiffers} amount differs`);
  const pay = statement.reconciliation?.payments;
  if (pay?.agree === false) parts.push('payments differ');
  return parts.join(', ');
}

// ── Running it ───────────────────────────────────────────────────────

const defaultDeps = () => ({
  connect: () => mdb.connect(),
  models: () => ({
    OcrDocument: mdb.PAPERLESS?.OcrDocument,
    DocumentText: mdb.PAPERLESS?.DocumentText,
    SupplierLayout: mdb.PAPERLESS?.SupplierLayout,
    Supplier: mdb.REST?.supplier,
    Purchase: mdb.REST?.purchase,
  }),
  fetchPdf: async (paperlessId) => {
    const file = await __paperlessClient.makeClient().getDocumentFile(paperlessId);
    const chunks = [];
    for await (const c of file.stream) chunks.push(c);
    return Buffer.concat(chunks);
  },
  extract: extractItems,
  now: () => new Date(),
});
const withDeps = (deps) => {
  const d = { ...defaultDeps(), ...deps };
  return { ...d, m: { ...defaultDeps().models(), ...(deps.models ? deps.models() : {}) } };
};

const PURCHASE_FIELDS = 'uuid Id Number SupplierReference IssuedDate GrossAmount TotalPaidAmount DueAmount Status PaymentLines.Date PaymentLines.PayDate PaymentLines.Amount';

/** Every purchase for a supplier, newest first. */
export async function purchasesFor(Purchase, supplier) {
  if (!Purchase || !supplier) return [];
  const who = { $or: [{ SupplierId: supplier.Id }, { SupplierCode: supplier.Code }, { SupplierName: supplier.Name }].filter((c) => Object.values(c)[0] != null) };
  return Purchase.find(who).select(PURCHASE_FIELDS).sort({ IssuedDate: -1 }).limit(MAX_PURCHASES).lean();
}

/**
 * The PDF's positioned text, as stored in DocumentText (shared with the
 * invoice reader), fetched from Paperless and stored the first time. Empty
 * when there's no text layer or the PDF can't be had: the OCR text is read instead.
 */
async function itemsFor(d, paperlessId, { refetch = false } = {}) {
  const { DocumentText } = d.m;
  if (!DocumentText) return [];
  let stored = refetch ? null : await DocumentText.findOne({ paperlessId }).lean();
  if (!stored && d.fetchPdf && d.extract) {
    try {
      const { items, pages, pageWidth } = await d.extract(await d.fetchPdf(paperlessId), { maxPages: STATEMENT_MAX_PAGES });
      stored = { paperlessId, items: items.map(packItem), pages, pageWidth };
      await DocumentText.updateOne({ paperlessId }, { $set: { ...stored, readAt: d.now(), readerVersion: READER_VERSION } }, { upsert: true });
    } catch (err) {
      logger.warn(`[statementReading] ${paperlessId}: no PDF text (${err.message}), reading the OCR text`);
      return [];
    }
  }
  return (stored?.items || []).map(unpackItem);
}

/** What someone pointed out on this supplier's statements (SupplierLayout.statement), or null. */
async function taughtFor(SupplierLayout, doc) {
  if (!SupplierLayout || doc?.correspondent?.id == null) return null;
  const l = await SupplierLayout.findOne({ correspondentId: doc.correspondent.id }).select('statement').lean();
  const t = l?.statement;
  return t && (Object.keys(t.columns || {}).length || typeof t.openItems === 'boolean') ? t : null;
}

/**
 * Read one statement and set it against KashFlow; store the result on the
 * document. Read by column from the PDF when it has a text layer, else from
 * the OCR text. Not a statement, or not found: null. A failure is stored as
 * `error`, never thrown.
 * @returns {Promise<object|null>} the stored `statement`
 */
export async function readStatement(paperlessId, deps = {}) {
  const d = withDeps(deps);
  if (d.connect) await d.connect();
  const { OcrDocument, Supplier, Purchase, SupplierLayout } = d.m;
  const doc = await OcrDocument.findOne({ paperlessId }).select('paperlessId correspondent documentType ocrText').lean();
  if (!doc || !isDocumentType(doc.documentType, 'supplierStatement')) return null;
  const now = d.now();
  let statement;
  try {
    const items = await itemsFor(d, paperlessId, { refetch: Boolean(deps.refetch) });
    const taught = await taughtFor(SupplierLayout, doc);
    const parsed = parseStatementDocument({ text: doc.ocrText, items, taught });
    const supplier = await supplierFor(Supplier, doc.correspondent?.name);
    const purchases = supplier ? await purchasesFor(Purchase, supplier) : [];
    statement = {
      version: STATEMENT_READER_VERSION,
      at: now,
      hasText: parsed.hasText,
      source: parsed.source,
      columns: parsed.columns,
      taught: Boolean(taught),
      openItemsTaught: typeof taught?.openItems === 'boolean' ? taught.openItems : null,
      supplier: supplier ? { id: supplier.Id ?? null, code: supplier.Code || null, name: supplier.Name || null } : null,
      header: parsed.header,
      lines: parsed.lines,
      lineCount: parsed.lines.length,
      unread: parsed.unread,
      purchaseCount: purchases.length,
      reconciliation: supplier ? reconcile(parsed, purchases) : null,
    };
  } catch (err) {
    logger.warn(`[statementReading] ${paperlessId}: ${err.message}`);
    statement = { version: STATEMENT_READER_VERSION, at: now, error: err.message };
  }
  statement.summaryText = summaryText(statement);
  await OcrDocument.updateOne({ paperlessId }, { $set: { statement } });
  return statement;
}

// ── Teaching a supplier's statement layout ───────────────────────────

const validSpan = (b) => !!b && [b.x, b.w].every((n) => Number.isFinite(Number(n)))
  && Number(b.w) > 0 && Number(b.x) >= 0 && Number(b.x) + Number(b.w) <= 5000
  && (b.page == null || (Number.isInteger(Number(b.page)) && Number(b.page) >= 1));
const r1n = (n) => Math.round(Number(n) * 10) / 10;

/**
 * Apply one change to a supplier's statement layout:
 *   { role, box, label }  this is the reference / amount / outstanding-or-balance column
 *   { openItems }         open items (true), running balance (false), or let the reader guess (null)
 *   { forget: true }      forget it all
 * @returns {{ok: boolean, message?: string, statement?: object}} the layout to store
 */
export function changeLayout(current, change, now = new Date()) {
  if (change?.forget) return { ok: true, statement: { columns: {}, openItems: null, updatedAt: now } };
  const next = { columns: { ...(current?.columns || {}) }, openItems: typeof current?.openItems === 'boolean' ? current.openItems : null };
  if (change && 'openItems' in change && change.role == null) {
    if (![true, false, null].includes(change.openItems)) return { ok: false, message: 'Unknown kind of statement.' };
    return { ok: true, statement: { ...next, openItems: change.openItems, updatedAt: now } };
  }
  if (!TAUGHT_ROLES.includes(change?.role)) return { ok: false, message: 'Unknown column.' };
  if (!validSpan(change.box)) return { ok: false, message: 'That spot is not on the page.' };
  const b = change.box;
  const label = typeof change.label === 'string' ? (change.label.replace(/\s+/g, ' ').trim().slice(0, 60) || null) : null;
  next.columns[change.role] = {
    x: r1n(b.x),
    w: r1n(b.w),
    page: b.page != null ? Number(b.page) : null,
    y: Number.isFinite(Number(b.y)) ? r1n(b.y) : null,
    h: Number.isFinite(Number(b.h)) ? r1n(b.h) : null,
    label,
    at: now,
  };
  return { ok: true, statement: { ...next, updatedAt: now } };
}

/**
 * Teach the reader about a statement's supplier from the statement itself
 * (the entry screen), then read the statement again with it.
 * @returns {Promise<{ok: boolean, message?: string, statement?: object, reading?: object}>}
 */
export async function teachLayout(paperlessId, change, deps = {}) {
  const d = withDeps(deps);
  if (d.connect) await d.connect();
  const { OcrDocument, SupplierLayout } = d.m;
  const doc = await OcrDocument.findOne({ paperlessId }).select('paperlessId correspondent documentType').lean();
  if (!doc || !isDocumentType(doc.documentType, 'supplierStatement')) return { ok: false, message: 'Only supplier statements have columns to point out.' };
  if (doc.correspondent?.id == null) return { ok: false, message: 'This statement has no correspondent in Paperless, so there is no supplier to remember it for.' };
  if (!SupplierLayout) return { ok: false, message: 'Supplier layouts are not available.' };
  const id = Number(doc.correspondent.id);
  const existing = await SupplierLayout.findOne({ correspondentId: id }).lean();
  const r = changeLayout(existing?.statement, change, d.now());
  if (!r.ok) return r;
  await SupplierLayout.updateOne(
    { correspondentId: id },
    { $set: { correspondentName: doc.correspondent.name || existing?.correspondentName || null, statement: r.statement } },
    { upsert: true },
  );
  const reading = await readStatement(paperlessId, deps);
  return { ok: true, statement: r.statement, reading };
}

/** True when a document's stored reading is missing or from an older reader. */
export const needsReading = (doc) => !doc?.statement || !(doc.statement.version >= STATEMENT_READER_VERSION);

/** Read in the background; errors are logged, never thrown. */
export function readStatementSoon(paperlessId, deps = {}) {
  return readStatement(paperlessId, deps).catch((err) => {
    logger.warn(`[statementReading] ${paperlessId}: ${err.message}`);
    return null;
  });
}

/** Statements waiting for review that have no reading, or an old one. For the scheduled job. */
export async function readMissing({ limit = 20 } = {}, deps = {}) {
  const d = withDeps(deps);
  if (d.connect) await d.connect();
  const { OcrDocument } = d.m;
  const docs = await OcrDocument.find({
    $and: [
      documentTypeQuery('supplierStatement'),
      { $or: [{ statement: { $exists: false } }, { 'statement.version': { $lt: STATEMENT_READER_VERSION } }] },
    ],
    statementReviewed: { $ne: true },
    deletedInPaperlessAt: null,
  }).select('paperlessId').sort({ added: -1 }).limit(limit).lean();
  let read = 0;
  for (const { paperlessId } of docs) {
    await readStatement(paperlessId, deps);
    read += 1;
  }
  return { read };
}

export default {
  STATEMENT_READER_VERSION, DATE_TOLERANCE_DAYS,
  findDates, findMoney, findRefs, lineKind, normRef, parseStatement, referenceColumns, isOpenItemHeading,
  TAUGHT_ROLES, headingRole, headingColumns, applyTaught, parseStatementItems, parseStatementDocument, boxLines,
  changeLayout, teachLayout,
  refsMatch, refMatchScore, reconcile, slimPurchase, stillOwed, summaryText,
  purchasesFor, readStatement, readStatementSoon, readMissing, needsReading,
};
