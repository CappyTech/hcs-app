// Job Register: the plan of what will be in KashFlow, kept as double entry.
//
// Each register row is entered here first, then checked against the synced
// KashFlow records with the same numbers:
//
//   quoteNumber   → REST quote   (Number)   value and client should agree
//   projectNumber → REST project (Number)   client should agree
//   invoiceNumber → REST invoice (Number)   should be on the same project
//
// The other half of the double entry is the reverse check: KashFlow quotes
// and projects in the period that have no register row.
//
// buildRegister and the helpers above it are pure, so the matching and the
// filters can be tested without a database.
import mongoose from 'mongoose';
import mdb from './mongooseDatabaseService.js';
import taxService from '../../services/taxService.js';
import logger from '../../services/loggerService.js';
import kfSession from '../../services/kashflowSessionService.js';

export const STAGES = ['toQuote', 'quoted', 'won', 'completed', 'invoiced', 'cancelled'];
export const STAGE_LABELS = {
  toQuote: 'To survey / quote', quoted: 'Quoted', won: 'Won', completed: 'Completed', invoiced: 'Invoiced', cancelled: 'Cancelled',
};
export const QUOTE_STATUSES = ['toQuote', 'quoted'];
// The stage filter also offers the double-entry checks
export const STAGE_FILTERS = ['all', ...STAGES, 'unmatched', 'differs'];
const VALUE_TOLERANCE = 0.01;
const UNREGISTERED_LIMIT = 50;

/**
 * to survey / quote → quoted → won (marked won, or has a project) →
 * completed → invoiced (has an invoice); cancelled overrides.
 */
export function stageOf(entry) {
  if (entry.cancelled) return 'cancelled';
  if (entry.invoiceNumber != null) return 'invoiced';
  if (entry.completed) return 'completed';
  if (entry.projectNumber != null || entry.won) return 'won';
  if (entry.quoteStatus === 'toQuote') return 'toQuote';
  return 'quoted';
}

/** A client name as a filter key: "Plus dane " and "Plus Dane" are one client. */
export function clientKey(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The date a row belongs to: when it was won, else when it was quoted. */
export function entryDate(entry) {
  return entry.jobDate || entry.quoteDate || entry.createdAt || null;
}

/** The UK tax year (starting year) a date falls in. */
export function taxYearOf(date) {
  if (!date) return null;
  const d = new Date(date);
  const y = d.getUTCFullYear();
  return d >= taxService.getTaxYearStartEnd(y).start ? y : y - 1;
}

const differsBy = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) > VALUE_TOLERANCE;

/**
 * Check one register row against its KashFlow records.
 * Each side is { state: 'ok' | 'missing' | 'differs' | 'none', record, issues[] }:
 * 'none' when the row has no number for it yet, 'missing' when the number
 * isn't in KashFlow (not entered there yet, or not synced).
 */
export function matchEntry(entry, { quote = null, project = null, invoice = null } = {}) {
  const side = (number, record, check) => {
    if (number == null) return { state: 'none', record: null, issues: [] };
    if (!record) return { state: 'missing', record: null, issues: [] };
    const issues = check(record);
    return { state: issues.length ? 'differs' : 'ok', record, issues };
  };
  // By customer code where both have one, else by name
  const clientIssue = (r) => {
    if (entry.customerCode && r.CustomerCode) {
      return String(r.CustomerCode).trim().toUpperCase() !== String(entry.customerCode).trim().toUpperCase()
        ? [`Client in KashFlow is ${r.CustomerName || r.CustomerCode}`] : [];
    }
    return r.CustomerName && clientKey(r.CustomerName) !== clientKey(entry.client) ? [`Client in KashFlow is ${r.CustomerName}`] : [];
  };

  const q = side(entry.quoteNumber, quote, (r) => [
    ...(differsBy(entry.value, r.NetAmount) ? [`Value in KashFlow is £${Number(r.NetAmount).toFixed(2)}`] : []),
    ...clientIssue(r),
  ]);
  const p = side(entry.projectNumber, project, (r) => clientIssue(r));
  const i = side(entry.invoiceNumber, invoice, (r) => [
    ...(r.ProjectNumber && entry.projectNumber != null && Number(r.ProjectNumber) !== Number(entry.projectNumber)
      ? [`Invoice is on project ${r.ProjectNumber} in KashFlow`] : []),
    ...clientIssue(r),
  ]);
  const sides = [q, p, i];
  return {
    quote: q,
    project: p,
    invoice: i,
    missing: sides.some((s) => s.state === 'missing'),
    differs: sides.some((s) => s.state === 'differs'),
  };
}

