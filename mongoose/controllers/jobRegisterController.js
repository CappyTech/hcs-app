import path from 'path';
import logger from '../../services/loggerService.js';
import jobRegister from '../services/jobRegisterService.js';
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

/** GET /job-register */
export const getRegister = async (req, res, next) => {
  try {
    const filters = readFilters(req.query);
    const data = await jobRegister.loadRegister(filters);
    res.render(VIEW('index'), {
      title: 'Job Register',
      ...data,
      stageLabels: jobRegister.STAGE_LABELS,
      stages: jobRegister.STAGES,
      contracts: await jobRegister.contractChoices(),
      crumbs: overviewEngine.breadcrumbs(req, 'projects'),
      form: {},
    });
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

/** GET /job-register/:uuid */
export const getEdit = async (req, res, next) => {
  try {
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
      crumbs: [...overviewEngine.breadcrumbs(req, 'projects'), { label: 'Job Register', href: '/job-register' }],
    });
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

export default { getRegister, postCreate, getEdit, postUpdate, readFilters };
