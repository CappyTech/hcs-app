// Workbook imports: the Job Reg and WEEKLY ATTENDANCE spreadsheets, uploaded
// once to bring their history into the Job Register and attendance.
//
// Both go upload → check → import. The upload is parsed and parked
// (workbookImport, expires after a day); the check page shows what will
// happen (and, for the weekly sheet, asks which person and site each name
// on the sheet is); nothing is written until the import button.
import path from 'path';
import multer from 'multer';
import logger from '../../services/loggerService.js';
import csrfService from '../../services/csrfService.js';
import xlsx from '../services/xlsxReaderService.js';
import jobImport from '../services/jobRegisterImportService.js';
import sheetImport from '../services/weeklySheetImportService.js';
import overviewEngine from '../services/overviewEngine.js';

const VIEW = (name) => path.join('tailwindcss', 'import', name);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => cb(null, xlsx.isXlsxUpload(file)),
  limits: { fileSize: xlsx.MAX_UPLOAD_BYTES, files: 1 },
});

/** multer, with its errors (too big) sent back to the upload page as a message. */
const receiveFile = (back) => (req, res, next) => {
  upload.single('workbook')(req, res, (err) => {
    if (!err) return next();
    req.flash('error', err.code === 'LIMIT_FILE_SIZE' ? 'That file is too big (10 MB at most).' : "That file couldn't be uploaded.");
    res.redirect(back);
  });
};

/** Read and park an upload; redirects to its check page, or back with a message. */
const stage = (back, stageFn, checkPath) => [
  receiveFile(back),
  csrfService.validate,
  async (req, res, next) => {
    if (!req.file) {
      req.flash('error', 'Choose the workbook (.xlsx) to upload.');
      return res.redirect(back);
    }
    try {
      const sheets = await xlsx.readWorkbook(req.file.buffer);
      const doc = await stageFn({ sheets, fileName: req.file.originalname, userId: req.user?._id });
      logger.info(`[workbookImport] ${req.user?.email || 'user'} uploaded ${req.file.originalname} (${doc.kind} ${doc.uuid})`);
      res.redirect(`${checkPath}/${doc.uuid}`);
    } catch (err) {
      if (err.status === 400) {
        req.flash('error', err.message);
        return res.redirect(back);
      }
      next(err);
    }
  },
];

const handle400s = (back) => (err, req, res, next) => {
  if (err.status === 400 || err.status === 404) {
    req.flash('error', err.message);
    return res.redirect(back);
  }
  next(err);
};

// ── Job Register ────────────────────────────────────────────────────────

const JR = '/job-register/import';
const jrCrumbs = (req) => [...overviewEngine.breadcrumbs(req, 'projects'), { label: 'Job Register', href: '/job-register' }];

/** GET /job-register/import */
export const getJobRegisterUpload = (req, res) => {
  res.render(VIEW('upload'), {
    title: 'Import the Job Reg workbook',
    crumbs: jrCrumbs(req),
    action: JR,
    heading: 'Import the Job Reg workbook',
    icon: 'bi-journal-text',
    intro: 'Brings the quotes and jobs from the Job Reg spreadsheet into the Job Register. You\'ll see what will be added before anything is saved.',
    points: [
      'Reads the Quotes and Job Reg sheets. Rows with a number but no site or client (the blank numbered rows) are skipped.',
      'A job is matched to the quote it was copied from by site, client and value, and they become one row. Near matches are listed for you to tick.',
      'Quotes and jobs already in the register are not overwritten: only their empty fields are filled in. Uploading the same workbook again adds only what\'s new.',
    ],
  });
};

/** POST /job-register/import */
export const postJobRegisterUpload = stage(JR, jobImport.stageUpload, JR);

/** GET /job-register/import/:uuid */
export const getJobRegisterCheck = async (req, res, next) => {
  try {
    const data = await jobImport.loadPreview(req.params.uuid);
    res.render(VIEW('job-register'), {
      title: 'Check the Job Reg import',
      crumbs: jrCrumbs(req),
      ...data,
    });
  } catch (err) {
    handle400s(JR)(err, req, res, next);
  }
};

