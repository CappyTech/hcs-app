// Job Register import: the "Job Reg" workbook into the register.
//
// The workbook has two sheets that are two stages of the same row:
//
//   Quotes NN   B date · C quote number · D site · E client · F contact ·
//               G value · H description · I invoice no · J invoice date
//   Job Reg NN  A project number · B date · C site · D client · E contact ·
//               F value · G description · H invoice no · I invoice date ·
//               J client's order ref · K, L notes
//
// A job is copied over from its quote, so a quote and a job with the same
// site, client and value are one register row (quote number + project
// number). Pairs that can't be told apart are left as separate rows.
//
// Re-importing is safe: a row whose quote or project number is already in
// the register only has its empty fields filled in, never overwritten.
//
// Everything above "Database" is pure, for testing without a database.
import logger from '../../services/loggerService.js';
import mdb from './mongooseDatabaseService.js';
import { clientKey } from './jobRegisterService.js';

const QUOTE_COLS = { date: 1, number: 2, site: 3, client: 4, contact: 5, value: 6, description: 7, invoice: 8, invoiceDate: 9 };
const JOB_COLS = { number: 0, date: 1, site: 2, client: 3, contact: 4, value: 5, description: 6, invoice: 7, invoiceDate: 8, clientRef: 9, notes: [10, 11] };
const LIMITS = { site: 300, client: 200, contact: 200, description: 300, clientRef: 100, notes: 2000 };

// Fields the import may fill in on a row already in the register
const FILLABLE = ['quoteNumber', 'quoteDate', 'projectNumber', 'jobDate', 'site', 'client', 'contact', 'value',
  'description', 'clientRef', 'invoiceNumber', 'invoiceDate', 'notes'];
const DATE_FIELDS = ['quoteDate', 'jobDate', 'invoiceDate'];

// ── Cells ───────────────────────────────────────────────────────────────

const isDateCell = (v) => v && typeof v === 'object' && typeof v.date === 'string';

/** Cell as trimmed text ('' for empty); dates as dd/mm/yyyy. */
export function cellText(v) {
  if (v == null) return '';
  if (isDateCell(v)) return v.date.split('-').reverse().join('/');
  return String(v).trim().replace(/\s+/g, ' ');
}

/** A positive whole number from a number or numeric text, else null. */
export function cellInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : null;
  const s = cellText(v);
  return /^\d+$/.test(s) && Number(s) > 0 ? Number(s) : null;
}

/** Money from a number or "£1,234.50", rounded to pence, else null. */
export function cellMoney(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null;
  const s = cellText(v).replace(/[£,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s) * 100) / 100;
}

