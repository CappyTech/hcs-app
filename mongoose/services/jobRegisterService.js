// Job Register: the plan of what will be in KashFlow, kept as double entry.
//
// Each job is entered here first, then checked against the synced KashFlow
// records with the same numbers:
//
//   projectNumber    → REST project (Number)   client should agree
//   quotes[].number  → REST quote   (Number)   value and client should agree,
//                                              and on the job's project
//   invoices[].number → REST invoice (Number)  value and client should agree,
//                                              and on the job's project
//
// and the KashFlow quotes and invoices on the job's project (ProjectNumber)
// should all be on the job here.
//
// The other half of the double entry is the reverse check: KashFlow quotes
// and projects in the period that aren't in the register.
//
// buildRegister and the helpers above it are pure, so the matching and the
// filters can be tested without a database.
import mongoose from 'mongoose';
import mdb from './mongooseDatabaseService.js';
import taxService from '../../services/taxService.js';
import logger from '../../services/loggerService.js';
import kfSession from '../../services/kashflowSessionService.js';
import lifecycle from './jobRegisterLifecycleService.js';
import { QUOTE_STATUSES, jobProblem } from '../models/mongoose/INTERNAL/jobRegister.js';

export { QUOTE_STATUSES };
export const STAGES = ['toQuote', 'quoted', 'won', 'completed', 'invoiced', 'cancelled'];
export const STAGE_LABELS = {
  toQuote: 'To survey / quote', quoted: 'Quoted', won: 'Won', completed: 'Completed', invoiced: 'Invoiced', cancelled: 'Cancelled',
};
export const QUOTE_STATUS_LABELS = { toQuote: 'To survey / quote', quoted: 'Quoted', won: 'Won', lost: 'Lost' };
// The stage filter also offers the double-entry checks
export const STAGE_FILTERS = ['all', ...STAGES, 'unmatched', 'differs'];
const VALUE_TOLERANCE = 0.01;
const UNREGISTERED_LIMIT = 50;

const quotesOf = (job) => (Array.isArray(job?.quotes) ? job.quotes : []);
const invoicesOf = (job) => (Array.isArray(job?.invoices) ? job.invoices : []);
const numbers = (list) => list.map((x) => x?.number).filter((n) => n != null).map(Number);

/** A job's quote numbers. Pure. */
export const quoteNumbersOf = (job) => numbers(quotesOf(job));
/** A job's invoice numbers. Pure. */
export const invoiceNumbersOf = (job) => numbers(invoicesOf(job));

/**
 * to survey / quote → quoted → won (marked won, a won quote, or a project
 * number) → completed → invoiced (completed with an invoice); cancelled
 * overrides. A live job with stage payments invoiced stays won. A job whose
 * quotes were all lost counts as cancelled.
 */
export function stageOf(job) {
  if (job.cancelled) return 'cancelled';
  const quotes = quotesOf(job);
  if (job.completed && invoicesOf(job).length) return 'invoiced';
  if (job.completed) return 'completed';
  if (job.projectNumber != null || job.won || quotes.some((q) => q.status === 'won')) return 'won';
  if (quotes.some((q) => q.status === 'quoted')) return 'quoted';
  if (quotes.length && quotes.every((q) => q.status === 'lost')) return 'cancelled';
  return 'toQuote';
}

const sumOf = (list) => list.reduce((t, x) => t + (Number(x?.value) || 0), 0);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * A job's money, net. quoted: its quotes not lost (or, with no quotes, its
 * agreed value). agreed: what it's worth once won: its won quotes; if it's
 * won with no quote marked won, every quote not lost; with no quotes, its
 * agreed value. invoiced: its invoices; an invoice with no value is taken to
 * cover the rest of the agreed value. Pure.
 */
export function jobValues(job) {
  const quotes = quotesOf(job);
  const live = quotes.filter((q) => q.status !== 'lost');
  const wonQuotes = quotes.filter((q) => q.status === 'won');
  const jobValue = Number(job.value) || 0;
  const quoted = quotes.length ? sumOf(live) : jobValue;
  let agreed = 0;
  if (!quotes.length) agreed = jobValue;
  else if (wonQuotes.length) agreed = sumOf(wonQuotes);
  else if (job.projectNumber != null || job.won) agreed = sumOf(live);
  const invoices = invoicesOf(job);
  const valued = sumOf(invoices.filter((i) => i.value != null));
  const invoiced = invoices.some((i) => i.value == null) ? Math.max(valued, agreed) : valued;
  return { quoted: round2(quoted), agreed: round2(agreed), invoiced: round2(invoiced) };
}

