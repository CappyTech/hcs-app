import path from 'path';
import logger from '../../services/loggerService.js';
import jobRegister from '../services/jobRegisterService.js';
import jobImport from '../services/jobRegisterImportService.js';
import kfCreate from '../services/jobRegisterKashflowService.js';
import rbac from '../config/rolePermissionsConfig.js';
import overviewEngine from '../services/overviewEngine.js';

const VIEW = (name) => path.join('tailwindcss', 'jobRegister', name);
const jobUrl = (uuid) => `/job-register/${encodeURIComponent(uuid)}`;
const registerCrumbs = (req) => [...overviewEngine.breadcrumbs(req, 'projects'), { label: 'Job Register', href: '/job-register' }];
const canEditRegister = (req) => rbac.hasGroup(req.user, 'commercial', 'edit');

/** ?stage=&client=&year=&q= from the query string. No year means every year. */
export function readFilters(query = {}) {
  const yearRaw = String(query.year ?? '').trim();
  return {
    stage: String(query.stage || 'all'),
    client: String(query.client || ''),
    year: /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null,
    q: String(query.q || '').slice(0, 100),
  };
}

/**
 * A 400/404 from a service: flash it and go back to `url` (or, for a 404,
 * `url404`: the register when the job itself has gone). Anything else is
 * the error page.
 */
function backOnError(req, res, next, err, url, url404 = '/job-register') {
  if (err.status === 400 || err.status === 404) {
    req.flash('error', err.message);
    return res.redirect(err.status === 404 ? url404 : url);
  }
  return next(err);
}

async function renderRegister(req, res, filters, fill = null) {
  const data = await jobRegister.loadRegister(filters);
  res.render(VIEW('index'), {
    title: 'Job Register',
    ...data,
    stageLabels: jobRegister.STAGE_LABELS,
    stages: jobRegister.STAGES,
    contracts: await jobRegister.contractChoices(),
    customers: await jobRegister.customerChoices(),
    crumbs: overviewEngine.breadcrumbs(req, 'projects'),
    form: fill ? jobRegister.fillNext(fill, data.next) : {},
  });
}

/** GET /job-register */
export const getRegister = async (req, res, next) => {
  try {
    await renderRegister(req, res, readFilters(req.query));
  } catch (err) {
    next(err);
  }
};

/** POST /job-register/next: the add form again, as typed, with KashFlow's next number filled in. */
export const postFillNext = async (req, res, next) => {
  try {
    await renderRegister(req, res, readFilters({}), req.body || {});
  } catch (err) {
    next(err);
  }
};

/** POST /job-register */
export const postCreate = async (req, res, next) => {
  try {
    const doc = await jobRegister.createEntry(req.body);
    logger.info(`[jobRegisterController] Added register job ${doc.uuid}`);
    req.flash('success', `Added ${jobRegister.jobTitle(doc).toLowerCase()}.`);
    res.redirect(jobUrl(doc.uuid));
  } catch (err) {
    if (err.status === 400) {
      req.flash('error', err.message);
      return res.redirect('/job-register#add');
    }
    next(err);
  }
};

// ── The job page ────────────────────────────────────────────────────────

/** What the user may create in KashFlow from this job: the project, and each quote by _id. */
function createChoices(req, job) {
  if (!canEditRegister(req)) return { project: false, quotes: {} };
  return {
    project: !kfCreate.cannotCreate(job, 'project'),
    quotes: Object.fromEntries((job.quotes || []).map((q) => [String(q._id), !kfCreate.cannotCreate(job, 'quote', q)])),
  };
}

/** GET /job-register/:uuid: the job, its quotes and its invoices. ?quote=<id> / ?invoice=<id> opens that one's form. */
export const getShow = async (req, res, next) => {
  try {
    const data = await jobRegister.loadJob(req.params.uuid);
    if (!data) return next({ statusCode: 404, message: 'That register entry no longer exists.' });
    const { job } = data;
    const pick = (list, id) => (id ? (list || []).find((x) => String(x._id) === String(id)) || null : null);
    res.render(VIEW('show'), {
      title: jobRegister.jobTitle(job),
      ...data,
      stageLabels: jobRegister.STAGE_LABELS,
      quoteStatuses: jobRegister.QUOTE_STATUSES,
      quoteStatusLabels: jobRegister.QUOTE_STATUS_LABELS,
      canEdit: canEditRegister(req),
      canCreate: createChoices(req, job),
      editQuote: pick(job.quotes, req.query.quote),
      editInvoice: pick(job.invoices, req.query.invoice),
      crumbs: registerCrumbs(req),
    });
  } catch (err) {
    next(err);
  }
};