/** POST /job-register/import/:uuid */
export const postJobRegisterImport = async (req, res, next) => {
  try {
    const r = await jobImport.runImport(req.params.uuid, req.body.pair);
    const parts = [`Added ${plural(r.created, 'row')}`, `filled in ${plural(r.updated, 'existing row')}`];
    if (r.unchanged) parts.push(`${r.unchanged} already up to date`);
    req.flash('success', `${parts.join(', ')}.`);
    if (r.conflicts || r.failed.length) {
      const why = r.failed.slice(0, 3).map((f) => `${f.label}: ${f.reason}`).join('; ');
      req.flash('error', `${plural(r.conflicts + r.failed.length, 'row')} not imported${why ? ` (${why})` : ''}. Check those in the register by hand.`);
    }
    res.redirect('/job-register');
  } catch (err) {
    handle400s(JR)(err, req, res, next);
  }
};

// ── Weekly sheet ────────────────────────────────────────────────────────

const WS = '/weekly-sheet/import';
const wsCrumbs = (req) => [...overviewEngine.breadcrumbs(req, 'weekly'), { label: 'Weekly sheet', href: '/weekly-sheet' }];

/** GET /weekly-sheet/import */
export const getWeeklySheetUpload = (req, res) => {
  res.render(VIEW('upload'), {
    title: 'Import the weekly attendance workbook',
    crumbs: wsCrumbs(req),
    action: WS,
    heading: 'Import the weekly attendance workbook',
    icon: 'bi-calendar-week',
    intro: 'Brings the weekly tabs of the WEEKLY ATTENDANCE spreadsheet into attendance. Next you\'ll match each name and site on the sheet to a person and a contract or location; nothing is saved until you import.',
    points: [
      'Reads every tab with a week of dates over MON … SAT. Monday to Saturday are imported; the Sunday column (hours and pay) isn\'t.',
      'Sites and locations become work days, OFF becomes off and Sick becomes sick. Holidays aren\'t imported: approved holiday requests are the record of leave.',
      'Every record is pending, for the usual approval. Days that already have attendance, days in a locked payroll period and days after today are left alone.',
    ],
  });
};

/** POST /weekly-sheet/import */
export const postWeeklySheetUpload = stage(WS, sheetImport.stageUpload, WS);

/** GET /weekly-sheet/import/:uuid */
export const getWeeklySheetMapping = async (req, res, next) => {
  try {
    const data = await sheetImport.loadMapping(req.params.uuid);
    res.render(VIEW('weekly-sheet'), {
      title: 'Match the weekly sheet',
      crumbs: wsCrumbs(req),
      ...data,
    });
  } catch (err) {
    handle400s(WS)(err, req, res, next);
  }
};

/** POST /weekly-sheet/import/:uuid */
export const postWeeklySheetImport = async (req, res, next) => {
  try {
    const r = await sheetImport.runImport(req.params.uuid, req.body || {});
    const s = r.skipped;
    let msg = `Imported ${plural(r.created, 'day')} of attendance across ${plural(r.weeks, 'week')}, all pending approval.`;
    if (r.createdLocations) msg += ` Added ${plural(r.createdLocations, 'location')}.`;
    req.flash('success', msg);
    const left = [
      s.existing && `${s.existing} already recorded`,
      s.person && `${s.person} for names you skipped`,
      s.place && `${s.place} at sites you skipped`,
      s.locked && `${s.locked} in locked payroll periods`,
      s.future && `${s.future} after today`,
      s.duplicate && `${s.duplicate} where two names were the same person`,
      r.failed && `${r.failed} that couldn't be saved`,
    ].filter(Boolean);
    if (left.length) req.flash('error', `Not imported: ${left.join(', ')}.`);
    res.redirect('/weekly-sheet');
  } catch (err) {
    handle400s(WS)(err, req, res, next);
  }
};

export default {
  getJobRegisterUpload, postJobRegisterUpload, getJobRegisterCheck, postJobRegisterImport,
  getWeeklySheetUpload, postWeeklySheetUpload, getWeeklySheetMapping, postWeeklySheetImport,
};
