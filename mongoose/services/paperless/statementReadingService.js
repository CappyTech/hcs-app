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
import { supplierFor } from './documentReadingService.js';

// Bump when the parser or matcher changes enough that stored readings should be redone
export const STATEMENT_READER_VERSION = 1;
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
export function findMoney(line) {
  const out = [];
  for (const m of String(line || '').matchAll(MONEY_RE)) {
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
const CREDIT_WORDS = /\b(credit|cr note|c\/n|refund)\b/i;
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

/**
 * Read the OCR text of a statement.
 * @param {string} text
 * @returns {{header: object, lines: Array, unread: number, hasText: boolean}}
 *   header: { statementDate, periodStart, periodEnd, closingBalance, paymentsTotal }
 *   lines:  [{ raw, kind, date, ref, refs, amount, balance }], amount signed as printed
 *   unread: lines with a date or an amount that couldn't be read as a statement line
 */
export function parseStatement(text) {
  const rows = String(text || '').split(/\r?\n/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const header = { statementDate: null, periodStart: null, periodEnd: null, closingBalance: null, paymentsTotal: null };
  const lines = [];
  let unread = 0;

  for (const raw of rows) {
    const dates = findDates(raw);
    const money = findMoney(raw);
    const lower = raw.toLowerCase();

    // Header figures. The first mention wins; a statement repeats its header on every page.
    if (header.statementDate == null && /statement\s*(date|of account)?\b/.test(lower) && dates.length && !money.length) {
      header.statementDate = dates[0].value;
    }
    if (header.periodStart == null && /\b(period|from)\b/.test(lower) && dates.length >= 2) {
      header.periodStart = dates[0].value;
      header.periodEnd = dates[1].value;
      continue;
    }
    if (header.closingBalance == null && /\b(closing balance|balance due|amount due|total due|total outstanding|balance outstanding|amount outstanding|balance now due)\b/.test(lower) && money.length) {
      header.closingBalance = money.at(-1).value;
      continue;
    }
    if (header.paymentsTotal == null && /^(total )?(payments?|receipts?)( received)?\b/.test(lower) && money.length && !dates.length) {
      header.paymentsTotal = Math.abs(money.at(-1).value);
      continue;
    }

    if (!money.length) {
      // A date with nothing to it (a page header, a due date column) isn't a line
      continue;
    }
    const refs = findRefs(raw, { dates, money });
    const kind = lineKind(raw);
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
    lines.push({
      raw: slimRaw(raw),
      kind,
      date: dates[0]?.value ?? null,
      ref: refs[0] ?? null,
      refs,
      amount: money[0].value,
      balance: money.length > 1 ? money.at(-1).value : null,
    });
  }

  // No period printed: take it from the dated lines
  const dated = lines.map((l) => l.date).filter(Boolean).sort();
  if (!header.periodStart && dated.length) {
    header.periodStart = dated[0];
    header.periodEnd = header.statementDate && header.statementDate > dated.at(-1) ? header.statementDate : dated.at(-1);
    header.periodSource = 'lines';
  } else if (header.periodStart) {
    header.periodSource = 'printed';
  }
  return { header, lines, unread, hasText: rows.length > 0 };
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

/** The purchase as kept on the reading: enough to show and link, nothing more. */
export const slimPurchase = (p) => ({
  uuid: p.uuid || null,
  number: p.Number ?? null,
  reference: p.SupplierReference || null,
  date: toIso(p.IssuedDate),
  gross: p.GrossAmount ?? null,
  paid: p.TotalPaidAmount ?? null,
  due: p.DueAmount ?? null,
  status: p.Status || null,
});

/** Does statement reference `a` stand for purchase reference `b`? Exact once normalised, or one inside the other when long enough. */
export function refsMatch(a, b) {
  const x = normRef(a);
  const y = normRef(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const shorter = x.length < y.length ? x : y;
  const longer = shorter === x ? y : x;
  return shorter.length >= 5 && longer.includes(shorter);
}

/**
 * Set the statement's lines against the supplier's purchases.
 *
 * Pass 1 matches on the supplier's reference (what KashFlow holds in
 * SupplierReference). Pass 2 matches what's left on amount and a date within
 * DATE_TOLERANCE_DAYS. Each purchase matches once.
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

  // Pass 1: by reference
  const left = [];
  for (const c of candidates) {
    const hit = c.l.refs.length
      ? pool.find((x) => !x.used && x.ref && c.l.refs.some((r) => refsMatch(r, x.ref)))
      : null;
    if (hit) {
      hit.used = true;
      matched.push({ line: c.i, by: 'reference', amountAgrees: sameMoney(c.l.amount, hit.gross), purchase: slimPurchase(hit.p) });
    } else left.push(c);
  }
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

  // Purchases the statement doesn't list: inside its period when one is
  // printed; otherwise anything still unpaid in KashFlow up to the statement
  // date, since a statement of account lists what's outstanding
  const { periodStart, periodEnd } = header;
  const upTo = periodEnd || header.statementDate || null;
  const inKashflowOnly = (periodStart && periodEnd && header.periodSource === 'printed'
    ? pool.filter((x) => !x.used && x.date && x.date >= periodStart && x.date <= periodEnd)
    : pool.filter((x) => !x.used && (Number(x.p.DueAmount) || 0) > 0.005 && (!upTo || (x.date && x.date <= upTo)))
  ).map((x) => slimPurchase(x.p));

  // Payments: what the statement says it received against KashFlow's payment lines in the period
  const paymentLinesOnStatement = lines.filter((l) => l.kind === 'payment');
  const statementPayments = header.paymentsTotal ?? (paymentLinesOnStatement.length
    ? round2(paymentLinesOnStatement.reduce((s, l) => s + Math.abs(l.amount), 0))
    : null);
  const kashflowPayments = periodStart && periodEnd
    ? round2(purchases.flatMap((p) => p.PaymentLines || [])
      .filter((pl) => { const d = toIso(pl.Date || pl.PayDate); return d && d >= periodStart && d <= periodEnd; })
      .reduce((s, pl) => s + Math.abs(Number(pl.Amount) || 0), 0))
    : null;

  // Balance: what the statement says is owed against what KashFlow has outstanding up to the period end
  const kashflowOutstanding = upTo
    ? round2(purchases.filter((p) => { const d = toIso(p.IssuedDate); return d && d <= upTo; })
      .reduce((s, p) => s + (Number(p.DueAmount) || 0), 0))
    : null;

  const differences = onStatementOnly.length + inKashflowOnly.length + matched.filter((m) => !m.amountAgrees).length;
  const payments = { statement: statementPayments, kashflow: kashflowPayments, agree: statementPayments != null && kashflowPayments != null ? sameMoney(statementPayments, kashflowPayments) : null };
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
      amountDiffers: matched.filter((m) => !m.amountAgrees).length,
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
    Supplier: mdb.REST?.supplier,
    Purchase: mdb.REST?.purchase,
  }),
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
 * Read one statement and set it against KashFlow; store the result on the
 * document. Not a statement, or not found: null. A failure is stored as
 * `error`, never thrown.
 * @returns {Promise<object|null>} the stored `statement`
 */
export async function readStatement(paperlessId, deps = {}) {
  const d = withDeps(deps);
  if (d.connect) await d.connect();
  const { OcrDocument, Supplier, Purchase } = d.m;
  const doc = await OcrDocument.findOne({ paperlessId }).select('paperlessId correspondent documentType ocrText').lean();
  if (!doc || !isDocumentType(doc.documentType, 'supplierStatement')) return null;
  const now = d.now();
  let statement;
  try {
    const parsed = parseStatement(doc.ocrText);
    const supplier = await supplierFor(Supplier, doc.correspondent?.name);
    const purchases = supplier ? await purchasesFor(Purchase, supplier) : [];
    statement = {
      version: STATEMENT_READER_VERSION,
      at: now,
      hasText: parsed.hasText,
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
  findDates, findMoney, findRefs, lineKind, normRef, parseStatement,
  refsMatch, reconcile, slimPurchase, summaryText,
  purchasesFor, readStatement, readStatementSoon, readMissing, needsReading,
};