/** 'yyyy-mm-dd' from a date cell or text starting dd/mm/yyyy (or dd.mm.yy), else null. */
export function cellDate(v) {
  if (isDateCell(v)) return v.date;
  const m = cellText(v).match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/);
  if (!m) return null;
  const [d, mo] = [Number(m[1]), Number(m[2])];
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** A site as a match key: case, punctuation and spacing don't count. */
export function siteKey(site) {
  return String(site || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);

// ── Sheets ──────────────────────────────────────────────────────────────

/** The Quotes and Job Reg sheets of the workbook, by name. */
export function findSheets(sheets = []) {
  const name = (s) => String(s.name || '').trim();
  return {
    quotes: sheets.find((s) => /^quotes?\b/i.test(name(s))) || null,
    jobs: sheets.find((s) => /^job\s*reg/i.test(name(s))) || null,
  };
}

/**
 * One sheet row as a register entry, or null for a row that isn't one (no
 * number, or a number with nothing else: the pre-numbered blank rows).
 * kind: 'quote' | 'job'. `problem` is set when the row can't be imported.
 */
export function parseRow(row, kind, rowNumber) {
  const c = kind === 'quote' ? QUOTE_COLS : JOB_COLS;
  const number = cellInt(row[c.number]);
  if (number == null) return null;
  const site = clip(cellText(row[c.site]), LIMITS.site);
  const client = clip(cellText(row[c.client]), LIMITS.client);
  if (!site && !client) return null;

  const notes = [];
  const entry = {
    kind, row: rowNumber,
    site, client,
    contact: clip(cellText(row[c.contact]), LIMITS.contact),
    description: clip(cellText(row[c.description]), LIMITS.description),
    value: cellMoney(row[c.value]),
    cancelled: false,
  };
  if (entry.value == null && cellText(row[c.value])) notes.push(`Value: ${cellText(row[c.value])}`);

  const date = cellDate(row[c.date]);
  if (date == null && cellText(row[c.date])) notes.push(`Date: ${cellText(row[c.date])}`);
  if (kind === 'quote') {
    entry.quoteNumber = number;
    entry.quoteDate = date;
  } else {
    entry.projectNumber = number;
    entry.jobDate = date;
    const ref = cellText(row[c.clientRef]);
    if (ref) entry.clientRef = clip(ref, LIMITS.clientRef);
  }

  // Invoice number: a number on a job; "Cancelled" anywhere; other text is a note
  const invText = cellText(row[c.invoice]);
  const invNumber = cellInt(row[c.invoice]);
  if (kind === 'job' && invNumber != null) entry.invoiceNumber = invNumber;
  else if (/cancel/i.test(invText)) entry.cancelled = true;
  else if (invText) notes.push(`Invoice: ${invText}`);

  const invDate = cellDate(row[c.invoiceDate]);
  if (kind === 'job' && entry.invoiceNumber != null && invDate) entry.invoiceDate = invDate;
  else if (cellText(row[c.invoiceDate])) notes.push(`Invoice date: ${cellText(row[c.invoiceDate])}`);

  for (const col of c.notes || []) {
    const t = cellText(row[col]);
    if (t) notes.push(t);
  }
  entry.notes = clip(notes.join('; '), LIMITS.notes);

  if (!site) entry.problem = 'No site';
  else if (!client) entry.problem = 'No client';
  return entry;
}

function parseSheet(sheet, kind) {
  if (!sheet) return [];
  const out = [];
  sheet.rows.forEach((row, i) => {
    const e = parseRow(row || [], kind, i + 1);
    if (e) out.push(e);
  });
  return out;
}

/** Quote ↔ job match key: site, client and value, all present. */
export function matchKey(e) {
  if (e.value == null || !siteKey(e.site) || !clientKey(e.client)) return null;
  return `${siteKey(e.site)}|${clientKey(e.client)}|${e.value.toFixed(2)}`;
}

/**
 * Pair each job with the quote it was copied from. Where a key has the same
 * number of quotes and jobs they pair in number order (repeat jobs at one
 * site); any other count is ambiguous and stays unpaired.
 * Returns { pairs: [{ quote, job }], quotes (unpaired), jobs (unpaired), ambiguous: [key] }.
 */
export function pairQuotesWithJobs(quotes, jobs) {
  const group = (list) => {
    const m = new Map();
    for (const e of list) {
      const k = matchKey(e);
      if (!k) continue;
      (m.get(k) || m.set(k, []).get(k)).push(e);
    }
    return m;
  };
  const byQuote = group(quotes);
  const byJob = group(jobs);
  const paired = new Set();
  const pairs = [];
  const ambiguous = [];
  for (const [k, js] of byJob) {
    const qs = byQuote.get(k);
    if (!qs) continue;
    if (qs.length !== js.length) { ambiguous.push(k); continue; }
    const num = (field) => (a, b) => a[field] - b[field];
    const qsSorted = [...qs].sort(num('quoteNumber'));
    [...js].sort(num('projectNumber')).forEach((job, i) => {
      pairs.push({ quote: qsSorted[i], job });
      paired.add(qsSorted[i]).add(job);
    });
  }
  return {
    pairs,
    quotes: quotes.filter((e) => !paired.has(e)),
    jobs: jobs.filter((e) => !paired.has(e)),
    ambiguous,
  };
}

/** One register row from a quote and the job copied from it. The job's details win. */
export function mergePair(quote, job) {
  const pick = (k) => (job[k] !== '' && job[k] != null ? job[k] : quote[k]);
  const notes = [...new Set([quote.notes, job.notes].filter(Boolean))].join('; ');
  return {
    kind: 'pair', row: job.row, quoteRow: quote.row,
    quoteNumber: quote.quoteNumber, quoteDate: quote.quoteDate,
    projectNumber: job.projectNumber, jobDate: job.jobDate,
    site: pick('site'), client: pick('client'), contact: pick('contact'),
    description: pick('description'), value: pick('value'),
    ...(job.clientRef ? { clientRef: job.clientRef } : {}),
    ...(job.invoiceNumber != null ? { invoiceNumber: job.invoiceNumber, invoiceDate: job.invoiceDate || null } : {}),
    notes: notes.slice(0, LIMITS.notes),
    cancelled: job.cancelled,
  };
}

const siteWords = (site) => new Set(siteKey(site).split(' ').filter((w) => w.length >= 3 || /^\d+$/.test(w)));

/**
 * Possible pairs among the quotes and jobs left unpaired: the same site and
 * client at a different value (the price changed between quote and job), or
 * the same client and value at a site spelled differently (sharing a word).
 * Only where the job has exactly one such quote, and each quote is offered
 * once. `likely` marks the same-site kind, which the preview ticks.
 */
export function suggestPairs(quotes, jobs) {
  const used = new Set();
  const out = [];
  const candidates = (job, test) => quotes.filter((q) => !used.has(q) && clientKey(q.client) === clientKey(job.client) && test(q));
  for (const likely of [true, false]) {
    for (const job of jobs) {
      if (out.some((s) => s.job === job)) continue;
      const found = likely
        ? candidates(job, (q) => siteKey(q.site) === siteKey(job.site))
        : candidates(job, (q) => q.value != null && q.value === job.value && [...siteWords(q.site)].some((w) => siteWords(job.site).has(w)));
      if (found.length !== 1) continue;
      used.add(found[0]);
      out.push({ quote: found[0], job, likely });
    }
  }
  return out.map(({ quote, job, likely }) => ({
    quoteNumber: quote.quoteNumber, projectNumber: job.projectNumber, likely,
    reason: likely ? 'Same site and client, different value' : 'Same client and value, site written differently',
  }));
}

/**
 * Pair the suggested quotes and jobs that were ticked. `chosen` holds
 * "quoteNumber:projectNumber" strings; anything not a lone quote and lone job
 * is ignored. Returns a new entries list.
 */
export function applyChosenPairs(entries, chosen = []) {
  const quotes = new Map(entries.filter((e) => e.kind === 'quote').map((e) => [e.quoteNumber, e]));
  const jobs = new Map(entries.filter((e) => e.kind === 'job').map((e) => [e.projectNumber, e]));
  const merged = new Set();
  const pairs = [];
  for (const s of [].concat(chosen || [])) {
    const m = String(s).match(/^(\d+):(\d+)$/);
    if (!m) continue;
    const q = quotes.get(Number(m[1]));
    const j = jobs.get(Number(m[2]));
    if (!q || !j || merged.has(q) || merged.has(j)) continue;
    merged.add(q).add(j);
    pairs.push(mergePair(q, j));
  }
  if (!pairs.length) return entries;
  return [...entries.filter((e) => !merged.has(e)), ...pairs];
}

/**
 * The whole workbook, parsed. Throws a 400 if it has neither sheet.
 * Returns { sheets: { quotes, jobs } (names), entries, suggestions, problems, counts }.
 */
export function parseJobRegWorkbook(sheets) {
  const found = findSheets(sheets);
  if (!found.quotes && !found.jobs) {
    throw Object.assign(new Error("This doesn't look like the Job Reg workbook: it has no Quotes or Job Reg sheet."), { status: 400 });
  }
  const quotes = parseSheet(found.quotes, 'quote');
  const jobs = parseSheet(found.jobs, 'job');
  const problems = [...quotes, ...jobs].filter((e) => e.problem);
  const ok = (e) => !e.problem;

  // A number twice on one sheet: keep the first, report the rest
  const dedupe = (list, field) => {
    const seen = new Set();
    return list.filter((e) => {
      if (seen.has(e[field])) { problems.push({ ...e, problem: `${field === 'quoteNumber' ? 'Quote' : 'Project'} number repeated on the sheet` }); return false; }
      seen.add(e[field]);
      return true;
    });
  };
  const goodQuotes = dedupe(quotes.filter(ok), 'quoteNumber');
  const goodJobs = dedupe(jobs.filter(ok), 'projectNumber');

  const { pairs, quotes: loneQuotes, jobs: loneJobs, ambiguous } = pairQuotesWithJobs(goodQuotes, goodJobs);
  const entries = [...pairs.map((p) => mergePair(p.quote, p.job)), ...loneJobs, ...loneQuotes];
  return {
    sheets: { quotes: found.quotes?.name || null, jobs: found.jobs?.name || null },
    entries,
    suggestions: suggestPairs(loneQuotes, loneJobs),
    problems,
    counts: { quotes: goodQuotes.length, jobs: goodJobs.length, pairs: pairs.length, ambiguous: ambiguous.length },
  };
}

// ── Planning against the register ───────────────────────────────────────

const blank = (v) => v == null || v === '';
const sameValue = (a, b) => {
  if (blank(a) && blank(b)) return true;
  if (a instanceof Date || b instanceof Date) return new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);
  return String(a) === String(b);
};

