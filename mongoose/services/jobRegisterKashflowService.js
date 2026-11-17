// Job Register → KashFlow: the optional "Create in KashFlow" buttons, and the
// same creates run automatically on a quote added / job won when switched on
// (see "Automatic" below).
//
// The register is double entry: a job is typed here, then checked against the
// synced KashFlow records. These two actions write the KashFlow side from the
// job instead of typing it again there:
//
//   one of a job's quotes → POST /quotes    lines built on the Create quote
//                                           page; on the job's project once
//                                           it has one (a variation)
//   a won job             → POST /projects  Name = site, the job's customer
//                                           and job date
//
// If the number is already taken in KashFlow by another customer's record,
// KashFlow picks the next number and the quote / job is changed to match. If
// it's taken by the same customer, it's most likely this job entered by hand
// and not synced yet, so nothing is created.
//
// The helpers above "KashFlow calls" are pure, so the form handling and the
// payloads can be tested without a database or KashFlow.
import mdb from './mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';
import kfSession from '../../services/kashflowSessionService.js';
import hcsSyncService from './hcsSyncService.js';
import configService from '../../services/configService.js';
import { ukToday } from './jobRegisterService.js';

export const VAT_CHOICES = [
  { value: '20', label: '20%', level: 20 },
  { value: '5', label: '5%', level: 5 },
  { value: '0', label: '0%', level: 0 },
  { value: 'rc', label: 'Reverse charge', level: 0 },
];
const DEFAULT_VAT = '20';
const MAX_LINES = 50;
const KF_TIMEOUT_MS = 20000;
const CLAIM_STALE_MS = 5 * 60 * 1000;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const text = (v) => String(v ?? '').trim();
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T12:00:00Z`).getTime());
const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const sameCode = (a, b) => text(a).toUpperCase() === text(b).toUpperCase() && text(a) !== '';

/** The text for a quote's first line: what it's for (the quote's description, else the job's), and where. */
export function lineText(job, quote = null) {
  return [text(quote?.description) || text(job.description), text(job.site)].filter(Boolean).join(' — ');
}

/** The quote on a job with this _id, or null. Pure. */
export function findQuote(job, quoteId) {
  if (!job || quoteId == null) return null;
  return (Array.isArray(job.quotes) ? job.quotes : []).find((q) => String(q._id) === String(quoteId)) || null;
}

/** The Create quote form as first shown: one line for the whole quote at its net value. */
export function quoteFormDefaults(job, quote, { nominal = null, now = new Date() } = {}) {
  return {
    date: quote?.date ? ymd(quote.date) : ukToday(now),
    reference: text(job.clientRef),
    lines: [{
      description: lineText(job, quote),
      quantity: '1',
      rate: quote?.value != null ? Number(quote.value).toFixed(2) : '',
      vat: DEFAULT_VAT,
      nominal: nominal != null ? String(nominal) : '',
    }],
  };
}

const num = (v) => {
  const s = text(v).replace(/[£,\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};

/**
 * The Create quote form from a body. A line with every box blank is dropped
 * (that's how a line is removed); `errors` lists the first problems, as
 * "lines.N.field" → message so the form can mark them. `values` is the form as
 * typed, to show again.
 */
export function parseQuoteForm(body = {}) {
  const raw = Array.isArray(body.lines) ? body.lines : Object.values(body.lines || {});
  const values = {
    date: text(body.date),
    reference: text(body.reference).slice(0, 100),
    lines: raw.slice(0, MAX_LINES).map((l) => ({
      description: text(l?.description).slice(0, 500),
      quantity: text(l?.quantity),
      rate: text(l?.rate),
      vat: text(l?.vat),
      nominal: text(l?.nominal),
    })),
  };
  const errors = {};
  if (!isDay(values.date)) errors.date = 'Enter the quote date.';

  const kept = values.lines.filter((l) => l.description || l.quantity || l.rate);
  const lines = [];
  kept.forEach((l, i) => {
    const quantity = num(l.quantity || '1');
    const rate = num(l.rate);
    const vat = VAT_CHOICES.find((c) => c.value === l.vat);
    const nominal = num(l.nominal);
    if (!l.description) errors[`lines.${i}.description`] = 'Enter what this line is for.';
    if (quantity == null || Number.isNaN(quantity) || quantity <= 0) errors[`lines.${i}.quantity`] = 'Enter a quantity above 0.';
    if (rate == null || Number.isNaN(rate) || rate < 0) errors[`lines.${i}.rate`] = 'Enter the price (net, per unit).';
    if (!vat) errors[`lines.${i}.vat`] = 'Choose the VAT.';
    if (nominal == null || !Number.isInteger(nominal)) errors[`lines.${i}.nominal`] = 'Choose the nominal.';
    lines.push({ description: l.description, quantity, rate, vat: vat?.value ?? null, level: vat?.level ?? null, nominal });
  });
  if (!lines.length) errors.lines = 'Add at least one line.';
  values.lines = kept;
  return { values, lines, errors, ok: Object.keys(errors).length === 0 };
}

/** Net, VAT and gross of parsed lines; lines that don't parse count as nothing. */
export function quoteTotals(lines = []) {
  let net = 0;
  let vat = 0;
  for (const l of lines) {
    if (!Number.isFinite(l.quantity) || !Number.isFinite(l.rate)) continue;
    const n = round2(l.quantity * l.rate);
    net += n;
    if (Number.isFinite(l.level)) vat += round2((n * l.level) / 100);
  }
  return { net: round2(net), vat: round2(vat), gross: round2(net + vat) };
}

/**
 * The POST /quotes body. Without `number`, KashFlow picks one. A job that
 * has its project number puts the quote on that project, unless `onProject`
 * is false (the automatic create, when the project isn't in KashFlow yet).
 */
export function buildQuotePayload(job, quote, { date, reference, lines }, { number = quote?.number, onProject = true } = {}) {
  const payload = {
    Date: date,
    CustomerCode: text(job.customerCode),
    LineItems: lines.map((l) => {
      const net = round2(l.quantity * l.rate);
      return {
        Description: l.description,
        Quantity: l.quantity,
        Rate: l.rate,
        VATLevel: l.level,
        VATAmount: round2((net * l.level) / 100),
        NominalCode: l.nominal,
      };
    }),
  };
  if (number != null) payload.Number = Number(number);
  if (reference) payload.CustomerReference = reference;
  if (onProject && job.projectNumber != null) payload.ProjectNumber = Number(job.projectNumber);
  return payload;
}

/** The POST /projects body. Without `number`, KashFlow picks one. */
export function buildProjectPayload(entry, { number = entry.projectNumber } = {}) {
  const payload = {
    Name: text(entry.site),
    CustomerCode: text(entry.customerCode),
  };
  if (number != null) payload.Number = Number(number);
  if (entry.jobDate) payload.StartDate = ymd(entry.jobDate);
  if (text(entry.description)) payload.Description = text(entry.description);
  if (text(entry.clientRef)) payload.Reference = text(entry.clientRef);
  return payload;
}

/**
 * What to do about the row's number, given what KashFlow holds under it
 * (null = free): 'use' it, let KashFlow 'pick' another (someone else's), or
 * 'stop' (the same customer's: this job, entered there by hand).
 */
export function numberPlan(entry, existing) {
  if (!existing) return 'use';
  return sameCode(existing.CustomerCode, entry.customerCode) ? 'stop' : 'pick';
}

/** Why a job's quote (`quote`) or project can't be created, or null if it can. */
export function cannotCreate(entry, kind, quote = null) {
  if (!entry) return 'That register entry no longer exists.';
  if (entry.cancelled) return 'This job is cancelled.';
  if (kind === 'quote' && !quote) return 'That quote is no longer on this job.';
  if (!text(entry.customerCode)) return 'Choose the client from the KashFlow customers first.';
  if (kind === 'quote') {
    if (quote.sentAt) return `Quote ${quote.number} was already created in KashFlow from here.`;
    if (quote.number == null) return 'This quote has no number.';
    if (quote.status === 'lost') return 'This quote is marked lost.';
  } else {
    if (entry.projectSentAt) return `Project ${entry.projectNumber} was already created in KashFlow from here.`;
    if (entry.projectNumber == null) return 'This job has no project number: it isn\'t won yet.';
    if (!text(entry.site)) return 'Enter the site: it\'s the project\'s name.';
  }
  return null;
}

// ── KashFlow calls ──────────────────────────────────────────────────────

const base = () => (process.env.KASHFLOW_API_BASE_URL || 'https://api.kashflow.com/v2').replace(/\/+$/, '');
const PATHS = { quote: '/quotes', project: '/projects' };
const LABEL = { quote: 'quote', project: 'project' };

/** The KashFlow record under a number, or null if there's none (404). */
async function kfFind(kind, number) {
  try {
    return await kfSession.withKfAuth(async (token) => {
      const resp = await kfSession.kfAxios.get(`${base()}${PATHS[kind]}/${Number(number)}`, {
        headers: { Authorization: `KfToken ${token}`, Accept: 'application/json' },
        timeout: KF_TIMEOUT_MS,
      });
      return resp.data || null;
    });
  } catch (err) {
    if (err?.response?.status === 404) return null;
    throw err;
  }
}

async function kfCreate(kind, payload) {
  return kfSession.withKfAuth(async (token) => {
    const resp = await kfSession.kfAxios.post(`${base()}${PATHS[kind]}`, payload, {
      headers: { Authorization: `KfToken ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      timeout: KF_TIMEOUT_MS,
    });
    return resp.data || {};
  });
}

