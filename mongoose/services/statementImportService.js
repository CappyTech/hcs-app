import crypto from 'crypto';
import mdb from './mongooseDatabaseService.js';
import parser from './statementParserService.js';

/**
 * Persists a parsed statement: one statementImport plus its statementLine
 * rows, deduped against everything already held for that account.
 *
 * Source-agnostic by design. A CSV upload and a Paperless OCR parse arrive
 * here in the same shape, so the reconciliation side never has to care which
 * it was.
 */

class StatementImportError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'StatementImportError';
    this.statusCode = statusCode;
  }
}

function models() {
  const StatementImport = mdb.INTERNAL?.statementImport;
  const StatementLine = mdb.INTERNAL?.statementLine;
  if (!StatementImport || !StatementLine) {
    throw new StatementImportError('Statement models are not loaded', 503);
  }
  return { StatementImport, StatementLine };
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Infer the format from a filename, so the user does not have to declare it. */
export function detectFormat(filename = '') {
  const ext = String(filename).toLowerCase().split('.').pop();
  if (ext === 'csv' || ext === 'txt') return 'csv';
  if (ext === 'ofx' || ext === 'qfx') return 'ofx';
  return null;
}

/**
 * Column mappings per bank layout, keyed by a name saved against the account.
 *
 * Header names are matched case-insensitively, so only the wording has to
 * match, not the capitalisation. Add a layout when a new bank's export turns
 * up rather than trying to guess at layouts nobody has seen.
 */
export const CSV_LAYOUTS = {
  'paid-in-out': {
    label: 'Separate Paid In / Paid Out columns',
    mapping: { date: 'Date', description: 'Description', paidIn: 'Paid In', paidOut: 'Paid Out', balance: 'Balance' },
  },
  'signed-amount': {
    label: 'Single signed Amount column',
    mapping: { date: 'Date', description: 'Description', amount: 'Amount', balance: 'Balance' },
  },
  'signed-amount-memo': {
    label: 'Single Amount column with Memo narrative',
    mapping: { date: 'Date', description: 'Memo', amount: 'Amount', balance: 'Balance' },
  },
};

/**
 * Parse and store a statement.
 *
 * Returns { import: doc, inserted, duplicates, status, warnings }.
 *
 * Lines are stored whatever the parse status, including 'needs-review' — but
 * a needs-review import is never treated as fact by the reconciliation side.
 * Storing them is what lets a person look at the parse and decide, which is
 * the entire point of not silently discarding a failed balance chain.
 */
export async function importStatement({
  text,
  accountId,
  accountName = '',
  format = 'csv',
  layout = 'paid-in-out',
  mapping = null,
  profile = 'uk-generic-3col',
  hasHeader = true,
  openingBalance = null,
  closingBalance = null,
  year = null,
  source = 'upload',
  paperlessId = null,
  originalFileName = '',
  storedFileName = '',
  user = null,
} = {}) {
  const { StatementImport, StatementLine } = models();

  if (!Number.isFinite(Number(accountId))) {
    throw new StatementImportError('An account must be chosen before a statement can be imported');
  }
  if (!text || !String(text).trim()) {
    throw new StatementImportError('The statement is empty');
  }

  const sourceHash = sha256(text);

  // An unchanged re-ingest is a no-op. Matters most for the Paperless path,
  // where a scheduled grab revisits the same documents repeatedly.
  const existing = await StatementImport.findOne({
    accountId: Number(accountId), sourceHash, deletedAt: null,
  });
  if (existing) {
    return {
      import: existing,
      inserted: 0,
      duplicates: existing.lineCount,
      status: existing.status,
      warnings: ['This statement has already been imported — nothing changed.'],
      unchanged: true,
    };
  }

  const resolvedMapping = mapping || CSV_LAYOUTS[layout]?.mapping || null;

  const parsed = parser.parseStatement({
    text,
    accountId: Number(accountId),
    format,
    mapping: resolvedMapping,
    profile,
    hasHeader,
    openingBalance,
    closingBalance,
    year,
  });

  const dates = parsed.lines.map(l => l.date).filter(Boolean).sort((a, b) => a - b);

  const doc = new StatementImport({
    source,
    paperlessId,
    originalFileName,
    storedFileName,
    accountId: Number(accountId),
    accountName,
    periodStart: dates[0] || null,
    periodEnd: dates[dates.length - 1] || null,
    openingBalance,
    closingBalance,
    balanceChainOk: Boolean(parsed.balance?.ok),
    balanceChainError: parsed.balance?.error || '',
    parserProfile: parsed.parserProfile || '',
    status: parsed.status,
    lineCount: parsed.lines.length,
    sourceHash,
    warnings: parsed.warnings.slice(0, 50),
    importedBy: user?._id || null,
    importedByName: user?.name || user?.username || user?.email || '',
  });
  await doc.save();

  // Dedupe against what this account already holds.
  let inserted = 0;
  let duplicates = 0;

  if (parsed.lines.length) {
    const hashes = parsed.lines.map(l => l.lineHash);
    const seen = new Set(
      await StatementLine.distinct('lineHash', {
        accountId: Number(accountId), lineHash: { $in: hashes }, deletedAt: null,
      }),
    );

    // Also collapse duplicates within this one file.
    const withinFile = new Set();
    const fresh = [];
    for (const line of parsed.lines) {
      if (seen.has(line.lineHash) || withinFile.has(line.lineHash)) { duplicates += 1; continue; }
      withinFile.add(line.lineHash);
      fresh.push({ ...line, importId: doc._id, status: 'unmatched' });
    }

    if (fresh.length) {
      // ordered:false so a unique-index collision from a concurrent import
      // skips that row instead of abandoning the batch.
      const result = await StatementLine.insertMany(fresh, { ordered: false })
        .catch((err) => {
          if (err?.insertedDocs) return err.insertedDocs;
          throw err;
        });
      inserted = Array.isArray(result) ? result.length : 0;
      duplicates += fresh.length - inserted;
    }
  }

  doc.duplicateCount = duplicates;
  await doc.save();

  return { import: doc, inserted, duplicates, status: parsed.status, warnings: parsed.warnings };
}

/** Imports for the statements screen, newest first. */
export async function listImports({ accountId = null, limit = 100 } = {}) {
  const { StatementImport } = models();
  const query = { deletedAt: null };
  if (accountId != null) query.accountId = Number(accountId);
  return StatementImport.find(query).sort({ createdAt: -1 }).limit(limit).lean();
}

/**
 * One import with its lines, for the review screen.
 *
 * The key is `statementImport`, not `import`: EJS compiles locals into
 * variables, and `import` is a reserved word that would fail to compile.
 */
export async function getImport(uuid) {
  const { StatementImport, StatementLine } = models();
  const doc = await StatementImport.findOne({ uuid, deletedAt: null }).lean();
  if (!doc) return null;
  const lines = await StatementLine.find({ importId: doc._id, deletedAt: null })
    .sort({ date: 1 }).lean();
  return { statementImport: doc, lines };
}

export default {
  importStatement,
  listImports,
  getImport,
  detectFormat,
  CSV_LAYOUTS,
  StatementImportError,
};
export { StatementImportError };