/**
 * What the import would do with each entry, given the register as it is.
 * existing: register rows (lean) with quoteNumber/projectNumber.
 * Each plan item is { action: 'create' | 'update' | 'same' | 'conflict', entry, fill, existing, reason }.
 */
export function planImport(entries, existing) {
  const byQuote = new Map();
  const byProject = new Map();
  for (const e of existing) {
    if (e.quoteNumber != null) byQuote.set(Number(e.quoteNumber), e);
    if (e.projectNumber != null) byProject.set(Number(e.projectNumber), e);
  }
  return entries.map((entry) => {
    const pRow = entry.projectNumber != null ? byProject.get(entry.projectNumber) : null;
    const qRow = entry.quoteNumber != null ? byQuote.get(entry.quoteNumber) : null;
    if (pRow && qRow && String(pRow._id) !== String(qRow._id)) {
      return { action: 'conflict', entry, reason: `Quote ${entry.quoteNumber} and job ${entry.projectNumber} are separate rows in the register already` };
    }
    const row = pRow || qRow;
    if (!row) return { action: 'create', entry };
    // A row that already has a different quote or project number is another job
    for (const [field, label] of [['quoteNumber', 'quote'], ['projectNumber', 'project']]) {
      if (entry[field] != null && row[field] != null && Number(row[field]) !== entry[field]) {
        return { action: 'conflict', entry, existing: row, reason: `The register row has ${label} number ${row[field]}` };
      }
    }
    const fill = {};
    for (const k of FILLABLE) {
      if (!blank(entry[k]) && blank(row[k])) fill[k] = entry[k];
    }
    if (entry.cancelled && !row.cancelled && row.invoiceNumber == null) fill.cancelled = true;
    // An invoice number needs its project number on the row
    if (fill.invoiceNumber != null && row.projectNumber == null && fill.projectNumber == null) delete fill.invoiceNumber;
    return Object.keys(fill).length ? { action: 'update', entry, existing: row, fill } : { action: 'same', entry, existing: row };
  });
}