/**
 * The register page: rows with their KashFlow checks, filtered.
 *
 * @param {object}   p
 * @param {object[]} p.entries          register rows (lean)
 * @param {Map}      p.quotesByNumber   KashFlow quote Number → quote
 * @param {Map}      p.projectsByNumber KashFlow project Number → project
 * @param {Map}      p.invoicesByNumber KashFlow invoice Number → invoice
 * @param {object}   [p.filters]        { stage, client, year, q }
 */
export function buildRegister({ entries, quotesByNumber, projectsByNumber, invoicesByNumber, filters = {} }) {
  const stage = STAGE_FILTERS.includes(filters.stage) ? filters.stage : 'all';
  const client = clientKey(filters.client);
  const year = Number.isInteger(filters.year) ? filters.year : null;
  const q = String(filters.q || '').trim().toLowerCase();

  const all = entries.map((e) => {
    const match = matchEntry(e, {
      quote: e.quoteNumber != null ? quotesByNumber.get(Number(e.quoteNumber)) : null,
      project: e.projectNumber != null ? projectsByNumber.get(Number(e.projectNumber)) : null,
      invoice: e.invoiceNumber != null ? invoicesByNumber.get(Number(e.invoiceNumber)) : null,
    });
    return { entry: e, stage: stageOf(e), match, clientKey: clientKey(e.client), taxYear: taxYearOf(entryDate(e)) };
  });

  // Clients by key, shown with the spelling used most often
  const spellings = new Map();
  for (const r of all) {
    if (!r.clientKey) continue;
    const m = spellings.get(r.clientKey) || new Map();
    const name = String(r.entry.client).trim().replace(/\s+/g, ' ');
    m.set(name, (m.get(name) || 0) + 1);
    spellings.set(r.clientKey, m);
  }
  const clients = [...spellings.entries()]
    .map(([key, m]) => ({ key, name: [...m.entries()].sort((a, b) => b[1] - a[1])[0][0], variants: m.size }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const years = [...new Set(all.map((r) => r.taxYear).filter((y) => y != null))].sort((a, b) => b - a);

  // Year and client narrow everything, including the stage counts
  const inScope = all.filter((r) => (year == null || r.taxYear === year) && (!client || r.clientKey === client));
  const counts = { all: inScope.length, unmatched: 0, differs: 0 };
  for (const s of STAGES) counts[s] = 0;
  for (const r of inScope) {
    counts[r.stage]++;
    if (r.stage !== 'cancelled' && r.match.missing) counts.unmatched++;
    if (r.stage !== 'cancelled' && r.match.differs) counts.differs++;
  }

  const rows = inScope.filter((r) => {
    if (stage === 'unmatched' && (r.stage === 'cancelled' || !r.match.missing)) return false;
    if (stage === 'differs' && (r.stage === 'cancelled' || !r.match.differs)) return false;
    if (STAGES.includes(stage) && r.stage !== stage) return false;
    if (q) {
      const hay = [r.entry.site, r.entry.client, r.entry.contact, r.entry.description, r.entry.clientRef,
        r.entry.quoteNumber, r.entry.projectNumber, r.entry.invoiceNumber].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => (Number(b.entry.projectNumber ?? b.entry.quoteNumber ?? 0) - Number(a.entry.projectNumber ?? a.entry.quoteNumber ?? 0))
    || (Number(b.entry.quoteNumber ?? 0) - Number(a.entry.quoteNumber ?? 0)));

  const sum = (list, pick) => list.reduce((t, r) => t + (Number(pick(r)) || 0), 0);
  const live = rows.filter((r) => r.stage !== 'cancelled');
  const totals = {
    value: sum(live, (r) => r.entry.value),
    won: sum(live.filter((r) => r.stage === 'won'), (r) => r.entry.value),
    invoiced: sum(live.filter((r) => r.stage === 'invoiced'), (r) => r.entry.value),
  };

  return { rows, counts, clients, years, totals, filters: { stage, client, year, q: filters.q || '' } };
}

/**
 * KashFlow quotes and projects with no register row: the other side of the
 * double entry. `numbers` are the register's quote and project numbers.
 */
export function findUnregistered({ quotes, projects, quoteNumbers, projectNumbers }) {
  return {
    quotes: quotes.filter((r) => r.Number != null && !quoteNumbers.has(Number(r.Number))),
    projects: projects.filter((r) => r.Number != null && !projectNumbers.has(Number(r.Number))),
  };
}

/** The next number after both the register's and KashFlow's highest. */
export function nextNumber(...lists) {
  const max = Math.max(0, ...lists.flat().map(Number).filter(Number.isFinite));
  return max > 0 ? max + 1 : null;
}

// ── KashFlow next available numbers ─────────────────────────────────────

const KF_NEXT_TIMEOUT_MS = 5000;
const KF_NEXT_PATHS = { quote: '/nextavailablequotenumber', project: '/nextavailableprojectnumber' };

/**
 * A number from a KashFlow next-available response. The spec doesn't give its
 * shape, so this accepts a bare number or numeric string, or an object with
 * the number in Number / NextNumber / NextAvailableNumber / Value / Data.
 * Anything else is null.
 */
export function parseNextAvailable(data) {
  if (data == null) return null;
  if (typeof data === 'number' || typeof data === 'string') {
    const s = String(data).trim().replace(/^"|"$/g, '');
    const n = Number(s);
    return /^\d+$/.test(s) && n > 0 ? n : null;
  }
  if (typeof data === 'object') {
    for (const k of ['Number', 'NextNumber', 'NextAvailableNumber', 'Value', 'Data']) {
      if (k in data) return parseNextAvailable(data[k]);
    }
  }
  return null;
}

/**
 * KashFlow's own next quote and project numbers, asked for live. Either is
 * null when KashFlow can't be reached or answers with something unexpected,
 * so the page can fall back to the synced copy.
 */
export async function kashflowNextNumbers() {
  const base = (process.env.KASHFLOW_API_BASE_URL || 'https://api.kashflow.com/v2').replace(/\/+$/, '');
  const ask = async (kind) => {
    try {
      const data = await kfSession.withKfAuth(async (token) => {
        const resp = await kfSession.kfAxios.get(`${base}${KF_NEXT_PATHS[kind]}`, {
          headers: { Authorization: `KfToken ${token}` },
          timeout: KF_NEXT_TIMEOUT_MS,
        });
        return resp.data;
      });
      const n = parseNextAvailable(data);
      if (n == null) logger.warn(`[jobRegisterService] KashFlow next ${kind} number came back as ${JSON.stringify(data)?.slice(0, 100)}`);
      return n;
    } catch (err) {
      logger.warn(`[jobRegisterService] Couldn't get the next ${kind} number from KashFlow: ${err.message}`);
      return null;
    }
  };
  const [quote, project] = await Promise.all([ask('quote'), ask('project')]);
  return { quote, project };
}

/**
 * The number to suggest: KashFlow's next, unless the register already holds
 * that number or a later one (entered here before KashFlow), when it's one
 * past the register's highest. Without KashFlow, one past the highest of the
 * register and the synced copy. `source` says which the page is showing.
 */
export function suggestNext({ kashflow = null, register = [], synced = [] }) {
  const afterRegister = nextNumber(register);
  if (kashflow != null) {
    return { number: Math.max(kashflow, afterRegister ?? 0), source: 'kashflow' };
  }
  return { number: nextNumber(register, synced), source: 'sync' };
}

function combineNext({ entries, kf, topQuote, topProject }) {
  const nums = (k) => entries.map((e) => e[k]).filter((n) => n != null).map(Number);
  const quote = suggestNext({ kashflow: kf.quote, register: nums('quoteNumber'), synced: [topQuote?.Number ?? []].flat() });
  const project = suggestNext({ kashflow: kf.project, register: nums('projectNumber'), synced: [topProject?.Number ?? []].flat() });
  return { quote: quote.number, project: project.number, quoteSource: quote.source, projectSource: project.source };
}

// ── Database ────────────────────────────────────────────────────────────

const byNumber = (docs) => new Map(docs.map((d) => [Number(d.Number), d]));

/** Everything the register page shows. */
export async function loadRegister(filters = {}) {
  const entries = await mdb.INTERNAL.jobRegister.find({}).lean();
  const quoteNumbers = new Set(entries.map((e) => e.quoteNumber).filter((n) => n != null).map(Number));
  const projectNumbers = new Set(entries.map((e) => e.projectNumber).filter((n) => n != null).map(Number));
  const invoiceNumbers = [...new Set(entries.map((e) => e.invoiceNumber).filter((n) => n != null).map(Number))];

  // The reverse check covers the chosen tax year, or the current one
  const year = Number.isInteger(filters.year) ? filters.year : taxService.getCurrentTaxYear();
  const from = taxService.getTaxYearStartEnd(year).start;
  const to = taxService.getTaxYearStartEnd(year + 1).start;

  const Quote = mdb.REST.quote;
  const Project = mdb.REST.project;
  const Invoice = mdb.REST.invoice;
  const [quotes, projects, invoices, periodQuotes, periodProjects, topQuote, topProject, kf] = await Promise.all([
    quoteNumbers.size ? Quote.find({ Number: { $in: [...quoteNumbers] } }).select('uuid Number Date CustomerName CustomerCode NetAmount Status ProjectNumber').lean() : [],
    projectNumbers.size ? Project.find({ Number: { $in: [...projectNumbers] } }).select('uuid Number Name CustomerName CustomerCode Status StartDate').lean() : [],
    invoiceNumbers.length ? Invoice.find({ Number: { $in: invoiceNumbers } }).select('uuid Number IssuedDate CustomerName CustomerCode NetAmount ProjectNumber Status').lean() : [],
    Quote.find({ Date: { $gte: from, $lt: to } }).select('uuid Number Date CustomerName NetAmount Status').sort({ Number: -1 }).lean(),
    Project.find({ StartDate: { $gte: from, $lt: to } }).select('uuid Number Name CustomerName Status StartDate').sort({ Number: -1 }).lean(),
    Quote.findOne({}).sort({ Number: -1 }).select('Number').lean(),
    Project.findOne({}).sort({ Number: -1 }).select('Number').lean(),
    kashflowNextNumbers(),
  ]);

  const register = buildRegister({
    entries,
    quotesByNumber: byNumber(quotes),
    projectsByNumber: byNumber(projects),
    invoicesByNumber: byNumber(invoices),
    filters,
  });
  const unregistered = findUnregistered({ quotes: periodQuotes, projects: periodProjects, quoteNumbers, projectNumbers });
  return {
    ...register,
    unregistered: {
      year,
      quoteCount: unregistered.quotes.length,
      projectCount: unregistered.projects.length,
      quotes: unregistered.quotes.slice(0, UNREGISTERED_LIMIT),
      projects: unregistered.projects.slice(0, UNREGISTERED_LIMIT),
    },
    next: combineNext({ entries, kf, topQuote, topProject }),
    unlinkedCount: entries.filter((e) => !e.customerCode).length,
  };
}

// ── Saving ──────────────────────────────────────────────────────────────

const int = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : NaN;
};
const money = (v) => {
  const s = String(v ?? '').replace(/[£,\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN;
};
const day = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return NaN;
  const d = new Date(`${s}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? NaN : d;
};
const text = (v) => String(v ?? '').trim();
const tick = (v) => v === 'on' || v === 'true' || v === true;

/**
 * A register row from a form body. Blank fields clear (null), so a number or
 * date can be removed again. Throws a 400 with the first problem.
 */
export function parseEntryForm(body = {}) {
  const fields = {
    quoteNumber: int(body.quoteNumber),
    quoteDate: day(body.quoteDate),
    projectNumber: int(body.projectNumber),
    jobDate: day(body.jobDate),
    site: text(body.site),
    customerCode: text(body.customerCode),
    client: text(body.client),
    contact: text(body.contact),
    value: money(body.value),
    description: text(body.description),
    clientRef: text(body.clientRef),
    invoiceNumber: int(body.invoiceNumber),
    invoiceDate: day(body.invoiceDate),
    notes: text(body.notes),
    cancelled: tick(body.cancelled),
    quoteStatus: QUOTE_STATUSES.includes(text(body.quoteStatus)) ? text(body.quoteStatus) : null,
    won: tick(body.won),
    completed: tick(body.completed),
    inKashflow: tick(body.inKashflow),
  };
  const labels = {
    quoteNumber: 'The quote number', projectNumber: 'The project number', invoiceNumber: 'The invoice number',
    quoteDate: 'The quote date', jobDate: 'The job date', invoiceDate: 'The invoice date', value: 'The value',
  };
  for (const [k, label] of Object.entries(labels)) {
    if (Number.isNaN(fields[k])) throw Object.assign(new Error(`${label} isn't valid.`), { status: 400 });
  }
  const contract = text(body.contractUuid);
  fields.contractUuid = contract || null;
  return fields;
}

/**
 * The form as it was typed, shaped like a register row so the form can be
 * shown again (after a Next button) without losing anything. Nothing here is
 * saved; dates that aren't yyyy-mm-dd are dropped so the view can show them.
 */
export function formEcho(body = {}) {
  const keep = ['quoteNumber', 'projectNumber', 'site', 'customerCode', 'client', 'contact', 'value', 'description',
    'clientRef', 'invoiceNumber', 'notes'];
  const entry = Object.fromEntries(keep.map((k) => [k, text(body[k])]));
  for (const k of ['quoteDate', 'jobDate', 'invoiceDate']) {
    const s = text(body[k]);
    entry[k] = /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T12:00:00Z`).getTime()) ? s : '';
  }
  entry.contractId = text(body.contractUuid) ? { uuid: text(body.contractUuid) } : null;
  for (const k of ['cancelled', 'won', 'completed', 'inKashflow']) entry[k] = tick(body[k]);
  entry.quoteStatus = QUOTE_STATUSES.includes(text(body.quoteStatus)) ? text(body.quoteStatus) : '';
  return entry;
}

const DATE_FIELDS = ['quoteDate', 'jobDate', 'invoiceDate'];

/** Today's date in the UK as YYYY-MM-DD. */
export function ukToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(now);
}

/**
 * formEcho with one field filled in, for the Next and Today buttons:
 * fill=quote|project sets that number to `next`'s; fill=<date field> sets it to today.
 */
export function fillNext(body, next, now = new Date()) {
  const entry = formEcho(body);
  if (DATE_FIELDS.includes(body?.fill)) {
    entry[body.fill] = ukToday(now);
    return entry;
  }
  const kind = body?.fill === 'project' ? 'project' : 'quote';
  if (next?.[kind]) entry[`${kind}Number`] = String(next[kind]);
  return entry;
}

async function applyContract(fields) {
  const { contractUuid, ...rest } = fields;
  if (!contractUuid) return { ...rest, contractId: null };
  const c = await mdb.INTERNAL.contract.findOne({ uuid: contractUuid }).select('_id').lean();
  if (!c) throw Object.assign(new Error('That contract no longer exists.'), { status: 400 });
  return { ...rest, contractId: c._id };
}

/** KashFlow customers a row's client can be, by name. */
export async function customerChoices() {
  const docs = await mdb.REST.customer.find({ Code: { $nin: [null, ''] } }).select('Code Name').sort({ Name: 1 }).lean();
  return docs.map((c) => ({ code: String(c.Code).trim(), name: String(c.Name || c.Code).trim() }));
}

/** The customer code on the row's own KashFlow project, quote or invoice (in that order), or ''. */
async function kashflowCustomerCode(fields) {
  for (const [field, Model] of [['projectNumber', mdb.REST.project], ['quoteNumber', mdb.REST.quote], ['invoiceNumber', mdb.REST.invoice]]) {
    if (fields[field] == null || !Model) continue;
    const rec = await Model.findOne({ Number: fields[field] }).select('CustomerCode').lean();
    if (rec?.CustomerCode) return String(rec.CustomerCode).trim();
  }
  return '';
}

/**
 * The chosen customer's code and name onto the fields. With none chosen, the
 * customer on the row's own KashFlow project/quote/invoice is used; a 400 if
 * there's neither, or the code isn't a known customer.
 */
async function applyCustomer(fields) {
  const code = String(fields.customerCode || '').trim() || await kashflowCustomerCode(fields);
  if (!code) throw Object.assign(new Error('Choose the client from the KashFlow customers.'), { status: 400 });
  const c = await mdb.REST.customer.findOne({ Code: code }).select('Code Name').lean();
  if (!c) throw Object.assign(new Error("That client isn't a KashFlow customer (or hasn't synced yet)."), { status: 400 });
  return { ...fields, customerCode: String(c.Code).trim(), client: String(c.Name || c.Code).trim() };
}

function duplicateError(err) {
  if (err?.code !== 11000) return err;
  const key = Object.keys(err.keyPattern || err.keyValue || {})[0];
  const label = key === 'projectNumber' ? 'project' : 'quote';
  return Object.assign(new Error(`That ${label} number is already in the register.`), { status: 400 });
}
function validationError(err) {
  if (err?.name === 'ValidationError') {
    return Object.assign(new Error(Object.values(err.errors)[0]?.message || 'Check the entry.'), { status: 400 });
  }
  if (err instanceof Error && !err.status && /Enter a quote number|needs its project number/.test(err.message)) {
    return Object.assign(err, { status: 400 });
  }
  return err;
}

export async function createEntry(body) {
  const fields = Object.fromEntries(Object.entries(await applyCustomer(await applyContract(parseEntryForm(body))))
    .filter(([, v]) => v !== null && v !== ''));
  try {
    return await mdb.INTERNAL.jobRegister.create(fields);
  } catch (err) {
    throw validationError(duplicateError(err));
  }
}

export async function updateEntry(uuid, body) {
  const doc = await mdb.INTERNAL.jobRegister.findOne({ uuid: String(uuid || '') });
  if (!doc) throw Object.assign(new Error('That register entry no longer exists.'), { status: 404 });
  const fields = await applyCustomer(await applyContract(parseEntryForm(body)));
  // Blank → unset, so the partial unique indexes don't see a null
  for (const [k, v] of Object.entries(fields)) doc.set(k, v === null || v === '' ? undefined : v);
  // A hand edit: a re-import will no longer overwrite this row, only fill it in
  doc.editedAt = new Date();
  try {
    return await doc.save();
  } catch (err) {
    throw validationError(duplicateError(err));
  }
}

export async function findEntry(uuid) {
  return mdb.INTERNAL.jobRegister.findOne({ uuid: String(uuid || '') }).populate('contractId', 'uuid title').lean();
}

/** Contracts a row can be linked to: open ones, plus the one it already has. */
export async function contractChoices(currentId = null) {
  const or = [{ status: { $in: ['Planned', 'In Progress'] } }];
  if (currentId && mongoose.Types.ObjectId.isValid(String(currentId))) or.push({ _id: currentId });
  return mdb.INTERNAL.contract.find({ $or: or }).select('uuid title status').sort({ title: 1 }).lean();
}

// Won but not completed: a project number, not cancelled, not marked
// completed and not invoiced. These are the jobs people can be put on (the
// weekly sheet's choices, the weekly sheet import's matches).
export const OPEN_JOB_FILTER = {
  projectNumber: { $type: 'number' },
  cancelled: { $ne: true },
  completed: { $ne: true },
  invoiceNumber: { $not: { $type: 'number' } },
};
const OPEN_JOB_FIELDS = '_id uuid projectNumber site client contact description contractId';

/** Is this row a won job not yet completed (OPEN_JOB_FILTER)? Pure. */
export function isOpenJob(entry) {
  return !!entry && typeof entry.projectNumber === 'number' && !entry.cancelled && !entry.completed && entry.invoiceNumber == null;
}

/**
 * A job as people know it: main '41234 7 Jasmine Gardens', detail
 * 'Gravel, Plus Dane, Ann' (empty parts left out), and text, the two as one
 * line for where HTML can't go (a <select> option). Pure.
 */
export function jobLabel(job) {
  if (!job) return { main: '', detail: '', text: '' };
  const main = [job.projectNumber, job.site].filter((x) => x != null && String(x).trim()).join(' ');
  const detail = [job.description, job.client, job.contact].map((x) => String(x ?? '').trim()).filter(Boolean).join(', ');
  return { main, detail, text: detail ? `${main} (${detail})` : main };
}

/** Won jobs not yet completed (OPEN_JOB_FILTER), newest project first. */
export async function openJobs() {
  return mdb.INTERNAL.jobRegister.find(OPEN_JOB_FILTER).select(OPEN_JOB_FIELDS).sort({ projectNumber: -1 }).lean();
}

/**
 * The weekly sheet's "jobs for allocation": won jobs not yet completed, with
 * no contract, that no attendance is booked against yet.
 */
export async function jobsForAllocation() {
  const rows = await mdb.INTERNAL.jobRegister.find({ ...OPEN_JOB_FILTER, contractId: { $in: [null] } })
    .select(OPEN_JOB_FIELDS).sort({ projectNumber: -1 }).lean();
  if (!rows.length) return rows;
  const booked = await mdb.INTERNAL.attendance.distinct('jobRegisterId', { jobRegisterId: { $in: rows.map((r) => r._id) } });
  const taken = new Set(booked.filter(Boolean).map(String));
  return rows.filter((r) => !taken.has(String(r._id)));
}

/** The synced KashFlow project for each job's project number: Map of projectNumber → REST project _id. */
export async function projectIdsByNumber(jobs = []) {
  const numbers = [...new Set(jobs.map((j) => j?.projectNumber).filter((n) => typeof n === 'number'))];
  if (!numbers.length || !mdb.REST?.project) return new Map();
  const projects = await mdb.REST.project.find({ Number: { $in: numbers } }).select('_id Number').lean();
  return new Map(projects.map((p) => [Number(p.Number), p._id]));
}

/**
 * What an attendance record on `job` links to: the job, its contract when it
 * has one, and its KashFlow project (the synced one with the job's number,
 * else the contract's). Pure.
 */
export function jobTarget(job, { projectId = null, contract = null } = {}) {
  const out = { jobRegisterId: job._id };
  if (job.contractId) out.contractId = job.contractId._id || job.contractId;
  const project = projectId || contract?.projectId || null;
  if (project) out.projectId = project;
  return out;
}

export default {
  STAGES, STAGE_LABELS, STAGE_FILTERS, QUOTE_STATUSES,
  stageOf, clientKey, entryDate, taxYearOf, matchEntry, buildRegister, findUnregistered, nextNumber, parseEntryForm,
  parseNextAvailable, suggestNext, kashflowNextNumbers, formEcho, fillNext, ukToday,
  loadRegister, createEntry, updateEntry, findEntry, contractChoices, customerChoices, jobsForAllocation,
  OPEN_JOB_FILTER, isOpenJob, jobLabel, openJobs, projectIdsByNumber, jobTarget,
};
