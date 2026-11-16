import path from 'path';
import logger from '../../services/loggerService.js';
import jobRegister from '../services/jobRegisterService.js';
import jobImport from '../services/jobRegisterImportService.js';
import kfCreate from '../services/jobRegisterKashflowService.js';
import rbac from '../config/rolePermissionsConfig.js';
import overviewEngine from '../services/overviewEngine.js';

const VIEW = (name) => path.join('tailwindcss', 'jobRegister', name);

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
    logger.info(`[jobRegisterController] Added register entry ${doc.uuid}`);
    req.flash('success', `Added ${doc.projectNumber ? `job ${doc.projectNumber}` : `quote ${doc.quoteNumber}`}.`);
    res.redirect('/job-register');
  } catch (err) {
    if (err.status === 400) {
      req.flash('error', err.message);
      return res.redirect('/job-register#add');
    }
    next(err);
  }
};

async function renderEdit(req, res, next, fill = null) {
  const entry = await jobRegister.findEntry(req.params.uuid);
  if (!entry) return next({ statusCode: 404, message: 'That register entry no longer exists.' });
  const data = await jobRegister.loadRegister({});
  res.render(VIEW('edit'), {
    title: entry.projectNumber ? `Job ${entry.projectNumber}` : `Quote ${entry.quoteNumber}`,
    entry,
    stage: jobRegister.stageOf(entry),
    stageLabels: jobRegister.STAGE_LABELS,
    match: data.rows.find((r) => r.entry.uuid === entry.uuid)?.match || null,
    next: data.next,
    clients: data.clients,
    contracts: await jobRegister.contractChoices(entry.contractId?._id),
    customers: await jobRegister.customerChoices(),
    crumbs: [...overviewEngine.breadcrumbs(req, 'projects'), { label: 'Job Register', href: '/job-register' }],
    form: fill ? jobRegister.fillNext(fill, data.next) : null,
    // Create in KashFlow, for those who can edit the register (as the routes)
    canCreate: rbac.hasGroup(req.user, 'commercial', 'edit')
      ? { quote: !kfCreate.cannotCreate(entry, 'quote'), project: !kfCreate.cannotCreate(entry, 'project') }
      : { quote: false, project: false },
  });
}

/** GET /job-register/:uuid */
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
    res.redirect(`/job-register/${doc.uuid}`);
  } catch (err) {
    if (err.status === 400 || err.status === 404) {
      req.flash('error', err.message);
      return res.redirect(err.status === 404 ? '/job-register' : `/job-register/${encodeURIComponent(req.params.uuid)}`);
    }
    next(err);
  }
};

/** GET /job-register/link-clients: rows whose client isn't a KashFlow customer yet, by client. */
export const getLinkClients = async (req, res, next) => {
  try {
    const data = await jobImport.loadUnlinked();
    res.render(VIEW('link-clients'), {
      title: 'Link clients to KashFlow customers',
      ...data,
      crumbs: [...overviewEngine.breadcrumbs(req, 'projects'), { label: 'Job Register', href: '/job-register' }],
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

/** POST /job-register/link-clients/kashflow: link rows to the customer on their own KashFlow quote/project/invoice. */
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

const editUrl = (uuid) => `/job-register/${encodeURIComponent(uuid)}`;

async function renderQuoteForm(req, res, next, values = null, errors = {}) {
  const entry = await jobRegister.findEntry(req.params.uuid);
  if (!entry) return next({ statusCode: 404, message: 'That register entry no longer exists.' });
  const why = kfCreate.cannotCreate(entry, 'quote');
  if (why) {
    req.flash('error', why);
    return res.redirect(editUrl(entry.uuid));
  }
  const { nominals, defaultCode } = await kfCreate.nominalChoices();
  const form = values || kfCreate.quoteFormDefaults(entry, { nominal: defaultCode });
  const parsed = kfCreate.parseQuoteForm(form);
  res.render(VIEW('kashflow-quote'), {
    title: `Create quote ${entry.quoteNumber} in KashFlow`,
    entry,
    values: form,
    errors,
    totals: kfCreate.quoteTotals(parsed.lines),
    nominals,
    defaultNominal: defaultCode,
    vatChoices: kfCreate.VAT_CHOICES,
    crumbs: [...overviewEngine.breadcrumbs(req, 'projects'), { label: 'Job Register', href: '/job-register' },
      { label: `Quote ${entry.quoteNumber}`, href: editUrl(entry.uuid) }],
  });
}

/** GET /job-register/:uuid/kashflow-quote: the lines for the new KashFlow quote. */
export const getKashflowQuote = async (req, res, next) => {
  try {
    await renderQuoteForm(req, res, next);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /job-register/:uuid/kashflow-quote. action=addLine or totals shows the
 * form again (with a blank line, or the totals worked out); create sends it.
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
    const r = await kfCreate.createQuote(req.params.uuid, body);
    flashCreated(req, 'Quote', r);
    res.redirect(editUrl(req.params.uuid));
  } catch (err) {
    if (err.status === 400 && err.form) {
      return renderQuoteForm(req, res, next, err.form.values, err.form.errors).catch(next);
    }
    if (err.status === 400 || err.status === 404) {
      req.flash('error', err.message);
      return res.redirect(err.status === 404 ? '/job-register' : editUrl(req.params.uuid));
    }
    next(err);
  }
};

/** POST /job-register/:uuid/kashflow-project */
export const postKashflowProject = async (req, res, next) => {
  try {
    const r = await kfCreate.createProject(req.params.uuid);
    flashCreated(req, 'Project', r);
    res.redirect(editUrl(req.params.uuid));
  } catch (err) {
    if (err.status === 400 || err.status === 404) {
      req.flash('error', err.message);
      return res.redirect(err.status === 404 ? '/job-register' : editUrl(req.params.uuid));
    }
    next(err);
  }
};

function flashCreated(req, label, r) {
  if (!r.picked) return req.flash('success', `${label} ${r.number} created in KashFlow.`);
  if (r.rowNotUpdated) {
    return req.flash('error', `${label} ${r.rowNumber} was taken in KashFlow, so it was created as ${r.number}. Another register row already uses ${r.number}, so this row still says ${r.rowNumber}: fix the numbers.`);
  }
  return req.flash('success', `${label} ${r.rowNumber} was taken in KashFlow, so it was created as ${r.number}. This row now says ${r.number}.`);
}

export default { getKashflowQuote, postKashflowQuote, postKashflowProject, getLinkClients, postLinkClients, postLinkFromKashflow, getRegister, postFillNext, postFillNextEdit, postCreate, getEdit, postUpdate, readFilters };