/** Counts of a plan, by action. */
export function summarisePlan(plan) {
  const counts = { create: 0, update: 0, same: 0, conflict: 0 };
  for (const p of plan) counts[p.action]++;
  return counts;
}

/** An entry or fill as model fields: dates to noon UTC, blanks dropped. */
export function toModelFields(src) {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (!FILLABLE.includes(k) && k !== 'cancelled') continue;
    if (blank(v)) continue;
    out[k] = DATE_FIELDS.includes(k) ? new Date(`${v}T12:00:00Z`) : v;
  }
  if (out.cancelled === false) delete out.cancelled;
  return out;
}

// ── Database ────────────────────────────────────────────────────────────

async function existingRows() {
  return mdb.INTERNAL.jobRegister.find({}).select(`_id uuid cancelled ${FILLABLE.join(' ')}`).lean();
}

/** Park a parsed workbook for its preview. Returns the import document. */
export async function stageUpload({ sheets, fileName, userId }) {
  const parsed = parseJobRegWorkbook(sheets);
  if (!parsed.entries.length && !parsed.problems.length) {
    throw Object.assign(new Error('No quotes or jobs were found in that workbook.'), { status: 400 });
  }
  return mdb.INTERNAL.workbookImport.create({ kind: 'jobRegister', fileName, parsed, createdBy: userId || undefined });
}