async function renderEdit(req, res, next, fill = null) {
  const entry = await jobRegister.findEntry(req.params.uuid);
  if (!entry) return next({ statusCode: 404, message: 'That register entry no longer exists.' });
  const data = await jobRegister.loadJob(entry.uuid);
  const title = jobRegister.jobTitle(entry);
  res.render(VIEW('edit'), {
    title: `Edit ${title.toLowerCase()}`,
    entry,
    stage: jobRegister.stageOf(entry),
    stageLabels: jobRegister.STAGE_LABELS,
    next: data?.next || {},
    contracts: await jobRegister.contractChoices(entry.contractId?._id),
    customers: await jobRegister.customerChoices(),
    crumbs: [...registerCrumbs(req), { label: title, href: jobUrl(entry.uuid) }],
    form: fill ? { ...entry, ...jobRegister.fillNext(fill, data?.next) } : null,
  });
}

/** GET /job-register/:uuid/edit: the job's own fields. */
export const getEdit = async (req, res, next) => {
  try {
    await renderEdit(req, res, next);
  } catch (err) {
    next(err);
  }
};

/** POST /job-register/:uuid/next: the edit form again, as typed, with KashFlow's next number filled in. */
export const postFillNextEdit = async (req, res, next) => {
  try {
    await renderEdit(req, res, next, req.body || {});
  } catch (err) {
    next(err);
  }
};

/** POST /job-register/:uuid */
export const postUpdate = async (req, res, next) => {
  try {
    const doc = await jobRegister.updateEntry(req.params.uuid, req.body);
    req.flash('success', 'Saved.');
    res.redirect(jobUrl(doc.uuid));
  } catch (err) {
    backOnError(req, res, next, err, `${jobUrl(req.params.uuid)}/edit`);
  }
};

// ── Quotes and invoices ─────────────────────────────────────────────────

/** A POST handler for one quote/invoice action, back to the job page. */
const lineAction = (run, done, anchor) => async (req, res, next) => {
  const back = `${jobUrl(req.params.uuid)}#${anchor}`;
  try {
    const r = await run(req);
    req.flash('success', done(r));
    res.redirect(back);
  } catch (err) {
    const retry = req.params.id ? `${jobUrl(req.params.uuid)}?${anchor === 'quotes' ? 'quote' : 'invoice'}=${encodeURIComponent(req.params.id)}#${anchor}` : back;
    // A quote or invoice that's gone: back to its job; the job gone: the register
    const gone = /register entry no longer exists/.test(err.message);
    backOnError(req, res, next, err, retry, gone ? '/job-register' : back);
  }
};
const named = (kind, line) => (line?.number != null ? `${kind} ${line.number}` : `the ${kind.toLowerCase()}`);

/** POST /job-register/:uuid/quotes */
export const postAddQuote = lineAction((req) => jobRegister.addQuote(req.params.uuid, req.body || {}), (r) => `Added ${named('quote', r.quote)}.`, 'quotes');
/** POST /job-register/:uuid/quotes/:id */
export const postUpdateQuote = lineAction((req) => jobRegister.updateQuote(req.params.uuid, req.params.id, req.body || {}), (r) => `Saved ${named('quote', r.quote)}.`, 'quotes');
/** POST /job-register/:uuid/quotes/:id/delete */
export const postRemoveQuote = lineAction((req) => jobRegister.removeQuote(req.params.uuid, req.params.id), (r) => `Removed ${named('quote', r.quote)} from the job.`, 'quotes');
/** POST /job-register/:uuid/invoices */
export const postAddInvoice = lineAction((req) => jobRegister.addInvoice(req.params.uuid, req.body || {}), (r) => `Added ${named('invoice', r.invoice)}.`, 'invoices');
/** POST /job-register/:uuid/invoices/:id */
export const postUpdateInvoice = lineAction((req) => jobRegister.updateInvoice(req.params.uuid, req.params.id, req.body || {}), (r) => `Saved ${named('invoice', r.invoice)}.`, 'invoices');
/** POST /job-register/:uuid/invoices/:id/delete */
export const postRemoveInvoice = lineAction((req) => jobRegister.removeInvoice(req.params.uuid, req.params.id), (r) => `Removed ${named('invoice', r.invoice)} from the job.`, 'invoices');

// ── Linking clients ─────────────────────────────────────────────────────

/** GET /job-register/link-clients: jobs whose client isn't a KashFlow customer yet, by client. */
export const getLinkClients = async (req, res, next) => {
  try {
    const data = await jobImport.loadUnlinked();
    res.render(VIEW('link-clients'), {
      title: 'Link clients to KashFlow customers',
      ...data,
      crumbs: registerCrumbs(req),
    });
  } catch (err) {
    next(err);
  }
};

/** POST /job-register/link-clients */
export const postLinkClients = async (req, res, next) => {
  try {
    const r = await jobImport.linkClients(req.body || {});
    req.flash('success', r.rows ? `Linked ${r.rows} row${r.rows === 1 ? '' : 's'} (${r.clients} client${r.clients === 1 ? '' : 's'}) to KashFlow customers.` : 'Nothing was linked: choose a customer for at least one client.');
    res.redirect('/job-register/link-clients');
  } catch (err) {
    next(err);
  }
};

