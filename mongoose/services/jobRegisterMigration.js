// Start-up: Job Register rows → jobs.
//
// A register row used to be one quote + one project + one invoice, flat:
// quoteNumber/quoteDate/quoteStatus/quoteSentAt, projectNumber, and
// invoiceNumber/invoiceDate. A row is now a job holding quotes[] and
// invoices[] (models/INTERNAL/jobRegister.js). This reshapes each old row in
// place, so its _id and uuid (and any attendance booked on it) stay:
//
//   quoteNumber → quotes: [{ number, date: quoteDate, value, description,
//                 status, sentAt: quoteSentAt }]
//                 status: won if the row was won or has a project number,
//                 else its quoteStatus (to quote / quoted), else quoted
//   invoiceNumber → invoices: [{ number, date: invoiceDate }], and the job
//                 is marked completed (an invoiced row was a finished job)
//   value       → the quote's value; kept on the job only when it has no
//                 quote (a job-only row)
//
// The old fields are then $unset. Each update is filtered on an old field
// still being there, so running it again finds nothing to do. The old
// quoteNumber_1 / invoiceNumber_1 indexes are dropped and the model's
// indexes built. Staged workbook uploads aren't touched: they keep the
// sheet's shape, which the import turns into jobs when it runs.
//
// Everything above "Database" is pure, for testing without a database.
import mongoose from 'mongoose';
import mdb from './mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';

export const OLD_FIELDS = ['quoteNumber', 'quoteDate', 'quoteStatus', 'quoteSentAt', 'quoteSendingAt', 'invoiceNumber', 'invoiceDate'];
export const OLD_INDEXES = ['quoteNumber_1', 'invoiceNumber_1'];

/** Rows still in the old shape: any old field present. */
export const OLD_ROW_FILTER = { $or: OLD_FIELDS.map((f) => ({ [f]: { $exists: true } })) };

const present = (v) => v !== undefined && v !== null && v !== '';
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => present(v)));

/**
 * The update that reshapes one old row, or null if it has nothing old.
 * Returns { set, unset } for updateOne. `newId` makes the quote and invoice
 * _ids (an ObjectId by default; tests pass their own). Pure.
 */
export function reshapeRow(row, newId = () => new mongoose.Types.ObjectId()) {
  if (!row || !OLD_FIELDS.some((f) => row[f] !== undefined)) return null;
  const quotes = Array.isArray(row.quotes) ? [...row.quotes] : [];
  const invoices = Array.isArray(row.invoices) ? [...row.invoices] : [];
  const hasQuote = (n) => quotes.some((q) => Number(q.number) === Number(n));
  const hasInvoice = (n) => invoices.some((i) => Number(i.number) === Number(n));

  if (present(row.quoteNumber) && !hasQuote(row.quoteNumber)) {
    const won = !!row.won || present(row.projectNumber);
    quotes.push({
      _id: newId(),
      ...compact({
        number: Number(row.quoteNumber),
        date: row.quoteDate,
        value: row.value,
        description: row.description,
        sentAt: row.quoteSentAt,
      }),
      status: won ? 'won' : (['toQuote', 'quoted'].includes(row.quoteStatus) ? row.quoteStatus : 'quoted'),
    });
  }
  if (present(row.invoiceNumber) && !hasInvoice(row.invoiceNumber)) {
    invoices.push({ _id: newId(), ...compact({ number: Number(row.invoiceNumber), date: row.invoiceDate }) });
  }

  const set = { quotes, invoices };
  if (present(row.invoiceNumber)) set.completed = true;
  const unset = Object.fromEntries(OLD_FIELDS.filter((f) => row[f] !== undefined).map((f) => [f, '']));
  // The value moved to the quote: a job with quotes is worth its quotes
  if (quotes.length && row.value !== undefined) unset.value = '';
  return { set, unset };
}

// ── Database ────────────────────────────────────────────────────────────

/**
 * Reshape every old row (raw collection, no timestamps touched), then swap
 * the indexes. Returns the number of rows reshaped. Idempotent.
 */
export async function migrateRowsToJobs(db = mdb) {
  const Model = db.INTERNAL?.jobRegister;
  if (!Model) return 0;
  const coll = Model.collection;
  let migrated = 0;
  const rows = await coll.find(OLD_ROW_FILTER).toArray();
  for (const row of rows) {
    const change = reshapeRow(row);
    if (!change) continue;
    // Only while it's still old: a second run (or a racing instance) skips it
    const res = await coll.updateOne(
      { _id: row._id, ...OLD_ROW_FILTER },
      { $set: change.set, $unset: change.unset },
    );
    migrated += res?.modifiedCount ?? 0;
  }
  for (const name of OLD_INDEXES) {
    try {
      await coll.dropIndex(name);
      logger.info(`[migration] Job Register: dropped old index ${name}`);
    } catch (err) {
      // 27 IndexNotFound (or 26 NamespaceNotFound on an empty database): already gone
      if (err?.code !== 27 && err?.code !== 26 && err?.codeName !== 'IndexNotFound' && err?.codeName !== 'NamespaceNotFound') throw err;
    }
  }
  await Model.createIndexes();
  if (migrated) logger.info(`[migration] Job Register: reshaped ${migrated} row(s) into jobs with quotes and invoices`);
  return migrated;
}

export default { OLD_FIELDS, OLD_INDEXES, OLD_ROW_FILTER, reshapeRow, migrateRowsToJobs };