/** KashFlow's message from a failed call, for the flash. */
export function kfError(err) {
  const d = err?.response?.data;
  const msg = (d && (d.Message || d.Error || d.message)) || err?.message || 'unknown error';
  return String(msg).slice(0, 300);
}

// ── Database ────────────────────────────────────────────────────────────

// Where each kind keeps its "sent" and "sending" marks and its number: the
// project on the job, a quote on its element of quotes[] (positional $)
const SENT = { quote: 'quotes.$.sentAt', project: 'projectSentAt' };
const CLAIM = { quote: 'quotes.$.sendingAt', project: 'projectSendingAt' };
const NUMBER = { quote: 'quotes.$.number', project: 'projectNumber' };

/** The filter for the job, and for a quote its element (so $ points at it). */
const target = (uuid, kind, quoteId) => (kind === 'quote' ? { uuid, 'quotes._id': quoteId } : { uuid });

/** Claim the project or the quote for one send, so a double press can't create two. */
async function claim(uuid, kind, quoteId) {
  const stale = new Date(Date.now() - CLAIM_STALE_MS);
  const free = (sent, sending) => ({ [sent]: { $in: [null] }, $or: [{ [sending]: { $in: [null] } }, { [sending]: { $lt: stale } }] });
  const filter = kind === 'quote'
    ? { uuid: String(uuid || ''), quotes: { $elemMatch: { _id: quoteId, ...free('sentAt', 'sendingAt') } } }
    : { uuid: String(uuid || ''), ...free('projectSentAt', 'projectSendingAt') };
  return mdb.INTERNAL.jobRegister.findOneAndUpdate(filter, { $set: { [CLAIM[kind]]: new Date() } }, { new: true }).lean();
}
const release = (uuid, kind, quoteId) => mdb.INTERNAL.jobRegister.updateOne(target(uuid, kind, quoteId), { $unset: { [CLAIM[kind]]: 1 } });