/** A client name as a filter key: "Plus dane " and "Plus Dane" are one client. */
export function clientKey(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The date a job belongs to: when it was won, else when it was first quoted. */
export function entryDate(job) {
  if (job.jobDate) return job.jobDate;
  const dates = quotesOf(job).map((q) => q.date).filter(Boolean).map((d) => new Date(d)).sort((a, b) => a - b);
  return dates[0] || job.createdAt || null;
}

/** The UK tax year (starting year) a date falls in. */
export function taxYearOf(date) {
  if (!date) return null;
  const d = new Date(date);
  const y = d.getUTCFullYear();
  return d >= taxService.getTaxYearStartEnd(y).start ? y : y - 1;
}

/** The number a job sorts and is known by: its project number, else its highest quote number. Pure. */
export function jobNumber(job) {
  if (job?.projectNumber != null) return Number(job.projectNumber);
  const q = quoteNumbersOf(job);
  return q.length ? Math.max(...q) : null;
}

/** "Job 41234" or "Quote 51234" (an enquiry), for titles and flashes. Pure. */
export function jobTitle(job) {
  if (job?.projectNumber != null) return `Job ${job.projectNumber}`;
  const q = quoteNumbersOf(job);
  return q.length ? `Quote ${Math.max(...q)}` : 'Job';
}

const differsBy = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) > VALUE_TOLERANCE;
const money2 = (v) => `£${Number(v).toFixed(2)}`;

/**
 * The issue when a KashFlow quote or invoice isn't on the job's project:
 * "Quote 51234 isn't on job 41012 in KashFlow (it's on job 41000)", or
 * "... isn't on a job in KashFlow". None for an enquiry (no project number
 * yet) or when it is on the job. Pure.
 */
export function jobIssue(what, number, job, record) {
  if (job?.projectNumber == null || !record) return [];
  const on = Number(record.ProjectNumber) || null;
  if (on === Number(job.projectNumber)) return [];
  const name = `${what} ${number}`;
  return on
    ? [`${name} isn't on job ${job.projectNumber} in KashFlow (it's on job ${on})`]
    : [`${name} isn't on a job in KashFlow`];
}

/**
 * The synced KashFlow quotes and invoices on the job's project that aren't
 * on the job here. `onJob` is { quotes, invoices }: REST records whose
 * ProjectNumber is the job's (any others are ignored). None for an enquiry. Pure.
 */
export function kashflowExtras(job, { quotes = [], invoices = [] } = {}) {
  if (job?.projectNumber == null) return { quotes: [], invoices: [] };
  const pn = Number(job.projectNumber);
  const mine = (list, have) => {
    const seen = new Set(have);
    return (list || []).filter((r) => {
      if (r?.Number == null || Number(r.ProjectNumber) !== pn || seen.has(Number(r.Number))) return false;
      seen.add(Number(r.Number));
      return true;
    }).sort((a, b) => Number(a.Number) - Number(b.Number));
  };
  return { quotes: mine(quotes, quoteNumbersOf(job)), invoices: mine(invoices, invoiceNumbersOf(job)) };
}

/**
 * Check one job against its KashFlow records.
 * Each side is { state: 'ok' | 'missing' | 'differs' | 'none', record, issues[], number, id }:
 * 'none' when there's no number for it yet, 'missing' when the number isn't
 * in KashFlow (not entered there yet, or not synced). quotes and invoices
 * have one side each, in the job's order. extras are the KashFlow quotes and
 * invoices on the job's project that aren't on the job (from `onJob`, see
 * kashflowExtras); extra is true when there are any. differs counts both.
 */
export function matchJob(job, { project = null, quotesByNumber = new Map(), invoicesByNumber = new Map(), onJob = {} } = {}) {
  const side = (number, record, check, id = null) => {
    const base = { number: number ?? null, id: id != null ? String(id) : null };
    if (number == null) return { ...base, state: 'none', record: null, issues: [] };
    if (!record) return { ...base, state: 'missing', record: null, issues: [] };
    const issues = check(record);
    return { ...base, state: issues.length ? 'differs' : 'ok', record, issues };
  };
  // By customer code where both have one, else by name
  const clientIssue = (r) => {
    if (job.customerCode && r.CustomerCode) {
      return String(r.CustomerCode).trim().toUpperCase() !== String(job.customerCode).trim().toUpperCase()
        ? [`Client in KashFlow is ${r.CustomerName || r.CustomerCode}`] : [];
    }
    return r.CustomerName && clientKey(r.CustomerName) !== clientKey(job.client) ? [`Client in KashFlow is ${r.CustomerName}`] : [];
  };
  const get = (map, n) => (n != null ? map.get(Number(n)) || null : null);

  const quotes = quotesOf(job).map((q) => side(q.number, get(quotesByNumber, q.number), (r) => [
    ...jobIssue('Quote', q.number, job, r),
    ...(differsBy(q.value, r.NetAmount) ? [`Value in KashFlow is ${money2(r.NetAmount)}`] : []),
    ...clientIssue(r),
  ], q._id));
  const p = side(job.projectNumber, project, (r) => clientIssue(r));
  const invoices = invoicesOf(job).map((i) => side(i.number, get(invoicesByNumber, i.number), (r) => [
    ...jobIssue('Invoice', i.number, job, r),
    ...(differsBy(i.value, r.NetAmount) ? [`Value in KashFlow is ${money2(r.NetAmount)}`] : []),
    ...clientIssue(r),
  ], i._id));
  const extras = kashflowExtras(job, onJob);
  const extra = extras.quotes.length + extras.invoices.length > 0;
  const sides = [...quotes, p, ...invoices];
  return {
    project: p,
    quotes,
    invoices,
    extras,
    extra,
    missing: sides.some((s) => s.state === 'missing'),
    differs: extra || sides.some((s) => s.state === 'differs'),
  };
}

