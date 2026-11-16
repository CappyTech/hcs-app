// Job Register → KashFlow: the optional "Create in KashFlow" buttons.
//
// The register is double entry: a row is typed here, then checked against the
// synced KashFlow records. These two actions write the KashFlow side from the
// row instead of typing it again there:
//
//   quote row → POST /quotes    lines built on the Create quote page
//   won row   → POST /projects  Name = site, the row's customer and job date
//
// If the row's number is already taken in KashFlow by another customer's
// record, KashFlow picks the next number and the row is changed to match. If
// it's taken by the same customer, it's most likely this job entered by hand
// and not synced yet, so nothing is created.
//
// The helpers above "KashFlow calls" are pure, so the form handling and the
// payloads can be tested without a database or KashFlow.
import mdb from './mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';
import kfSession from '../../services/kashflowSessionService.js';
import hcsSyncService from './hcsSyncService.js';
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

/** The text for a row's first quote line: what the job is, and where. */
export function lineText(entry) {
  return [text(entry.description), text(entry.site)].filter(Boolean).join(' — ');
}

/** The Create quote form as first shown: one line for the whole job at the row's net value. */
export function quoteFormDefaults(entry, { nominal = null, now = new Date() } = {}) {
  return {
    date: entry.quoteDate ? ymd(entry.quoteDate) : ukToday(now),
    reference: text(entry.clientRef),
    lines: [{
      description: lineText(entry),
      quantity: '1',
      rate: entry.value != null ? Number(entry.value).toFixed(2) : '',
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

/** The POST /quotes body. Without `number`, KashFlow picks one. */
export function buildQuotePayload(entry, { date, reference, lines }, { number = entry.quoteNumber } = {}) {
  const payload = {
    Date: date,
    CustomerCode: text(entry.customerCode),
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

/** Why a row can't have its quote / project created, or null if it can. */
export function cannotCreate(entry, kind) {
  if (!entry) return 'That register entry no longer exists.';
  if (entry.cancelled) return 'This row is cancelled.';
  if (!text(entry.customerCode)) return 'Choose the client from the KashFlow customers first.';
  if (kind === 'quote') {
    if (entry.quoteSentAt) return `Quote ${entry.quoteNumber} was already created in KashFlow from here.`;
    if (entry.quoteNumber == null) return 'This row has no quote number.';
  } else {
    if (entry.projectSentAt) return `Project ${entry.projectNumber} was already created in KashFlow from here.`;
    if (entry.projectNumber == null) return 'This row has no project number: it isn\'t won yet.';
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

const SENT = { quote: 'quoteSentAt', project: 'projectSentAt' };
const CLAIM = { quote: 'quoteSendingAt', project: 'projectSendingAt' };
const NUMBER = { quote: 'quoteNumber', project: 'projectNumber' };

/** Claim the row for one send, so a double press can't create two. */
async function claim(uuid, kind) {
  const stale = new Date(Date.now() - CLAIM_STALE_MS);
  return mdb.INTERNAL.jobRegister.findOneAndUpdate(
    {
      uuid: String(uuid || ''),
      [SENT[kind]]: { $in: [null] },
      $or: [{ [CLAIM[kind]]: { $in: [null] } }, { [CLAIM[kind]]: { $lt: stale } }],
    },
    { $set: { [CLAIM[kind]]: new Date() } },
    { new: true },
  ).lean();
}
const release = (uuid, kind) => mdb.INTERNAL.jobRegister.updateOne({ uuid }, { $unset: { [CLAIM[kind]]: 1 } });

/** Ask hcs-sync to pull the new record, so the register shows it as matched. Best effort. */
async function pull(kind, number) {
  try {
    await hcsSyncService.pullEntity(kind, number);
  } catch (err) {
    logger.warn(`[jobRegisterKashflow] hcs-sync pull of ${kind} ${number} failed: ${err.message}`);
  }
}

/**
 * Create the row's quote or project in KashFlow. `makePayload(number)` builds
 * the body with that number (or none, for KashFlow to pick).
 * Returns { number, picked } where picked means the row's number was taken
 * and KashFlow chose `number`; also `rowNotUpdated` if the row couldn't take it.
 */
async function create(uuid, kind, makePayload) {
  const current = await mdb.INTERNAL.jobRegister.findOne({ uuid: String(uuid || '') }).lean();
  const why = cannotCreate(current, kind);
  if (why) throw Object.assign(new Error(why), { status: current ? 400 : 404 });

  const entry = await claim(uuid, kind);
  if (!entry) throw Object.assign(new Error(`The ${LABEL[kind]} is already being created in KashFlow. Wait a moment and reload.`), { status: 400 });

  const rowNumber = entry[NUMBER[kind]];
  let created;
  try {
    const plan = numberPlan(entry, await kfFind(kind, rowNumber));
    if (plan === 'stop') {
      await pull(kind, rowNumber);
      throw Object.assign(new Error(`${kind === 'quote' ? 'Quote' : 'Project'} ${rowNumber} is already in KashFlow for this client, so nothing was created. It should show as matched once it has synced.`), { status: 400 });
    }
    created = await kfCreate(kind, makePayload(plan === 'use' ? rowNumber : null));
  } catch (err) {
    await release(entry.uuid, kind);
    if (err.status) throw err;
    logger.warn(`[jobRegisterKashflow] Creating ${kind} for register row ${entry.uuid} failed: ${kfError(err)}`);
    throw Object.assign(new Error(`KashFlow didn't create the ${LABEL[kind]}: ${kfError(err)}`), { status: 400 });
  }

  const n = Number(created?.Number);
  const number = Number.isInteger(n) && n > 0 ? n : rowNumber;
  const set = { [SENT[kind]]: new Date(), editedAt: new Date() };
  if (number !== rowNumber) set[NUMBER[kind]] = number;
  let rowNotUpdated = false;
  try {
    await mdb.INTERNAL.jobRegister.updateOne({ uuid: entry.uuid }, { $set: set, $unset: { [CLAIM[kind]]: 1 } });
  } catch (err) {
    // The number KashFlow picked is on another register row: keep the send, flag it
    if (err?.code !== 11000) throw err;
    rowNotUpdated = true;
    delete set[NUMBER[kind]];
    await mdb.INTERNAL.jobRegister.updateOne({ uuid: entry.uuid }, { $set: set, $unset: { [CLAIM[kind]]: 1 } });
  }
  logger.info(`[jobRegisterKashflow] Created ${kind} ${number} in KashFlow from register row ${entry.uuid}${number !== rowNumber ? ` (row had ${rowNumber})` : ''}`);
  await pull(kind, number);
  return { number, rowNumber, picked: number !== rowNumber, rowNotUpdated };
}

/** The Create quote button: `body` is the Create quote form. */
export async function createQuote(uuid, body) {
  const form = parseQuoteForm(body);
  if (!form.ok) throw Object.assign(new Error(Object.values(form.errors)[0]), { status: 400, form });
  const entry = await mdb.INTERNAL.jobRegister.findOne({ uuid: String(uuid || '') }).lean();
  return create(uuid, 'quote', (number) => buildQuotePayload(entry, { ...form.values, lines: form.lines }, { number }));
}

/** The Create project button. */
export async function createProject(uuid) {
  const entry = await mdb.INTERNAL.jobRegister.findOne({ uuid: String(uuid || '') }).lean();
  return create(uuid, 'project', (number) => buildProjectPayload(entry || {}, { number }));
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

export default {
  VAT_CHOICES, lineText, quoteFormDefaults, parseQuoteForm, quoteTotals, buildQuotePayload, buildProjectPayload,
  numberPlan, cannotCreate, kfError, createQuote, createProject, nominalChoices,
};