/** Ask hcs-sync to pull the new record, so the register shows it as matched. Best effort. */
async function pull(kind, number) {
  try {
    await hcsSyncService.pullEntity(kind, number);
  } catch (err) {
    logger.warn(`[jobRegisterKashflow] hcs-sync pull of ${kind} ${number} failed: ${err.message}`);
  }
}

/**
 * Create the job's project, or one of its quotes (quoteId), in KashFlow.
 * `makePayload(job, number)` builds the body with that number (or none, for
 * KashFlow to pick). Returns { number, picked } where picked means the
 * number was taken and KashFlow chose `number`; also `rowNotUpdated` if the
 * job couldn't take it.
 */
async function create(uuid, kind, makePayload, quoteId = null) {
  const current = await mdb.INTERNAL.jobRegister.findOne({ uuid: String(uuid || '') }).lean();
  const quote = kind === 'quote' ? findQuote(current, quoteId) : null;
  const why = cannotCreate(current, kind, quote);
  if (why) throw Object.assign(new Error(why), { status: current && (kind !== 'quote' || quote) ? 400 : 404 });

  const job = await claim(uuid, kind, quote?._id);
  if (!job) throw Object.assign(new Error(`The ${LABEL[kind]} is already being created in KashFlow. Wait a moment and reload.`), { status: 400 });

  const rowNumber = kind === 'quote' ? findQuote(job, quote._id)?.number ?? quote.number : job.projectNumber;
  let created;
  try {
    const plan = numberPlan(job, await kfFind(kind, rowNumber));
    if (plan === 'stop') {
      await pull(kind, rowNumber);
      throw Object.assign(new Error(`${kind === 'quote' ? 'Quote' : 'Project'} ${rowNumber} is already in KashFlow for this client, so nothing was created. It should show as matched once it has synced.`), { status: 400, code: 'exists' });
    }
    created = await kfCreate(kind, makePayload(job, plan === 'use' ? rowNumber : null));
  } catch (err) {
    await release(job.uuid, kind, quote?._id);
    if (err.status) throw err;
    logger.warn(`[jobRegisterKashflow] Creating ${kind} for register job ${job.uuid} failed: ${kfError(err)}`);
    throw Object.assign(new Error(`KashFlow didn't create the ${LABEL[kind]}: ${kfError(err)}`), { status: 400, kfReason: kfError(err) });
  }

  const n = Number(created?.Number);
  const number = Number.isInteger(n) && n > 0 ? n : rowNumber;
  const set = { [SENT[kind]]: new Date(), editedAt: new Date() };
  if (number !== rowNumber) set[NUMBER[kind]] = number;
  const where = target(job.uuid, kind, quote?._id);
  let rowNotUpdated = false;
  // Another quote on this same job has it (the unique index only sees other jobs)
  if (kind === 'quote' && number !== rowNumber && (job.quotes || []).some((q) => Number(q.number) === number && String(q._id) !== String(quote._id))) {
    rowNotUpdated = true;
    delete set[NUMBER[kind]];
  }
  try {
    await mdb.INTERNAL.jobRegister.updateOne(where, { $set: set, $unset: { [CLAIM[kind]]: 1 } });
  } catch (err) {
    // The number KashFlow picked is on another register job: keep the send, flag it
    if (err?.code !== 11000) throw err;
    rowNotUpdated = true;
    delete set[NUMBER[kind]];
    await mdb.INTERNAL.jobRegister.updateOne(where, { $set: set, $unset: { [CLAIM[kind]]: 1 } });
  }
  logger.info(`[jobRegisterKashflow] Created ${kind} ${number} in KashFlow from register job ${job.uuid}${number !== rowNumber ? ` (it had ${rowNumber})` : ''}`);
  await pull(kind, number);
  return { number, rowNumber, picked: number !== rowNumber, rowNotUpdated };
}

