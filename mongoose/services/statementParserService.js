import crypto from 'crypto';

/**
 * Turns a bank statement into lines, from either OCR text or a CSV/OFX export.
 *
 * Pure: no database, no network, no Paperless. Everything here is text in,
 * structured data out, so it is testable against fixtures.
 *
 * The governing problem is that OCR is not trustworthy for money. A transposed
 * digit produces a perfectly plausible line that silently corrupts a
 * reconciliation. The defence is the running-balance column every UK statement
 * carries: if balance[n-1] + amount[n] does not equal balance[n] all the way
 * down, the parse is wrong and none of its lines are trusted. That check is
 * why OCR is usable here at all, and it is the one thing in this file that
 * must never be softened into a warning.
 */

/* ── money ─────────────────────────────────────────────────────────── */

/**
 * Money is handled in integer pence throughout. Floating point cannot
 * represent 0.1, so a chain of additions down a statement accumulates error
 * and a correct statement eventually fails its own balance check.
 */
export function toPence(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Math.round(value * 100);

  // Paperless returns a 'monetary' custom field as a string carrying an
  // ISO 4217 prefix, e.g. "GBP1234.56". Stripped before the symbol pass, or
  // the letters survive and the value is rejected as unparseable.
  let cleaned = String(value).replace(/^\s*[A-Z]{3}(?=[\d\-(.])/i, '');
  cleaned = cleaned.replace(/[£$€,\s]/g, '').trim();

  // Trailing CR/DR markers. Stripped before the sign is applied, so the minus
  // lands at the front where Number() can see it rather than being appended.
  let negative = false;
  const marker = cleaned.match(/(CR|DR)$/i);
  if (marker) {
    negative = marker[1].toUpperCase() === 'DR';
    cleaned = cleaned.slice(0, -2);
  }

  // (1,234.56) is accountancy notation for a negative.
  const bracketed = cleaned.match(/^\((.*)\)$/);
  if (bracketed) {
    negative = true;
    cleaned = bracketed[1];
  }

  if (!cleaned || !/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;

  const pence = Math.round(Math.abs(n) * 100);
  return (negative || n < 0) ? -pence : pence;
}

export const fromPence = (p) => (p == null ? null : p / 100);

/* ── dates ─────────────────────────────────────────────────────────── */

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parse a statement date.
 *
 * UK day-first ordering is assumed, because that is what every bank here
 * prints and 03/08/2026 is otherwise ambiguous. Anything unrecognised returns
 * null rather than a guess — a wrong date puts a line in the wrong period.
 */
export function parseStatementDate(value, { year = null } = {}) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const s = String(value).trim();

  // 03/08/2026, 03-08-26, 03.08.2026
  let m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    const [, d, mo, y] = m;
    const yy = y.length === 2 ? 2000 + Number(y) : Number(y);
    return buildDate(yy, Number(mo) - 1, Number(d));
  }

  // 03 Aug 2026, 3 August 26, 03Aug26
  m = s.match(/^(\d{1,2})\s*([A-Za-z]{3,})\s*(\d{2,4})?$/);
  if (m) {
    const [, d, mon, y] = m;
    const mi = MONTHS[mon.slice(0, 3).toLowerCase()];
    if (mi == null) return null;
    // Statements often omit the year on each line and print it in the header.
    const yy = y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : year;
    if (yy == null) return null;
    return buildDate(yy, mi, Number(d));
  }

  // 2026-08-03
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return buildDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]));

  // OFX: 20260803 or 20260803120000[0:GMT]
  m = s.match(/^(\d{4})(\d{2})(\d{2})/);
  if (m) return buildDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]));

  return null;
}

function buildDate(year, monthIndex, day) {
  if (!(year >= 1900 && year <= 2200)) return null;
  if (!(monthIndex >= 0 && monthIndex <= 11)) return null;
  if (!(day >= 1 && day <= 31)) return null;
  // Midday UTC: statement dates are calendar days, and midnight would shift
  // across a timezone boundary into the previous day.
  const d = new Date(Date.UTC(year, monthIndex, day, 12, 0, 0));
  // Rejects 31 February and similar, which Date would silently roll forward.
  if (d.getUTCMonth() !== monthIndex || d.getUTCDate() !== day) return null;
  return d;
}

/* ── identity ──────────────────────────────────────────────────────── */