/** POST /job-register/link-clients/kashflow: link jobs to the customer on their own KashFlow quote/project/invoice. */
export const postLinkFromKashflow = async (req, res, next) => {
  try {
    const r = await jobImport.linkFromKashflow();
    req.flash('success', r.rows ? `Linked ${r.rows} row${r.rows === 1 ? '' : 's'} to ${r.customers} KashFlow customer${r.customers === 1 ? '' : 's'}, from their quotes, projects and invoices.` : 'No unlinked rows have a quote, project or invoice in KashFlow.');
    res.redirect('/job-register/link-clients');
  } catch (err) {
    next(err);
  }
};

// ── Create in KashFlow ──────────────────────────────────────────────────

async function renderQuoteForm(req, res, next, values = null, errors = {}) {
  const entry = await jobRegister.findEntry(req.params.uuid);
  if (!entry) return next({ statusCode: 404, message: 'That register entry no longer exists.' });
  const quote = kfCreate.findQuote(entry, req.params.quoteId);
  const why = kfCreate.cannotCreate(entry, 'quote', quote);
  if (why) {
    req.flash('error', why);
    return res.redirect(jobUrl(entry.uuid));
  }
  const { nominals, defaultCode } = await kfCreate.nominalChoices();
  const form = values || kfCreate.quoteFormDefaults(entry, quote, { nominal: defaultCode });
  const parsed = kfCreate.parseQuoteForm(form);
  res.render(VIEW('kashflow-quote'), {
    title: `Create quote ${quote.number} in KashFlow`,
    entry,
    quote,
    values: form,
    errors,
    totals: kfCreate.quoteTotals(parsed.lines),
    nominals,
    defaultNominal: defaultCode,
    vatChoices: kfCreate.VAT_CHOICES,
    crumbs: [...registerCrumbs(req), { label: jobRegister.jobTitle(entry), href: jobUrl(entry.uuid) }],
  });
}

/** GET /job-register/:uuid/kashflow-quote/:quoteId: the lines for the new KashFlow quote. */
export const getKashflowQuote = async (req, res, next) => {
  try {
    await renderQuoteForm(req, res, next);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /job-register/:uuid/kashflow-quote/:quoteId. action=addLine or totals
 * shows the form again (with a blank line, or the totals worked out); create
 * sends it.
 */
export const postKashflowQuote = async (req, res, next) => {
  try {
    const body = req.body || {};
    const action = ['addLine', 'totals', 'create'].includes(body.action) ? body.action : 'totals';
    if (action !== 'create') {
      const { values } = kfCreate.parseQuoteForm(body);
      // parseQuoteForm drops blank lines; keep the date and reference as typed
      if (action === 'addLine') values.lines.push({ description: '', quantity: '', rate: '', vat: '20', nominal: String(body.defaultNominal || '') });
      return await renderQuoteForm(req, res, next, values);
    }
    const r = await kfCreate.createQuote(req.params.uuid, req.params.quoteId, body);
    flashCreated(req, 'Quote', r);
    res.redirect(`${jobUrl(req.params.uuid)}#quotes`);
  } catch (err) {
    if (err.status === 400 && err.form) {
      return renderQuoteForm(req, res, next, err.form.values, err.form.errors).catch(next);
    }
    backOnError(req, res, next, err, jobUrl(req.params.uuid), /register entry no longer exists/.test(err.message) ? '/job-register' : jobUrl(req.params.uuid));
  }
};

/** POST /job-register/:uuid/kashflow-project */
export const postKashflowProject = async (req, res, next) => {
  try {
    const r = await kfCreate.createProject(req.params.uuid);
    flashCreated(req, 'Project', r);
    res.redirect(jobUrl(req.params.uuid));
  } catch (err) {
    backOnError(req, res, next, err, jobUrl(req.params.uuid), /register entry no longer exists/.test(err.message) ? '/job-register' : jobUrl(req.params.uuid));
  }
};

function flashCreated(req, label, r) {
  if (!r.picked) return req.flash('success', `${label} ${r.number} created in KashFlow.`);
  if (r.rowNotUpdated) {
    return req.flash('error', `${label} ${r.rowNumber} was taken in KashFlow, so it was created as ${r.number}. Another quote or job in the register already uses ${r.number}, so this one still says ${r.rowNumber}: fix the numbers.`);
  }
  return req.flash('success', `${label} ${r.rowNumber} was taken in KashFlow, so it was created as ${r.number}. The register now says ${r.number}.`);
}

export default {
  getKashflowQuote, postKashflowQuote, postKashflowProject, getLinkClients, postLinkClients, postLinkFromKashflow,
  getRegister, postFillNext, postFillNextEdit, postCreate, getShow, getEdit, postUpdate,
  postAddQuote, postUpdateQuote, postRemoveQuote, postAddInvoice, postUpdateInvoice, postRemoveInvoice, readFilters,
};