async function findStaged(uuid) {
  const doc = await mdb.INTERNAL.workbookImport.findOne({ uuid: String(uuid || ''), kind: 'jobRegister' }).lean();
  if (!doc) throw Object.assign(new Error('That upload has expired. Upload the workbook again.'), { status: 404 });
  return doc;
}

const pairValue = (s) => `${s.quoteNumber}:${s.projectNumber}`;

/**
 * The preview: the parsed workbook planned against the register as it is
 * now, with the likely suggested pairs ticked (the counts assume those).
 */
export async function loadPreview(uuid) {
  const staged = await findStaged(uuid);
  const suggestions = (staged.parsed.suggestions || []).map((s) => ({ ...s, value: pairValue(s) }));
  const entries = applyChosenPairs(staged.parsed.entries, suggestions.filter((s) => s.likely).map((s) => s.value));
  const plan = planImport(entries, await existingRows());
  return { staged, plan, suggestions, counts: summarisePlan(plan) };
}

/**
 * Run the import with the suggested pairs that were ticked. Planned again
 * first, so anything entered since the preview is respected.
 */
export async function runImport(uuid, chosenPairs = []) {
  const staged = await findStaged(uuid);
  if (staged.importedAt) throw Object.assign(new Error('That upload has already been imported.'), { status: 400 });
  const offered = new Set((staged.parsed.suggestions || []).map(pairValue));
  const chosen = [].concat(chosenPairs || []).map(String).filter((v) => offered.has(v));
  const plan = planImport(applyChosenPairs(staged.parsed.entries, chosen), await existingRows());
  const result = { created: 0, updated: 0, unchanged: 0, conflicts: 0, failed: [] };
  const Model = mdb.INTERNAL.jobRegister;

  for (const p of plan) {
    const label = p.entry.projectNumber != null ? `Job ${p.entry.projectNumber}` : `Quote ${p.entry.quoteNumber}`;
    try {
      if (p.action === 'create') {
        await Model.create(toModelFields(p.entry));
        result.created++;
      } else if (p.action === 'update') {
        const doc = await Model.findById(p.existing._id);
        if (!doc) { result.failed.push({ label, reason: 'The register row was deleted during the import' }); continue; }
        doc.set(toModelFields({ ...p.fill, cancelled: p.fill.cancelled }));
        await doc.save();
        result.updated++;
      } else if (p.action === 'same') {
        result.unchanged++;
      } else {
        result.conflicts++;
      }
    } catch (err) {
      result.failed.push({ label, reason: err.code === 11000 ? 'Number already in the register' : err.message });
    }
  }
  await mdb.INTERNAL.workbookImport.updateOne({ _id: staged._id }, { $set: { importedAt: new Date(), result } });
  logger.info(`[jobRegisterImport] ${staged.fileName}: created ${result.created}, updated ${result.updated}, unchanged ${result.unchanged}, conflicts ${result.conflicts}, failed ${result.failed.length}`);
  return result;
}

export default {
  cellText, cellInt, cellMoney, cellDate, siteKey, findSheets, parseRow, matchKey, pairQuotesWithJobs, mergePair,
  suggestPairs, applyChosenPairs, parseJobRegWorkbook, planImport, summarisePlan, toModelFields, stageUpload, loadPreview, runImport,
};