/** Collapse whitespace and case so trivial formatting differences dedupe. */
export function normaliseDescription(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Stable identity for a statement line, unique per account.
 *
 * Excludes the running balance on purpose: a bank can reprint the same
 * transaction with a different balance if an earlier line was later amended,
 * and that must still dedupe.
 */
export function lineHash({ accountId, date, amount, description }) {
  const parts = [
    String(accountId ?? ''),
    date ? new Date(date).toISOString().slice(0, 10) : '',
    String(Math.round((Number(amount) || 0) * 100)),
    normaliseDescription(description),
  ].join('|');
  return crypto.createHash('sha256').update(parts).digest('hex').slice(0, 40);
}

/* ── balance chain ─────────────────────────────────────────────────── */

/**
 * Verify the running balance reconciles down the page.
 *
 * Works entirely in pence. Returns the first break rather than a count,
 * because the first break is where the parse went wrong — everything after it
 * is downstream noise.
 */
export function validateBalanceChain(lines, { openingBalance = null, closingBalance = null } = {}) {
  const withBalance = lines.filter(l => l.balance != null);

  // A statement with no balance column at all cannot be chain-checked. Most
  // CSV exports include one; some do not.
  if (withBalance.length < 2) {
    return {
      ok: false,
      checked: false,
      error: 'No running balance column to verify against',
    };
  }

  let previous = null;
  for (const line of lines) {
    if (line.balance == null) continue;

    if (previous != null) {
      const expected = previous + toPenceStrict(line.amount);
      const actual = toPenceStrict(line.balance);
      if (expected !== actual) {
        return {
          ok: false,
          checked: true,
          error:
            `Running balance breaks at ${formatDate(line.date)} "${line.description}": `
            + `${fromPence(previous).toFixed(2)} ${line.amount >= 0 ? '+' : '-'} `
            + `${Math.abs(line.amount).toFixed(2)} should be ${fromPence(expected).toFixed(2)}, `
            + `statement says ${fromPence(actual).toFixed(2)}`,
          atLine: line,
        };
      }
    }
    previous = toPenceStrict(line.balance);
  }

  // Header totals, when the statement prints them.
  if (openingBalance != null && closingBalance != null) {
    const movement = lines.reduce((sum, l) => sum + toPenceStrict(l.amount), 0);
    const expected = toPenceStrict(openingBalance) + movement;
    const actual = toPenceStrict(closingBalance);
    if (expected !== actual) {
      return {
        ok: false,
        checked: true,
        error:
          `Opening ${Number(openingBalance).toFixed(2)} plus movement `
          + `${fromPence(movement).toFixed(2)} is ${fromPence(expected).toFixed(2)}, `
          + `but the statement closes at ${Number(closingBalance).toFixed(2)}`,
      };
    }
  }

  return { ok: true, checked: true, error: null };
}

const toPenceStrict = (v) => Math.round((Number(v) || 0) * 100);
const formatDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '?');

/* ── CSV ───────────────────────────────────────────────────────────── */

/**
 * Minimal RFC 4180 CSV reader.
 *
 * Hand-rolled rather than adding a dependency: bank exports are plain, and the
 * only real requirement is handling quoted fields containing commas, which
 * merchant names routinely do.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const src = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }

    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }

  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

/**
 * A column mapping describes one bank's CSV layout. Saved per account so a
 * bank only has to be described once.
 *
 *   { date, description, amount }                    signed single column
 *   { date, description, paidIn, paidOut }           separate credit/debit
 *   plus optional { balance }
 *
 * Values are header names (matched case-insensitively) or zero-based indexes.
 */
export function parseCsvStatement(text, { accountId, mapping, hasHeader = true } = {}) {
  const rows = parseCsv(text);
  if (!rows.length) return { lines: [], warnings: ['The file contained no rows'] };

  const warnings = [];
  const header = hasHeader ? rows[0].map(h => String(h).trim().toLowerCase()) : null;
  const body = hasHeader ? rows.slice(1) : rows;

  const columnOf = (spec) => {
    if (spec == null) return -1;
    if (typeof spec === 'number') return spec;
    if (!header) return -1;
    return header.indexOf(String(spec).trim().toLowerCase());
  };

  const idx = {
    date: columnOf(mapping.date),
    description: columnOf(mapping.description),
    amount: columnOf(mapping.amount),
    paidIn: columnOf(mapping.paidIn),
    paidOut: columnOf(mapping.paidOut),
    balance: columnOf(mapping.balance),
  };

  if (idx.date < 0) return { lines: [], warnings: ['Could not find the date column'] };
  if (idx.amount < 0 && (idx.paidIn < 0 || idx.paidOut < 0)) {
    return { lines: [], warnings: ['Could not find an amount column, or a paid in/out pair'] };
  }

  const lines = [];
  body.forEach((row, n) => {
    const date = parseStatementDate(row[idx.date]);
    if (!date) { warnings.push(`Row ${n + 1}: unrecognised date "${row[idx.date]}"`); return; }

    let amountPence;
    if (idx.amount >= 0) {
      amountPence = toPence(row[idx.amount]);
    } else {
      // Separate columns: exactly one carries a value. Paid out is a positive
      // number in its own column and becomes negative here.
      const inP = toPence(row[idx.paidIn]) || 0;
      const outP = toPence(row[idx.paidOut]) || 0;
      amountPence = inP - outP;
    }
    if (amountPence == null) { warnings.push(`Row ${n + 1}: unrecognised amount`); return; }
    if (amountPence === 0) { warnings.push(`Row ${n + 1}: zero amount, skipped`); return; }

    const description = String(row[idx.description] ?? '').trim();
    const balancePence = idx.balance >= 0 ? toPence(row[idx.balance]) : null;

    lines.push({
      accountId,
      date,
      description,
      amount: fromPence(amountPence),
      balance: balancePence == null ? null : fromPence(balancePence),
      lineHash: lineHash({ accountId, date, amount: fromPence(amountPence), description }),
    });
  });

  return { lines, warnings };
}

