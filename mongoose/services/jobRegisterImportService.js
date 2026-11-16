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
import { clientKey, customerChoices } from './jobRegisterService.js';
import store from './workbookImportStore.js';

const QUOTE_COLS = { date: 1, number: 2, site: 3, client: 4, contact: 5, value: 6, description: 7, invoice: 8, invoiceDate: 9 };
const JOB_COLS = { number: 0, date: 1, site: 2, client: 3, contact: 4, value: 5, description: 6, invoice: 7, invoiceDate: 8, clientRef: 9, notes: [10, 11] };
const LIMITS = { site: 300, client: 200, contact: 200, description: 300, clientRef: 100, notes: 2000 };

// Fields the import may fill in on a row already in the register
const FILLABLE = ['quoteNumber', 'quoteDate', 'projectNumber', 'jobDate', 'site', 'customerCode', 'client', 'contact', 'value',
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

// ── Clients → KashFlow customers ────────────────────────────────────────

/** The distinct clients written on the sheets, by clientKey, in name order. Pure. */
export function sheetClients(entries = []) {
  const m = new Map();
  for (const e of entries) {
    const key = clientKey(e.client);
    if (!key) continue;
    const c = m.get(key) || m.set(key, { key, spellings: new Map(), count: 0 }).get(key);
    c.count++;
    const name = String(e.client).trim().replace(/\s+/g, ' ');
    c.spellings.set(name, (c.spellings.get(name) || 0) + 1);
  }
  return [...m.values()]
    .map((c) => ({ key: c.key, label: [...c.spellings.entries()].sort((a, b) => b[1] - a[1])[0][0], count: c.count }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * A sheet client's suggested KashFlow customer code, or ''. Same name (case
 * and spacing aside) wins; else the one customer whose name starts with the
 * sheet's (word for word), or whose name the sheet's starts with ("Plus Dane
 * MAJ" → "Plus Dane"). customers: [{ code, name }]. Pure.
 */
export function suggestCustomer(label, customers = []) {
  const k = clientKey(label);
  if (!k) return '';
  const byName = (c) => clientKey(c.name);
  const exact = customers.filter((c) => byName(c) === k);
  if (exact.length === 1) return exact[0].code;
  const starts = customers.filter((c) => `${byName(c)} `.startsWith(`${k} `));
  if (starts.length === 1) return starts[0].code;
  const within = customers.filter((c) => byName(c) && `${k} `.startsWith(`${byName(c)} `));
  if (within.length === 1) return within[0].code;
  return '';
}

/**
 * Each sheet client with the customer chosen for it: as saved, else the
 * suggestion. Only codes of known customers count; '' means "don't import".
 */
export function clientMapping(staged, customers = []) {
  const codes = new Set(customers.map((c) => c.code));
  const saved = staged.saved && staged.choices?.clients && typeof staged.choices.clients === 'object' ? staged.choices.clients : null;
  return sheetClients(staged.parsed.entries).map((c, index) => {
    const has = saved && Object.prototype.hasOwnProperty.call(saved, String(index));
    const pick = has ? String(saved[String(index)]) : suggestCustomer(c.label, customers);
    return { ...c, index, code: pick && codes.has(pick) ? pick : '', suggested: !has };
  });
}

/** The submitted client choices (client_<i>) as { [index]: code | '' }, known codes only. Pure. */
export function readClientChoices(body = {}, clients = [], customers = []) {
  const codes = new Set(customers.map((c) => c.code));
  const out = {};
  clients.forEach((_, i) => {
    const v = body[`client_${i}`];
    if (v === undefined) return;
    out[i] = codes.has(String(v)) ? String(v) : '';
  });
  return out;
}

/**
 * Entries with their client set to the chosen customer (code and KashFlow
 * name), or marked unmatchedClient when none was chosen. Pure.
 */
export function applyClients(entries, mapping, customers = []) {
  const nameOf = new Map(customers.map((c) => [c.code, c.name]));
  const codeByKey = new Map(mapping.map((m) => [m.key, m.code]));
  return entries.map((e) => {
    const code = codeByKey.get(clientKey(e.client));
    if (!code) return { ...e, unmatchedClient: true };
    return { ...e, sheetClient: e.client, customerCode: code, client: nameOf.get(code) || e.client };
  });
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
 * Each plan item is { action: 'create' | 'update' | 'same' | 'conflict' | 'skip', entry, fill, existing, reason, overwrite }.
 * 'skip' is a row whose client wasn't matched to a KashFlow customer.
 *
 * An existing row that came from an import and hasn't been edited by hand
 * since (importId set, no editedAt) is overwritten with the sheet's values
 * where they differ (overwrite: true); any other row only has its empty
 * fields filled in. A blank on the sheet never clears a field.
 */
export function planImport(entries, existing) {
  const byQuote = new Map();
  const byProject = new Map();
  for (const e of existing) {
    if (e.quoteNumber != null) byQuote.set(Number(e.quoteNumber), e);
    if (e.projectNumber != null) byProject.set(Number(e.projectNumber), e);
  }
  return entries.map((entry) => {
    if (entry.unmatchedClient) return { action: 'skip', entry, reason: `Client “${entry.client}” isn't matched to a KashFlow customer` };
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
    const overwrite = !!row.importId && !row.editedAt;
    const fill = {};
    for (const k of FILLABLE) {
      if (blank(entry[k])) continue;
      if (blank(row[k]) || (overwrite && !sameValue(entry[k], row[k]))) fill[k] = entry[k];
    }
    if (entry.cancelled && !row.cancelled && row.invoiceNumber == null) fill.cancelled = true;
    if (overwrite && !entry.cancelled && row.cancelled) fill.cancelled = false;
    // An invoice number needs its project number on the row
    if (fill.invoiceNumber != null && row.projectNumber == null && fill.projectNumber == null) delete fill.invoiceNumber;
    return Object.keys(fill).length ? { action: 'update', entry, existing: row, fill, overwrite } : { action: 'same', entry, existing: row };
  });
}

/** Counts of a plan, by action. */
export function summarisePlan(plan) {
  const counts = { create: 0, update: 0, same: 0, conflict: 0, skip: 0 };
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
  return mdb.INTERNAL.jobRegister.find({}).select(`_id uuid cancelled importId editedAt ${FILLABLE.join(' ')}`).lean();
}

/** Park a parsed workbook for its preview. Returns the import document. */
export async function stageUpload({ sheets, fileName, userId }) {
  const parsed = parseJobRegWorkbook(sheets);
  if (!parsed.entries.length && !parsed.problems.length) {
    throw Object.assign(new Error('No quotes or jobs were found in that workbook.'), { status: 400 });
  }
  return mdb.INTERNAL.workbookImport.create({ kind: 'jobRegister', fileName, parsed, createdBy: userId || undefined });
}

const findStaged = (uuid) => store.findUpload(uuid, 'jobRegister');

const pairValue = (s) => `${s.quoteNumber}:${s.projectNumber}`;

/** The ticked pairs: as saved, else the likely suggestions. Pure. */
export function tickedPairs(staged) {
  const offered = (staged.parsed.suggestions || []).map((s) => ({ ...s, value: pairValue(s) }));
  const saved = staged.saved && Array.isArray(staged.choices?.pairs) ? new Set(staged.choices.pairs.map(String)) : null;
  return offered.map((s) => ({ ...s, ticked: saved ? saved.has(s.value) : s.likely }));
}

/**
 * The preview: the parsed workbook planned against the register as it is
 * now, with the suggested pairs ticked as saved (or the likely ones); the
 * counts assume those.
 */
export async function loadPreview(uuid) {
  const staged = await findStaged(uuid);
  const customers = await customerList();
  const suggestions = tickedPairs(staged);
  const clients = clientMapping(staged, customers);
  const paired = applyChosenPairs(staged.parsed.entries, suggestions.filter((s) => s.ticked).map((s) => s.value));
  const plan = planImport(applyClients(paired, clients, customers), await existingRows());
  return { staged, plan, suggestions, clients, customers, counts: summarisePlan(plan) };
}

const customerList = () => customerChoices();

/** What was submitted: the ticked pairs (offered ones only) and the client choices. */
function readSubmitted(staged, body, customers) {
  const offered = new Set((staged.parsed.suggestions || []).map(pairValue));
  const pairs = [].concat(body.pair || []).map(String).filter((v) => offered.has(v));
  const clients = readClientChoices(body, sheetClients(staged.parsed.entries), customers);
  return { pairs, clients };
}

/** Save the ticked pairs and client choices for later; kept until imported or deleted. */
export async function saveForLater(uuid, body, userId) {
  const staged = await findStaged(uuid);
  await store.saveChoices(uuid, 'jobRegister', readSubmitted(staged, body || {}, await customerList()), userId);
}

/**
 * Run the import with the suggested pairs that were ticked. Planned again
 * first, so anything entered since the preview is respected.
 */
export async function runImport(uuid, body = {}) {
  const staged = await findStaged(uuid);
  if (staged.importedAt) throw Object.assign(new Error('That upload has already been imported.'), { status: 400 });
  const customers = await customerList();
  const { pairs, clients } = readSubmitted(staged, body || {}, customers);
  const mapping = clientMapping({ ...staged, saved: true, choices: { clients } }, customers);
  const plan = planImport(applyClients(applyChosenPairs(staged.parsed.entries, pairs), mapping, customers), await existingRows());
  const result = { created: 0, updated: 0, unchanged: 0, conflicts: 0, skipped: 0, failed: [] };
  const Model = mdb.INTERNAL.jobRegister;

  for (const p of plan) {
    const label = p.entry.projectNumber != null ? `Job ${p.entry.projectNumber}` : `Quote ${p.entry.quoteNumber}`;
    try {
      if (p.action === 'create') {
        await Model.create({ ...toModelFields(p.entry), importId: staged.uuid, importedAt: new Date() });
        result.created++;
      } else if (p.action === 'update') {
        const doc = await Model.findById(p.existing._id);
        if (!doc) { result.failed.push({ label, reason: 'The register row was deleted during the import' }); continue; }
        doc.set(toModelFields({ ...p.fill, cancelled: p.fill.cancelled }));
        if (p.fill.cancelled === false) doc.cancelled = false;
        await doc.save();
        result.updated++;
      } else if (p.action === 'same') {
        result.unchanged++;
      } else if (p.action === 'skip') {
        result.skipped++;
      } else {
        result.conflicts++;
      }
    } catch (err) {
      result.failed.push({ label, reason: err.code === 11000 ? 'Number already in the register' : err.message });
    }
  }
  await store.markImported(staged._id, result);
  logger.info(`[jobRegisterImport] ${staged.fileName}: created ${result.created}, updated ${result.updated}, unchanged ${result.unchanged}, conflicts ${result.conflicts}, failed ${result.failed.length}`);
  return result;
}

// ── Linking rows already in the register ───────────────────────────────

/**
 * Register rows whose client isn't linked to a KashFlow customer yet, by
 * client, each with a suggested customer. For the link-clients page.
 */
export async function loadUnlinked() {
  const [rows, customers] = await Promise.all([
    mdb.INTERNAL.jobRegister.find({ customerCode: { $in: [null, ''] } }).select('_id client').lean(),
    customerList(),
  ]);
  const clients = sheetClients(rows).map((c, index) => ({ ...c, index, code: suggestCustomer(c.label, customers) }));
  return { clients, customers, total: rows.length };
}

/**
 * Link the chosen clients (client_<i> → customer code; blank leaves it) on
 * every unlinked row with that client: customerCode set and client renamed to
 * the customer's KashFlow name. Not a hand edit, so a re-import may still
 * overwrite an imported row. Returns { rows, clients }.
 */
export async function linkClients(body = {}) {
  const { clients, customers } = await loadUnlinked();
  const nameOf = new Map(customers.map((c) => [c.code, c.name]));
  const chosen = readClientChoices(body, clients, customers);
  const rows = await mdb.INTERNAL.jobRegister.find({ customerCode: { $in: [null, ''] } }).select('_id client').lean();
  let linkedRows = 0;
  let linkedClients = 0;
  for (const c of clients) {
    const code = chosen[c.index];
    if (!code) continue;
    const ids = rows.filter((r) => clientKey(r.client) === c.key).map((r) => r._id);
    if (!ids.length) continue;
    const res = await mdb.INTERNAL.jobRegister.updateMany({ _id: { $in: ids } }, { $set: { customerCode: code, client: nameOf.get(code) } });
    linkedRows += res.modifiedCount ?? ids.length;
    linkedClients++;
  }
  logger.info(`[jobRegister] Linked ${linkedRows} row(s) across ${linkedClients} client(s) to KashFlow customers`);
  return { rows: linkedRows, clients: linkedClients };
}

/**
 * Start-up: rows imported before rows recorded their import (6.116.0) get
 * importId/importedAt from the upload that made them, while that upload is
 * still kept (a day after its import). A row is that upload's when its quote
 * or project number is on the sheet and it was created in the hour before
 * the import finished. One changed after it was created counts as edited by
 * hand (editedAt = updatedAt), so a re-import won't overwrite it.
 * Idempotent.
 */
export async function flagImportedRows() {
  const Uploads = mdb.INTERNAL.workbookImport;
  const Rows = mdb.INTERNAL.jobRegister;
  if (!Uploads || !Rows) return 0;
  const uploads = await Uploads.find({ kind: 'jobRegister', importedAt: { $ne: null } }).select('uuid importedAt parsed.entries').lean();
  let flagged = 0;
  for (const u of uploads) {
    const entries = u.parsed?.entries || [];
    const quotes = entries.map((e) => e.quoteNumber).filter((n) => n != null);
    const projects = entries.map((e) => e.projectNumber).filter((n) => n != null);
    const end = new Date(u.importedAt);
    const rows = await Rows.find({
      importId: { $in: [null, ''] },
      createdAt: { $gte: new Date(end.getTime() - 3600e3), $lte: end },
      $or: [{ quoteNumber: { $in: quotes } }, { projectNumber: { $in: projects } }],
    }).select('_id createdAt updatedAt').lean();
    for (const r of rows) {
      const edited = r.updatedAt && r.createdAt && new Date(r.updatedAt) - new Date(r.createdAt) > 60e3;
      await Rows.updateOne({ _id: r._id }, { $set: { importId: u.uuid, importedAt: end, ...(edited ? { editedAt: r.updatedAt } : {}) } }, { timestamps: false });
      flagged++;
    }
  }
  if (flagged) logger.info(`[migration] Job Register: marked ${flagged} row(s) as imported`);
  return flagged;
}

export default {
  cellText, cellInt, cellMoney, cellDate, siteKey, findSheets, parseRow, matchKey, pairQuotesWithJobs, mergePair,
  suggestPairs, applyChosenPairs, parseJobRegWorkbook, tickedPairs, saveForLater,
  sheetClients, suggestCustomer, clientMapping, readClientChoices, applyClients, flagImportedRows, loadUnlinked, linkClients, planImport, summarisePlan, toModelFields, stageUpload, loadPreview, runImport,
};