/**
 * The Create quote button for one of the job's quotes: `body` is the Create
 * quote form. `onProject: false` leaves the quote off the job's project.
 */
export async function createQuote(uuid, quoteId, body, { onProject = true } = {}) {
  const form = parseQuoteForm(body);
  if (!form.ok) throw Object.assign(new Error(Object.values(form.errors)[0]), { status: 400, form });
  return create(uuid, 'quote', (job, number) => buildQuotePayload(job, findQuote(job, quoteId), { ...form.values, lines: form.lines }, { number, onProject }), quoteId);
}

/** The Create project button. */
export async function createProject(uuid) {
  return create(uuid, 'project', (job, number) => buildProjectPayload(job || {}, { number }));
}

/**
 * Nominals a quote line can go on: the sales ones, or every live one if none
 * are classed as sales. `defaultCode` is the one used most on the synced
 * quotes' lines, so the form starts where quotes usually go.
 */
export async function nominalChoices() {
  const Nominal = mdb.REST.nominal;
  const live = { Archived: { $ne: true }, Code: { $type: 'number' } };
  let docs = await Nominal.find({ ...live, Classification: { $regex: /sales|income|turnover/i } }).select('Code Name').sort({ Code: 1 }).lean();
  if (!docs.length) docs = await Nominal.find(live).select('Code Name').sort({ Code: 1 }).lean();
  let defaultCode = null;
  try {
    const [top] = await mdb.REST.quote.aggregate([
      { $unwind: '$LineItems' },
      { $match: { 'LineItems.NominalCode': { $type: 'number' } } },
      { $group: { _id: '$LineItems.NominalCode', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 1 },
    ]);
    if (top && docs.some((d) => d.Code === top._id)) defaultCode = top._id;
  } catch (err) {
    logger.warn(`[jobRegisterKashflow] Couldn't work out the usual quote nominal: ${err.message}`);
  }
  return { nominals: docs.map((d) => ({ code: d.Code, name: text(d.Name) })), defaultCode };
}

/** The flash after a create: { type, text }. Says when KashFlow picked another number. Pure. */
export function createdNotice(label, r) {
  if (!r.picked) return { type: 'success', text: `${label} ${r.number} created in KashFlow.` };
  if (r.rowNotUpdated) {
    return { type: 'error', text: `${label} ${r.rowNumber} was taken in KashFlow, so it was created as ${r.number}. Another quote or job in the register already uses ${r.number}, so this one still says ${r.rowNumber}: fix the numbers.` };
  }
  return { type: 'success', text: `${label} ${r.rowNumber} was taken in KashFlow, so it was created as ${r.number}. The register now says ${r.number}.` };
}

// ── Automatic: on quote added and job won ───────────────────────────────
//
// With "Add Job Register quotes and jobs to KashFlow automatically" on
// (JOB_REGISTER_KASHFLOW_AUTO), the lifecycle hooks call these after a save:
//
//   a quote added → created in KashFlow as the Create quote form would
//                   (one line at the quote's net value, 20% VAT, the usual
//                   nominal), on the project only if that's in KashFlow
//   a job won     → its project created in KashFlow if it isn't there, then
//                   each of its quotes that is in KashFlow put on it
//                   (GET the quote, PUT it back whole with ProjectNumber)
//
// They never throw. Each returns { notices, skipped? }: notices are
// { type: 'success' | 'error', text } for the flash; skipped says why
// nothing was tried (also logged). A failure leaves the job saved and the
// Create quote / Create project buttons there to try again.

const AUTO_KEY = 'JOB_REGISTER_KASHFLOW_AUTO';

/** Is the automatic create switched on? Off unless set. */
export function autoEnabled() {
  return /^(1|true|yes|on)$/i.test(String(configService.get(AUTO_KEY, '') ?? '').trim());
}

/** Is there a synced KashFlow record with this number? False when it can't tell. */
async function synced(kind, number) {
  const model = kind === 'quote' ? mdb.REST?.quote : mdb.REST?.project;
  if (!model || number == null) return false;
  try {
    return Boolean(await model.findOne({ Number: Number(number) }).select('_id').lean());
  } catch (err) {
    logger.warn(`[jobRegisterKashflow] Couldn't check for synced ${kind} ${number}: ${err.message}`);
    return false;
  }
}

/** Why a quote shouldn't be created automatically, or null. Pure. */
export function autoQuoteSkip(job, quote) {
  if (!job) return 'the job no longer exists';
  if (!quote) return 'the quote is no longer on the job';
  if (job.cancelled) return 'the job is cancelled';
  if (!text(job.customerCode)) return 'the job has no KashFlow customer';
  if (quote.number == null) return 'the quote has no number';
  if (quote.sentAt) return 'it was already created in KashFlow from here';
  if (quote.status === 'lost') return 'the quote is marked lost';
  if (quote.value == null) return 'the quote has no value yet';
  return null;
}

/** Why a create failed, as a sentence for the flash. */
const reasonOf = (err) => {
  const r = text(err?.kfReason || err?.message || 'unknown error');
  return /[.!?]$/.test(r) ? r : `${r}.`;
};

const skip = (what, reason) => {
  logger.info(`[jobRegisterKashflow] Automatic: not creating ${what}: ${reason}`);
  return { notices: [], skipped: reason };
};

/** A quote was added to a job: create it in KashFlow. Never throws. */
export async function autoCreateQuote(job, quote) {
  if (!autoEnabled()) return { notices: [], skipped: 'switched off' };
  const n = quote?.number;
  try {
    const current = await mdb.INTERNAL.jobRegister.findOne({ uuid: String(job?.uuid || '') }).lean();
    const q = current && ((quote?._id != null && findQuote(current, quote._id))
      || (n != null && (current.quotes || []).find((x) => Number(x.number) === Number(n)))) || null;
    const why = autoQuoteSkip(current, q);
    if (why) return skip(`quote ${n ?? '(no number)'}`, why);
    if (await synced('quote', q.number)) return skip(`quote ${q.number}`, 'it is already in KashFlow');

    const { defaultCode } = await nominalChoices();
    if (defaultCode == null) {
      return { notices: [{ type: 'error', text: `Quote ${q.number} wasn't created in KashFlow: there's no usual sales nominal to put it on. Use Create quote to choose one.` }] };
    }
    const onProject = current.projectNumber != null && (Boolean(current.projectSentAt) || await synced('project', current.projectNumber));
    const r = await createQuote(current.uuid, q._id, quoteFormDefaults(current, q, { nominal: defaultCode }), { onProject });
    return { notices: [createdNotice('Quote', r)], result: r };
  } catch (err) {
    if (err.code === 'exists') return skip(`quote ${n}`, 'it is already in KashFlow for this client');
    logger.warn(`[jobRegisterKashflow] Automatic create of quote ${n} failed: ${err.message}`);
    return { notices: [{ type: 'error', text: `Quote ${n} was saved but not created in KashFlow: ${reasonOf(err)} Use Create quote to try again.` }] };
  }
}

/** The PUT /quotes/{number} body: the quote as GET returned it, request fields only, on `projectNumber`. Pure. */
export function quoteUpdatePayload(kfQuote, projectNumber) {
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined && o?.[k] !== null).map((k) => [k, o[k]]));
  const LINE = ['Number', 'Description', 'Quantity', 'Rate', 'VATLevel', 'VATExempt', 'VATAmount', 'NominalCode', 'ProductCode', 'TaxCode', 'Disallowed', 'HomeCurrencyRate', 'HomeCurrencyVATAmount'];
  const ADDRESS = ['CountryCode', 'Line1', 'Line2', 'Line3', 'Line4', 'PostCode'];
  const body = pick(kfQuote, ['Number', 'Date', 'CustomerCode', 'CustomerReference', 'SuppressAmount', 'UseCustomDeliveryAddress']);
  if (kfQuote?.Category) body.Category = pick(kfQuote.Category, ['IconId', 'Number', 'Name', 'IconType', 'IconColor']);
  if (kfQuote?.Currency) body.Currency = pick(kfQuote.Currency, ['Code', 'ExchangeRate']);
  if (Array.isArray(kfQuote?.LineItems)) body.LineItems = kfQuote.LineItems.map((l) => pick(l, LINE));
  if (Array.isArray(kfQuote?.Addresses)) body.Addresses = kfQuote.Addresses.map((a) => pick(a, ADDRESS));
  if (Array.isArray(kfQuote?.DeliveryAddresses)) body.DeliveryAddresses = kfQuote.DeliveryAddresses.map((a) => pick(a, ['Name', ...ADDRESS]));
  body.ProjectNumber = Number(projectNumber);
  return body;
}