/** REST records grouped by ProjectNumber: Map of number → records. Pure. */
export function byProject(docs = []) {
  const m = new Map();
  for (const d of docs) {
    const n = Number(d?.ProjectNumber);
    if (!n) continue;
    if (!m.has(n)) m.set(n, []);
    m.get(n).push(d);
  }
  return m;
}

/**
 * The register page: jobs with their KashFlow checks, filtered.
 *
 * @param {object}   p
 * @param {object[]} p.entries          jobs (lean)
 * @param {Map}      p.quotesByNumber   KashFlow quote Number → quote
 * @param {Map}      p.projectsByNumber KashFlow project Number → project
 * @param {Map}      p.invoicesByNumber KashFlow invoice Number → invoice
 * @param {Map}      [p.quotesByProject]   KashFlow ProjectNumber → quotes on it
 * @param {Map}      [p.invoicesByProject] KashFlow ProjectNumber → invoices on it
 * @param {object}   [p.filters]        { stage, client, year, q }
 */
export function buildRegister({ entries, quotesByNumber, projectsByNumber, invoicesByNumber, quotesByProject = new Map(), invoicesByProject = new Map(), filters = {} }) {
  const stage = STAGE_FILTERS.includes(filters.stage) ? filters.stage : 'all';
  const client = clientKey(filters.client);
  const year = Number.isInteger(filters.year) ? filters.year : null;
  const q = String(filters.q || '').trim().toLowerCase();

  const all = entries.map((e) => {
    const match = matchJob(e, {
      project: e.projectNumber != null ? projectsByNumber.get(Number(e.projectNumber)) || null : null,
      quotesByNumber,
      invoicesByNumber,
      onJob: e.projectNumber != null
        ? { quotes: quotesByProject.get(Number(e.projectNumber)) || [], invoices: invoicesByProject.get(Number(e.projectNumber)) || [] }
        : {},
    });
    return { entry: e, stage: stageOf(e), match, values: jobValues(e), clientKey: clientKey(e.client), taxYear: taxYearOf(entryDate(e)) };
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

  const topQuote = (e) => Math.max(0, ...quoteNumbersOf(e));
  const rows = inScope.filter((r) => {
    if (stage === 'unmatched' && (r.stage === 'cancelled' || !r.match.missing)) return false;
    if (stage === 'differs' && (r.stage === 'cancelled' || !r.match.differs)) return false;
    if (STAGES.includes(stage) && r.stage !== stage) return false;
    if (q) {
      const e = r.entry;
      const hay = [e.site, e.client, e.contact, e.description, e.clientRef, e.projectNumber,
        ...quotesOf(e).flatMap((x) => [x.number, x.description]), ...invoiceNumbersOf(e)].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => ((jobNumber(b.entry) ?? 0) - (jobNumber(a.entry) ?? 0)) || (topQuote(b.entry) - topQuote(a.entry)));

  const live = rows.filter((r) => r.stage !== 'cancelled');
  const total = (list, k) => round2(list.reduce((t, r) => t + r.values[k], 0));
  const totals = {
    quoted: total(live, 'quoted'),
    won: total(live.filter((r) => ['won', 'completed', 'invoiced'].includes(r.stage)), 'agreed'),
    invoiced: total(live, 'invoiced'),
  };

  return { rows, counts, clients, years, totals, filters: { stage, client, year, q: filters.q || '' } };
}

/**
 * KashFlow quotes and projects with no register job: the other side of the
 * double entry. `quoteNumbers` and `projectNumbers` are the register's.
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
  const quote = suggestNext({ kashflow: kf.quote, register: entries.flatMap(quoteNumbersOf), synced: [topQuote?.Number ?? []].flat() });
  const projectNumbers = entries.map((e) => e.projectNumber).filter((n) => n != null).map(Number);
  const project = suggestNext({ kashflow: kf.project, register: projectNumbers, synced: [topProject?.Number ?? []].flat() });
  return { quote: quote.number, project: project.number, quoteSource: quote.source, projectSource: project.source };
}

// ── Database ────────────────────────────────────────────────────────────

const byNumber = (docs) => new Map(docs.map((d) => [Number(d.Number), d]));
const QUOTE_FIELDS = 'uuid Number Date CustomerName CustomerCode NetAmount Status ProjectNumber';
const INVOICE_FIELDS = 'uuid Number IssuedDate CustomerName CustomerCode NetAmount ProjectNumber Status';

/**
 * One query's filter for REST records with these numbers or on these
 * projects (ProjectNumber), or null when there are neither. Pure.
 */
export function numbersOrProjects(numbers = [], projectNumbers = []) {
  const or = [];
  if (numbers.length) or.push({ Number: { $in: numbers } });
  if (projectNumbers.length) or.push({ ProjectNumber: { $in: projectNumbers } });
  if (!or.length) return null;
  return or.length === 1 ? or[0] : { $or: or };
}

/** Everything the register page shows. */
export async function loadRegister(filters = {}) {
  const entries = await mdb.INTERNAL.jobRegister.find({}).lean();
  const quoteNumbers = new Set(entries.flatMap(quoteNumbersOf));
  const projectNumbers = new Set(entries.map((e) => e.projectNumber).filter((n) => n != null).map(Number));
  const invoiceNumbers = [...new Set(entries.flatMap(invoiceNumbersOf))];

  // The reverse check covers the chosen tax year, or the current one
  const year = Number.isInteger(filters.year) ? filters.year : taxService.getCurrentTaxYear();
  const from = taxService.getTaxYearStartEnd(year).start;
  const to = taxService.getTaxYearStartEnd(year + 1).start;

  const Quote = mdb.REST.quote;
  const Project = mdb.REST.project;
  const Invoice = mdb.REST.invoice;
  // Each job's own quotes and invoices, and every one on a job's project, in one query each
  const quoteQuery = numbersOrProjects([...quoteNumbers], [...projectNumbers]);
  const invoiceQuery = numbersOrProjects(invoiceNumbers, [...projectNumbers]);
  const [quotes, projects, invoices, periodQuotes, periodProjects, topQuote, topProject, kf] = await Promise.all([
    quoteQuery ? Quote.find(quoteQuery).select(QUOTE_FIELDS).lean() : [],
    projectNumbers.size ? Project.find({ Number: { $in: [...projectNumbers] } }).select('uuid Number Name CustomerName CustomerCode Status StartDate').lean() : [],
    invoiceQuery ? Invoice.find(invoiceQuery).select(INVOICE_FIELDS).lean() : [],
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
    quotesByProject: byProject(quotes),
    invoicesByProject: byProject(invoices),
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

/**
 * One job's page: the job with its KashFlow checks, values and stage, and
 * the next numbers for its forms. Null if there's no such job. Each of
 * match.extras (KashFlow quotes/invoices on the job's project, not on the
 * job) carries elsewhere: { uuid, title } when another job here has it.
 */
export async function loadJob(uuid) {
  const job = await findEntry(uuid);
  if (!job) return null;
  const quoteNumbers = quoteNumbersOf(job);
  const invoiceNumbers = invoiceNumbersOf(job);
  const onProject = job.projectNumber != null ? [Number(job.projectNumber)] : [];
  const quoteQuery = numbersOrProjects(quoteNumbers, onProject);
  const invoiceQuery = numbersOrProjects(invoiceNumbers, onProject);
  const [quotes, project, invoices, topQuote, topProject, others, kf] = await Promise.all([
    quoteQuery ? mdb.REST.quote.find(quoteQuery).select(QUOTE_FIELDS).lean() : [],
    job.projectNumber != null ? mdb.REST.project.findOne({ Number: job.projectNumber }).select('uuid Number Name CustomerName CustomerCode Status StartDate').lean() : null,
    invoiceQuery ? mdb.REST.invoice.find(invoiceQuery).select(INVOICE_FIELDS).lean() : [],
    mdb.REST.quote.findOne({}).sort({ Number: -1 }).select('Number').lean(),
    mdb.REST.project.findOne({}).sort({ Number: -1 }).select('Number').lean(),
    mdb.INTERNAL.jobRegister.find({}).select('uuid projectNumber quotes.number invoices.number').lean(),
    kashflowNextNumbers(),
  ]);
  const onJob = { quotes: byProject(quotes).get(onProject[0]) || [], invoices: byProject(invoices).get(onProject[0]) || [] };
  const match = matchJob(job, { project, quotesByNumber: byNumber(quotes), invoicesByNumber: byNumber(invoices), onJob });
  match.extras = markElsewhere(match.extras, others, job.uuid);
  return {
    job,
    stage: stageOf(job),
    values: jobValues(job),
    match,
    next: combineNext({ entries: others, kf, topQuote, topProject }),
  };
}

/** extras with elsewhere: { uuid, title } on each that another job (not `uuid`) has. Pure. */
export function markElsewhere(extras, jobs = [], uuid = null) {
  const holder = (kind, n) => jobs.find((j) => j.uuid !== uuid
    && (kind === 'quote' ? quoteNumbersOf(j) : invoiceNumbersOf(j)).includes(Number(n)));
  const mark = (kind) => (r) => {
    const j = holder(kind, r.Number);
    return j ? { ...r, elsewhere: { uuid: j.uuid, title: jobTitle(j) } } : r;
  };
  return { quotes: (extras?.quotes || []).map(mark('quote')), invoices: (extras?.invoices || []).map(mark('invoice')) };
}

// ── Forms ───────────────────────────────────────────────────────────────

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
const bad = (message) => Object.assign(new Error(message), { status: 400 });
const notFound = (message) => Object.assign(new Error(message), { status: 404 });

function refuseNaN(fields, labels) {
  for (const [k, label] of Object.entries(labels)) {
    if (Number.isNaN(fields[k])) throw bad(`${label} isn't valid.`);
  }
}

/**
 * A job's own fields from a form body (not its quotes or invoices). Blank
 * fields clear (null), so a number or date can be removed again. Throws a
 * 400 with the first problem.
 */
export function parseJobForm(body = {}) {
  const fields = {
    projectNumber: int(body.projectNumber),
    jobDate: day(body.jobDate),
    site: text(body.site),
    customerCode: text(body.customerCode),
    client: text(body.client),
    contact: text(body.contact),
    value: money(body.value),
    description: text(body.description),
    clientRef: text(body.clientRef),
    notes: text(body.notes),
    cancelled: tick(body.cancelled),
    won: tick(body.won),
    completed: tick(body.completed),
    inKashflow: tick(body.inKashflow),
  };
  refuseNaN(fields, { projectNumber: 'The project number', jobDate: 'The job date', value: 'The value' });
  fields.contractUuid = text(body.contractUuid) || null;
  return fields;
}

/** One quote from a form body: number, date, value, description, status, notes. Throws a 400. */
export function parseQuoteLine(body = {}) {
  const fields = {
    number: int(body.number),
    date: day(body.date),
    value: money(body.value),
    description: text(body.description).slice(0, 300),
    status: QUOTE_STATUSES.includes(text(body.status)) ? text(body.status) : 'quoted',
    notes: text(body.notes).slice(0, 2000),
  };
  refuseNaN(fields, { number: 'The quote number', date: 'The quote date', value: 'The quote value' });
  return fields;
}

/** One invoice from a form body: number (needed), date, value, notes. Throws a 400. */
export function parseInvoiceLine(body = {}) {
  const fields = {
    number: int(body.number),
    date: day(body.date),
    value: money(body.value),
    notes: text(body.notes).slice(0, 2000),
  };
  refuseNaN(fields, { number: 'The invoice number', date: 'The invoice date', value: 'The invoice value' });
  if (fields.number == null) throw bad('Enter the invoice number.');
  return fields;
}

/**
 * The add form's first quote: quoteNumber, quoteDate, quoteStatus and the
 * form's value and description. Null when no quote number was given (a
 * job-only row, whose value stays on the job).
 */
function addFormQuote(body, job) {
  if (!text(body.quoteNumber)) {
    if (text(body.quoteDate)) parseQuoteLine({ date: body.quoteDate }); // still refuse a bad date
    return null;
  }
  const quote = parseQuoteLine({
    number: body.quoteNumber, date: body.quoteDate, value: body.value, description: body.description, status: body.quoteStatus,
  });
  // A job entered as won (a project number, or ticked) has its quote won
  if ((job.projectNumber != null || job.won) && (quote.status === 'toQuote' || quote.status === 'quoted')) quote.status = 'won';
  return quote;
}

/**
 * The add form as it was typed, shaped like the form's fields so it can be
 * shown again (after a Next button) without losing anything. Nothing here is
 * saved; dates that aren't yyyy-mm-dd are dropped so the view can show them.
 */
export function formEcho(body = {}) {
  const keep = ['quoteNumber', 'projectNumber', 'site', 'customerCode', 'client', 'contact', 'value', 'description',
    'clientRef', 'notes'];
  const entry = Object.fromEntries(keep.map((k) => [k, text(body[k])]));
  for (const k of DATE_FIELDS) {
    const s = text(body[k]);
    entry[k] = /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T12:00:00Z`).getTime()) ? s : '';
  }
  entry.contractId = text(body.contractUuid) ? { uuid: text(body.contractUuid) } : null;
  for (const k of ['cancelled', 'won', 'completed', 'inKashflow']) entry[k] = tick(body[k]);
  entry.quoteStatus = QUOTE_STATUSES.includes(text(body.quoteStatus)) ? text(body.quoteStatus) : '';
  return entry;
}

const DATE_FIELDS = ['quoteDate', 'jobDate'];

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
  if (!c) throw bad('That contract no longer exists.');
  return { ...rest, contractId: c._id };
}

/** KashFlow customers a job's client can be, by name. */
export async function customerChoices() {
  const docs = await mdb.REST.customer.find({ Code: { $nin: [null, ''] } }).select('Code Name').sort({ Name: 1 }).lean();
  return docs.map((c) => ({ code: String(c.Code).trim(), name: String(c.Name || c.Code).trim() }));
}

/** The customer code on the job's own KashFlow project, quotes or invoices (in that order), or ''. */
async function kashflowCustomerCode({ projectNumber = null, quoteNumbers = [], invoiceNumbers = [] }) {
  const tries = [
    ...(projectNumber != null ? [[mdb.REST.project, projectNumber]] : []),
    ...quoteNumbers.map((n) => [mdb.REST.quote, n]),
    ...invoiceNumbers.map((n) => [mdb.REST.invoice, n]),
  ];
  for (const [Model, number] of tries) {
    if (!Model) continue;
    const rec = await Model.findOne({ Number: number }).select('CustomerCode').lean();
    if (rec?.CustomerCode) return String(rec.CustomerCode).trim();
  }
  return '';
}

/**
 * The chosen customer's code and name onto the fields. With none chosen, the
 * customer on the job's own KashFlow project/quote/invoice is used; a 400 if
 * there's neither, or the code isn't a known customer.
 */
async function applyCustomer(fields, numbersFrom = {}) {
  const code = String(fields.customerCode || '').trim()
    || await kashflowCustomerCode({ projectNumber: fields.projectNumber, ...numbersFrom });
  if (!code) throw bad('Choose the client from the KashFlow customers.');
  const c = await mdb.REST.customer.findOne({ Code: code }).select('Code Name').lean();
  if (!c) throw bad("That client isn't a KashFlow customer (or hasn't synced yet).");
  return { ...fields, customerCode: String(c.Code).trim(), client: String(c.Name || c.Code).trim() };
}

function duplicateError(err) {
  if (err?.code !== 11000) return err;
  const key = Object.keys(err.keyPattern || err.keyValue || {})[0] || '';
  const label = key === 'projectNumber' ? 'project' : key.startsWith('quotes') ? 'quote' : 'quote';
  return bad(`That ${label} number is already in the register.`);
}
function validationError(err) {
  if (err?.name === 'ValidationError') {
    return bad(Object.values(err.errors)[0]?.message || 'Check the entry.');
  }
  if (err?.name === 'CastError') return bad('Check the entry.');
  if (err instanceof Error && !err.status && /Enter a quote number|needs its project number|on this job twice/.test(err.message)) {
    return Object.assign(err, { status: 400 });
  }
  return err;
}
const saveError = (err) => validationError(duplicateError(err));

const drop = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== ''));

/** POST /job-register: a new job, with its first quote when a quote number is given. */
export async function createEntry(body = {}) {
  const job = parseJobForm(body);
  const quote = addFormQuote(body, job);
  const fields = drop(await applyCustomer(await applyContract(job), { quoteNumbers: quote?.number != null ? [quote.number] : [] }));
  // A job with a quote is worth its quote: the form's value went on it
  if (quote) delete fields.value;
  fields.quotes = quote ? [drop(quote)] : [];
  let doc;
  try {
    doc = await mdb.INTERNAL.jobRegister.create(fields);
  } catch (err) {
    throw saveError(err);
  }
  if (quote) await lifecycle.fireQuoteAdded(doc, doc.quotes?.[0] || quote);
  await lifecycle.fireStageHooks(null, doc);
  return doc;
}

/** POST /job-register/:uuid: the job's own fields. */
export async function updateEntry(uuid, body) {
  const doc = await mdb.INTERNAL.jobRegister.findOne({ uuid: String(uuid || '') });
  if (!doc) throw notFound('That register entry no longer exists.');
  const before = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  const fields = await applyCustomer(await applyContract(parseJobForm(body)), {
    quoteNumbers: quoteNumbersOf(doc), invoiceNumbers: invoiceNumbersOf(doc),
  });
  // A job with quotes is worth its quotes, not a value of its own
  if (quotesOf(doc).length && fields.value == null) delete fields.value;
  // Blank → unset, so the partial unique indexes don't see a null
  for (const [k, v] of Object.entries(fields)) doc.set(k, v === null || v === '' ? undefined : v);
  // Won now: a lone quote still open is the one that was won
  const open = quotesOf(doc).filter((q) => q.status === 'toQuote' || q.status === 'quoted');
  if (['toQuote', 'quoted'].includes(stageOf(before)) && stageOf(doc) === 'won' && quotesOf(doc).length === 1 && open.length === 1) {
    open[0].status = 'won';
  }
  // A hand edit: a re-import will no longer overwrite this job, only fill it in
  doc.editedAt = new Date();
  let saved;
  try {
    saved = await doc.save();
  } catch (err) {
    throw saveError(err);
  }
  await lifecycle.fireStageHooks(before, saved);
  return saved;
}

export async function findEntry(uuid) {
  return mdb.INTERNAL.jobRegister.findOne({ uuid: String(uuid || '') }).populate('contractId', 'uuid title').lean();
}

// ── Quotes and invoices on a job ────────────────────────────────────────

async function findJobLean(uuid) {
  const job = await mdb.INTERNAL.jobRegister.findOne({ uuid: String(uuid || '') }).lean();
  if (!job) throw notFound('That register entry no longer exists.');
  return job;
}

const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const validId = (id) => mongoose.Types.ObjectId.isValid(String(id || ''));

function findLine(job, kind, id) {
  const list = kind === 'quote' ? quotesOf(job) : invoicesOf(job);
  const line = validId(id) ? list.find((x) => sameId(x._id, id)) : null;
  if (!line) throw notFound(`That ${kind} is no longer on this job.`);
  return line;
}

/** $set / $unset for a line's fields at `prefix` (e.g. 'quotes.$.'): blanks are unset. Pure. */
export function lineUpdate(fields, prefix) {
  const $set = {};
  const $unset = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === '') $unset[`${prefix}${k}`] = 1;
    else $set[`${prefix}${k}`] = v;
  }
  return { $set, $unset };
}

async function runUpdate(filter, update) {
  if (update.$unset && !Object.keys(update.$unset).length) delete update.$unset;
  try {
    const res = await mdb.INTERNAL.jobRegister.updateOne(filter, update, { runValidators: true });
    if (res && res.matchedCount === 0) throw notFound('That register entry no longer exists.');
  } catch (err) {
    throw saveError(err);
  }
}

/**
 * POST /job-register/:uuid/quotes: add a quote (a variation, or the job's
 * first). opts.fromKashflow: it came from KashFlow (Add to job), so the
 * onQuoteAdded hook is told it's there already.
 */
export async function addQuote(uuid, body, opts = {}) {
  const job = await findJobLean(uuid);
  const quote = drop(parseQuoteLine(body));
  if (quote.number != null && quoteNumbersOf(job).includes(quote.number)) throw bad(`Quote ${quote.number} is on this job already.`);
  quote._id = new mongoose.Types.ObjectId();
  const set = { editedAt: new Date() };
  if (quote.status === 'won') set.won = true;
  await runUpdate({ uuid: job.uuid }, { $push: { quotes: quote }, $set: set });
  const after = { ...job, ...set, quotes: [...quotesOf(job), quote] };
  await lifecycle.fireQuoteAdded(after, opts.fromKashflow ? { ...quote, fromKashflow: true } : quote);
  await lifecycle.fireStageHooks(job, after);
  return { job: after, quote };
}

/** POST /job-register/:uuid/quotes/:id: change a quote. */
export async function updateQuote(uuid, id, body) {
  const job = await findJobLean(uuid);
  const current = findLine(job, 'quote', id);
  const fields = parseQuoteLine(body);
  const others = quotesOf(job).filter((q) => !sameId(q._id, current._id));
  if (fields.number != null && numbers(others).includes(fields.number)) throw bad(`Quote ${fields.number} is on this job already.`);
  const merged = { ...current, ...drop(fields) };
  for (const [k, v] of Object.entries(fields)) if (v === null || v === '') delete merged[k];
  const after = { ...job, quotes: quotesOf(job).map((q) => (sameId(q._id, current._id) ? merged : q)) };
  const problem = jobProblem(after);
  if (problem) throw bad(fields.number == null ? 'This quote number is the only number on the job: keep it, or give the job its project number first.' : problem);
  const { $set, $unset } = lineUpdate(fields, 'quotes.$.');
  $set.editedAt = new Date();
  if (fields.status === 'won') { $set.won = true; after.won = true; }
  await runUpdate({ uuid: job.uuid, 'quotes._id': current._id }, { $set, $unset });
  await lifecycle.fireStageHooks(job, after);
  return { job: after, quote: merged };
}

/** POST /job-register/:uuid/quotes/:id/delete: take a quote off the job. */
export async function removeQuote(uuid, id) {
  const job = await findJobLean(uuid);
  const current = findLine(job, 'quote', id);
  const after = { ...job, quotes: quotesOf(job).filter((q) => !sameId(q._id, current._id)) };
  if (jobProblem(after)) throw bad("This quote's number is the only number on the job: cancel the job instead, or give it its project number first.");
  await runUpdate({ uuid: job.uuid }, { $pull: { quotes: { _id: current._id } }, $set: { editedAt: new Date() } });
  await lifecycle.fireStageHooks(job, after);
  return { job: after, quote: current };
}

/** POST /job-register/:uuid/invoices: add an invoice (the job's, or a stage payment). */
export async function addInvoice(uuid, body) {
  const job = await findJobLean(uuid);
  if (job.projectNumber == null) throw bad('Give the job its project number before adding an invoice.');
  const invoice = drop(parseInvoiceLine(body));
  if (invoiceNumbersOf(job).includes(invoice.number)) throw bad(`Invoice ${invoice.number} is on this job already.`);
  invoice._id = new mongoose.Types.ObjectId();
  await runUpdate({ uuid: job.uuid }, { $push: { invoices: invoice }, $set: { editedAt: new Date() } });
  const after = { ...job, invoices: [...invoicesOf(job), invoice] };
  await lifecycle.fireStageHooks(job, after);
  return { job: after, invoice };
}

/** POST /job-register/:uuid/invoices/:id: change an invoice. */
export async function updateInvoice(uuid, id, body) {
  const job = await findJobLean(uuid);
  const current = findLine(job, 'invoice', id);
  const fields = parseInvoiceLine(body);
  const others = invoicesOf(job).filter((i) => !sameId(i._id, current._id));
  if (numbers(others).includes(fields.number)) throw bad(`Invoice ${fields.number} is on this job already.`);
  const { $set, $unset } = lineUpdate(fields, 'invoices.$.');
  $set.editedAt = new Date();
  await runUpdate({ uuid: job.uuid, 'invoices._id': current._id }, { $set, $unset });
  const merged = { ...current, ...drop(fields) };
  for (const [k, v] of Object.entries(fields)) if (v === null || v === '') delete merged[k];
  return { job: { ...job, invoices: invoicesOf(job).map((i) => (sameId(i._id, current._id) ? merged : i)) }, invoice: merged };
}

/** POST /job-register/:uuid/invoices/:id/delete: take an invoice off the job. */
export async function removeInvoice(uuid, id) {
  const job = await findJobLean(uuid);
  const current = findLine(job, 'invoice', id);
  await runUpdate({ uuid: job.uuid }, { $pull: { invoices: { _id: current._id } }, $set: { editedAt: new Date() } });
  const after = { ...job, invoices: invoicesOf(job).filter((i) => !sameId(i._id, current._id)) };
  await lifecycle.fireStageHooks(job, after);
  return { job: after, invoice: current };
}

/**
 * POST /job-register/:uuid/kashflow-add: put a synced KashFlow quote or
 * invoice that's on the job's project in KashFlow onto the job here, with
 * its number, date and net value from KashFlow (through addQuote /
 * addInvoice, so it's marked edited). A quote is won when the job already
 * has a won quote (so it counts in the agreed value), else quoted. Refuses
 * one that isn't on this job in KashFlow, or that another job here has.
 * Returns { kind, job, quote | invoice }.
 */
export async function addFromKashflow(uuid, body = {}) {
  const kind = body.kind === 'invoice' ? 'invoice' : body.kind === 'quote' ? 'quote' : null;
  if (!kind) throw bad('Choose a quote or an invoice to add.');
  const Kind = kind === 'quote' ? 'Quote' : 'Invoice';
  const number = int(body.number);
  if (number == null || Number.isNaN(number)) throw bad(`The ${kind} number isn't valid.`);
  const job = await findJobLean(uuid);
  if (job.projectNumber == null) throw bad(`Give the job its project number before adding ${kind}s from KashFlow.`);
  const have = kind === 'quote' ? quoteNumbersOf(job) : invoiceNumbersOf(job);
  if (have.includes(number)) throw bad(`${Kind} ${number} is on this job already.`);

  const Model = kind === 'quote' ? mdb.REST.quote : mdb.REST.invoice;
  const record = await Model.findOne({ Number: number }).select(kind === 'quote' ? QUOTE_FIELDS : INVOICE_FIELDS).lean();
  if (!record) throw bad(`${Kind} ${number} isn't in the synced KashFlow records.`);
  if (Number(record.ProjectNumber) !== Number(job.projectNumber)) {
    throw bad(jobIssue(Kind, number, job, record)[0] || `${Kind} ${number} isn't on job ${job.projectNumber} in KashFlow.`);
  }
  const path = kind === 'quote' ? 'quotes.number' : 'invoices.number';
  const other = await mdb.INTERNAL.jobRegister.findOne({ [path]: number, uuid: { $ne: job.uuid } })
    .select('uuid projectNumber quotes.number').lean();
  if (other) throw bad(`${Kind} ${number} is already on ${jobTitle(other).toLowerCase()} in the register: take it off that job first.`);

  const when = kind === 'quote' ? record.Date : record.IssuedDate;
  const date = when && !Number.isNaN(new Date(when).getTime()) ? ukToday(new Date(when)) : '';
  const value = record.NetAmount != null && Number.isFinite(Number(record.NetAmount)) ? String(record.NetAmount) : '';
  if (kind === 'quote') {
    const status = quotesOf(job).some((q) => q.status === 'won') ? 'won' : 'quoted';
    const r = await addQuote(job.uuid, { number: String(number), date, value, status }, { fromKashflow: true });
    return { kind, ...r };
  }
  const r = await addInvoice(job.uuid, { number: String(number), date, value });
  return { kind, ...r };
}

/** Contracts a job can be linked to: open ones, plus the one it already has. */
export async function contractChoices(currentId = null) {
  const or = [{ status: { $in: ['Planned', 'In Progress'] } }];
  if (currentId && mongoose.Types.ObjectId.isValid(String(currentId))) or.push({ _id: currentId });
  return mdb.INTERNAL.contract.find({ $or: or }).select('uuid title status').sort({ title: 1 }).lean();
}

// ── Open jobs (the weekly sheet) ────────────────────────────────────────

// Won but not completed: a project number, not cancelled, not marked
// completed. These are the jobs people can be put on (the weekly sheet's
// choices, the weekly sheet import's matches). A job part-invoiced with
// stage payments is still open.
export const OPEN_JOB_FILTER = {
  projectNumber: { $type: 'number' },
  cancelled: { $ne: true },
  completed: { $ne: true },
};
const OPEN_JOB_FIELDS = '_id uuid projectNumber site client contact description contractId';

/** Is this job won and not yet completed (OPEN_JOB_FILTER)? Pure. */
export function isOpenJob(entry) {
  return !!entry && typeof entry.projectNumber === 'number' && !entry.cancelled && !entry.completed;
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
  const nums = [...new Set(jobs.map((j) => j?.projectNumber).filter((n) => typeof n === 'number'))];
  if (!nums.length || !mdb.REST?.project) return new Map();
  const projects = await mdb.REST.project.find({ Number: { $in: nums } }).select('_id Number').lean();
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
  STAGES, STAGE_LABELS, STAGE_FILTERS, QUOTE_STATUSES, QUOTE_STATUS_LABELS,
  stageOf, jobValues, clientKey, entryDate, taxYearOf, jobNumber, jobTitle, quoteNumbersOf, invoiceNumbersOf,
  matchJob, buildRegister, findUnregistered, nextNumber,
  parseJobForm, parseQuoteLine, parseInvoiceLine, lineUpdate,
  parseNextAvailable, suggestNext, kashflowNextNumbers, formEcho, fillNext, ukToday,
  loadRegister, loadJob, createEntry, updateEntry, findEntry, contractChoices, customerChoices, jobsForAllocation,
  addQuote, updateQuote, removeQuote, addInvoice, updateInvoice, removeInvoice,
  jobIssue, kashflowExtras, byProject, numbersOrProjects, markElsewhere, addFromKashflow,
  OPEN_JOB_FILTER, isOpenJob, jobLabel, openJobs, projectIdsByNumber, jobTarget,
};