/* ── OFX ───────────────────────────────────────────────────────────── */

/**
 * OFX is SGML-ish: tags are frequently unclosed, so this reads
 * <STMTTRN> blocks and takes the text following each tag up to the next one.
 * That is enough for the four fields that matter and avoids an XML parser
 * that would reject the format outright.
 */
export function parseOfxStatement(text, { accountId } = {}) {
  const warnings = [];
  const lines = [];

  const blocks = String(text).match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi)
    || String(text).split(/<STMTTRN>/i).slice(1).map(b => `<STMTTRN>${b.split(/<\/?STMTTRN>/i)[0]}`);

  if (!blocks.length) return { lines: [], warnings: ['No <STMTTRN> transactions found'] };

  const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}>([^<\\r\\n]*)`, 'i'));
    return m ? m[1].trim() : '';
  };

  blocks.forEach((block, n) => {
    const date = parseStatementDate(tag(block, 'DTPOSTED'));
    const amountPence = toPence(tag(block, 'TRNAMT'));
    if (!date) { warnings.push(`Transaction ${n + 1}: unrecognised DTPOSTED`); return; }
    if (amountPence == null) { warnings.push(`Transaction ${n + 1}: unrecognised TRNAMT`); return; }

    // NAME is the short label; MEMO usually carries the fuller narrative.
    const name = tag(block, 'NAME');
    const memo = tag(block, 'MEMO');
    const description = [name, memo].filter(Boolean).join(' ').trim();

    lines.push({
      accountId,
      date,
      description,
      amount: fromPence(amountPence),
      // OFX carries no per-transaction running balance, so the chain check
      // cannot run on an OFX import. Recorded honestly rather than faked.
      balance: null,
      lineHash: lineHash({ accountId, date, amount: fromPence(amountPence), description }),
    });
  });

  return { lines, warnings };
}

/* ── OCR ───────────────────────────────────────────────────────────── */

/**
 * Layout profiles for OCR'd statement PDFs.
 *
 * `lineRe` must capture named groups: date, description, and either amount, or
 * paidIn/paidOut, plus optionally balance. Add a profile per bank as real
 * statements arrive — guessing at layouts nobody has seen is how you get a
 * parser that is confidently wrong.
 */
export const OCR_PROFILES = {
  /**
   * The common UK layout: date, narrative, then paid-out / paid-in / balance
   * as right-aligned columns.
   *   03 Aug 26  CARD PAYMENT TO SCREWFIX      16.46            1,234.56
   */
  'uk-generic-3col': {
    label: 'UK generic (paid out / paid in / balance)',
    lineRe: new RegExp(
      String.raw`^(?<date>\d{1,2}[\s/\-.][A-Za-z]{3,}[\s/\-.]?\d{0,4}|\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})\s+`
      + String.raw`(?<description>.+?)\s+`
      + String.raw`(?<paidOut>[\d,]+\.\d{2})?\s{2,}`
      + String.raw`(?<paidIn>[\d,]+\.\d{2})?\s{2,}`
      + String.raw`(?<balance>-?[\d,]+\.\d{2})\s*$`,
    ),
  },
  /**
   * Single signed amount column plus balance.
   *   03/08/2026  DIRECT DEBIT NPOWER   -84.20   1,150.36
   */
  'uk-generic-signed': {
    label: 'UK generic (signed amount / balance)',
    lineRe: new RegExp(
      String.raw`^(?<date>\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,}\s*\d{0,4})\s+`
      + String.raw`(?<description>.+?)\s+`
      + String.raw`(?<amount>-?[\d,]+\.\d{2})\s+`
      + String.raw`(?<balance>-?[\d,]+\.\d{2})\s*$`,
    ),
  },
};

/**
 * Parse OCR text into statement lines.
 *
 * Descriptions routinely wrap onto a following line with no amount on it;
 * those continuations are rejoined onto the preceding transaction rather than
 * discarded, because the narrative is what the matcher reads.
 */
export function parseOcrStatement(text, { accountId, profile = 'uk-generic-3col', year = null } = {}) {
  const spec = OCR_PROFILES[profile];
  if (!spec) return { lines: [], warnings: [`Unknown layout profile "${profile}"`] };

  const warnings = [];
  const lines = [];
  const rawLines = String(text).split('\n');

  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const m = spec.lineRe.exec(trimmed);
    if (!m) {
      // Not a transaction row. If it carries no digits it is very likely a
      // wrapped continuation of the previous narrative.
      if (lines.length && !/\d\.\d{2}/.test(trimmed) && trimmed.length < 80) {
        const prev = lines[lines.length - 1];
        prev.description = `${prev.description} ${trimmed}`.trim();
        prev.lineHash = lineHash(prev);
      }
      continue;
    }

    const g = m.groups;
    const date = parseStatementDate(g.date, { year });
    if (!date) { warnings.push(`Unrecognised date in "${trimmed.slice(0, 60)}"`); continue; }

    let amountPence;
    if (g.amount != null) {
      amountPence = toPence(g.amount);
    } else {
      const inP = toPence(g.paidIn) || 0;
      const outP = toPence(g.paidOut) || 0;
      amountPence = inP - outP;
    }
    if (amountPence == null || amountPence === 0) {
      warnings.push(`No usable amount in "${trimmed.slice(0, 60)}"`);
      continue;
    }

    const balancePence = g.balance != null ? toPence(g.balance) : null;
    const description = String(g.description || '').trim();

    const line = {
      accountId,
      date,
      description,
      amount: fromPence(amountPence),
      balance: balancePence == null ? null : fromPence(balancePence),
    };
    line.lineHash = lineHash(line);
    lines.push(line);
  }

  if (!lines.length) warnings.push('No transaction lines matched this layout profile');
  return { lines, warnings };
}

/* ── entry point ───────────────────────────────────────────────────── */

/**
 * Parse a statement and decide whether its lines can be trusted.
 *
 * Returns { status, lines, warnings, balance, parserProfile }.
 *
 * status is 'parsed' only when the balance chain verifies. Otherwise it is
 * 'needs-review' and the caller must not treat the lines as fact — that is the
 * whole safety mechanism, and the reason a parse is never silently accepted.
 */
export function parseStatement({
  text, accountId, format = 'csv',
  mapping = null, profile = 'uk-generic-3col', hasHeader = true,
  openingBalance = null, closingBalance = null, year = null,
} = {}) {
  let result;
  let parserProfile;

  if (format === 'csv') {
    if (!mapping) return { status: 'failed', lines: [], warnings: ['No column mapping supplied for this account'], parserProfile: 'csv' };
    result = parseCsvStatement(text, { accountId, mapping, hasHeader });
    parserProfile = 'csv';
  } else if (format === 'ofx') {
    result = parseOfxStatement(text, { accountId });
    parserProfile = 'ofx';
  } else if (format === 'ocr') {
    result = parseOcrStatement(text, { accountId, profile, year });
    parserProfile = `ocr:${profile}`;
  } else {
    return { status: 'failed', lines: [], warnings: [`Unsupported format "${format}"`], parserProfile: null };
  }

  const warnings = [...result.warnings];

  if (!result.lines.length) {
    return { status: 'failed', lines: [], warnings, parserProfile, balance: null };
  }

  const balance = validateBalanceChain(result.lines, { openingBalance, closingBalance });

  if (!balance.ok) {
    warnings.push(balance.error);
    return { status: 'needs-review', lines: result.lines, warnings, parserProfile, balance };
  }

  return { status: 'parsed', lines: result.lines, warnings, parserProfile, balance };
}

export default {
  parseStatement,
  parseCsvStatement,
  parseOfxStatement,
  parseOcrStatement,
  parseCsv,
  validateBalanceChain,
  parseStatementDate,
  normaliseDescription,
  lineHash,
  toPence,
  fromPence,
  OCR_PROFILES,
};