async function kfPutQuote(number, payload) {
  return kfSession.withKfAuth(async (token) => {
    const resp = await kfSession.kfAxios.put(`${base()}/quotes/${Number(number)}`, payload, {
      headers: { Authorization: `KfToken ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      timeout: KF_TIMEOUT_MS,
    });
    return resp.data || {};
  });
}

/**
 * Put the job's quotes that are in KashFlow (created from here, or synced)
 * on project `projectNumber`. Quotes already on it, lost ones, and ones
 * KashFlow holds for another customer are left alone.
 */
async function attachQuotes(job, projectNumber) {
  const notices = [];
  const moved = [];
  for (const q of job.quotes || []) {
    if (q.number == null || q.status === 'lost') continue;
    if (!q.sentAt && !(await synced('quote', q.number))) continue;
    try {
      const kfQuote = await kfFind('quote', q.number);
      if (!kfQuote) continue;
      if (!sameCode(kfQuote.CustomerCode, job.customerCode)) {
        logger.warn(`[jobRegisterKashflow] Quote ${q.number} is another customer's in KashFlow (${text(kfQuote.CustomerCode)}): not putting it on project ${projectNumber}`);
        continue;
      }
      if (Number(kfQuote.ProjectNumber) === Number(projectNumber)) continue;
      await kfPutQuote(q.number, quoteUpdatePayload(kfQuote, projectNumber));
      moved.push(q.number);
      await pull('quote', q.number);
    } catch (err) {
      logger.warn(`[jobRegisterKashflow] Putting quote ${q.number} on project ${projectNumber} failed: ${kfError(err)}`);
      notices.push({ type: 'error', text: `Quote ${q.number} couldn't be put on project ${projectNumber} in KashFlow: ${kfError(err)}` });
    }
  }
  if (moved.length) {
    logger.info(`[jobRegisterKashflow] Put quote${moved.length === 1 ? '' : 's'} ${moved.join(', ')} on project ${projectNumber}`);
    notices.unshift({ type: 'success', text: `Quote${moved.length === 1 ? '' : 's'} ${moved.join(', ')} put on project ${projectNumber} in KashFlow.` });
  }
  return notices;
}

/** A job was won: create its project in KashFlow if needed, and put its quotes on it. Never throws. */
export async function autoJobWon(job) {
  if (!autoEnabled()) return { notices: [], skipped: 'switched off' };
  try {
    let current = await mdb.INTERNAL.jobRegister.findOne({ uuid: String(job?.uuid || '') }).lean();
    if (!current) return skip('project', 'the job no longer exists');
    if (current.cancelled) return skip('project', 'the job is cancelled');
    if (!text(current.customerCode)) {
      return { notices: [{ type: 'error', text: "The project wasn't created in KashFlow: choose the client from the KashFlow customers first." }], skipped: 'the job has no KashFlow customer' };
    }
    if (current.projectNumber == null) {
      logger.info(`[jobRegisterKashflow] Automatic: job ${current.uuid} is won but has no project number yet`);
      return { notices: [{ type: 'success', text: 'The project will be created in KashFlow when the job has its project number.' }], skipped: 'the job has no project number yet' };
    }
    const notices = [];
    let projectNumber = current.projectNumber;
    if (!current.projectSentAt && !(await synced('project', projectNumber))) {
      try {
        const r = await createProject(current.uuid);
        notices.push(createdNotice('Project', r));
        projectNumber = r.number;
        current = await mdb.INTERNAL.jobRegister.findOne({ uuid: current.uuid }).lean() || current;
      } catch (err) {
        if (err.code !== 'exists') {
          logger.warn(`[jobRegisterKashflow] Automatic create of project ${projectNumber} failed: ${err.message}`);
          return { notices: [{ type: 'error', text: `Project ${projectNumber} wasn't created in KashFlow: ${reasonOf(err)} Use Create project to try again.` }] };
        }
      }
    }
    notices.push(...await attachQuotes(current, projectNumber));
    return { notices };
  } catch (err) {
    logger.warn(`[jobRegisterKashflow] Automatic KashFlow step for won job ${job?.uuid} failed: ${err.message}`);
    return { notices: [{ type: 'error', text: `The job wasn't fully set up in KashFlow: ${kfError(err)}` }] };
  }
}

export default {
  VAT_CHOICES, lineText, findQuote, quoteFormDefaults, parseQuoteForm, quoteTotals, buildQuotePayload, buildProjectPayload,
  numberPlan, cannotCreate, kfError, createQuote, createProject, nominalChoices, createdNotice,
  autoEnabled, autoQuoteSkip, autoCreateQuote, quoteUpdatePayload, autoJobWon,
};
