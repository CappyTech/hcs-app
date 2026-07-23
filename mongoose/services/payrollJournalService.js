/**
 * payrollJournalService.js
 *
 * Builds and posts a double-entry payroll journal to KashFlow for a locked
 * payroll run.  Requires nominal codes to be configured in PayrollConfig.
 *
 * Debit/Credit structure per payroll period:
 *
 *  Dr  Gross Wages nominal          (grossPay)
 *  Dr  Employer NI Expense nominal  (employerNI)
 *  Dr  Employer Pension Expense nom (employerPension)
 *  Cr  Net Pay Control              (netPay + employeePension)
 *  Cr  PAYE/NI Control              (taxDeducted + employeeNI + employerNI)
 *  Cr  Pension Control              (employeePension + employerPension)
 *
 * Note: Employee pension is salary sacrifice (reduces net pay and gross).
 * For a non-salary-sacrifice scheme, employee pension is added to net pay
 * control; for salary sacrifice it is already deducted from gross.  We post
 * it to pension control regardless and let the nominal reconcile.
 */

import axios from 'axios';
import mdb from '../services/mongooseDatabaseService.js';
import kfSession from '../../services/kashflowSessionService.js';
import logger from '../../services/loggerService.js';

const KF_BASE_URL = () =>
  (process.env.KASHFLOW_API_BASE_URL || 'https://api.kashflow.com/v2').replace(/\/+$/, '');

/**
 * Converts a Decimal128 (or any value) to a plain JS number.
 */
function toNum(v) {
  if (v == null) return 0;
  if (typeof v === 'object' && typeof v.toString === 'function') return Number(v.toString());
  return Number(v) || 0;
}

/**
 * Rounds to 2 decimal places (half-up).
 */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Checks that the required nominal codes are configured.
 */
function validateNominals(nominals) {
  const required = ['grossWages', 'employerNI', 'employerPension', 'payeNiControl', 'netPayControl', 'pensionControl'];
  const missing = required.filter(k => !nominals[k]);
  if (missing.length > 0) {
    throw new Error(`Payroll journal: missing nominal codes: ${missing.join(', ')}. Configure in Settings → Payroll.`);
  }
}

/**
 * Builds the KashFlow journal lines for a payroll run.
 *
 * Returns an array of line objects in the KashFlow journal format:
 *   { NominalCode, Description, Amount, Debit: true|false }
 */
function buildJournalLines(runTotals, nominals, periodLabel) {
  validateNominals(nominals);

  const gross       = round2(toNum(runTotals.grossPay));
  const tax         = round2(toNum(runTotals.taxDeducted));
  const empNI       = round2(toNum(runTotals.employeeNI));
  const erpNI       = round2(toNum(runTotals.employerNI));
  const empPension  = round2(toNum(runTotals.employeePension));
  const erpPension  = round2(toNum(runTotals.employerPension));
  const netPay      = round2(toNum(runTotals.netPay));

  // Derived control totals
  const payeNiTotal   = round2(tax + empNI + erpNI);
  const pensionTotal  = round2(empPension + erpPension);
  // Net pay control = gross - tax - empNI - empPension (what the company owes to employees' bank accounts)
  const netPayControl = round2(netPay);

  return [
    // ── Debit lines ────────────────────────────────────────────────────
    {
      NominalCode: nominals.grossWages,
      Description: `Gross Wages — ${periodLabel}`,
      Amount: gross,
      Debit: true
    },
    {
      NominalCode: nominals.employerNI,
      Description: `Employer NI — ${periodLabel}`,
      Amount: erpNI,
      Debit: true
    },
    {
      NominalCode: nominals.employerPension,
      Description: `Employer Pension — ${periodLabel}`,
      Amount: erpPension,
      Debit: true
    },

    // ── Credit lines ───────────────────────────────────────────────────
    {
      NominalCode: nominals.netPayControl,
      Description: `Net Pay Control — ${periodLabel}`,
      Amount: netPayControl,
      Debit: false
    },
    {
      NominalCode: nominals.payeNiControl,
      Description: `PAYE & NI Control — ${periodLabel}`,
      Amount: payeNiTotal,
      Debit: false
    },
    {
      NominalCode: nominals.pensionControl,
      Description: `Pension Control — ${periodLabel}`,
      Amount: pensionTotal,
      Debit: false
    }
  ];
}

/**
 * How long an in-flight posting claim blocks other posters before it is
 * considered abandoned (crashed process, lost connection) and can be taken
 * over. Must comfortably exceed the 30s KashFlow request timeout.
 */
const JOURNAL_CLAIM_STALE_MS = 5 * 60 * 1000;

/**
 * Posts the payroll journal to KashFlow and saves the journal reference on
 * the run document.
 *
 * Double-submit safe: the run is claimed atomically before the HTTP call, so
 * concurrent submits (double-click, two tabs, retried request) cannot both
 * post. The KashFlow Reference is deterministic (PAY-<uuid8>), so if an
 * ambiguous failure ever leaves the outcome unknown, the journal can be found
 * in KashFlow by reference before retrying.
 *
 * @param {string} runUuid  – the uuid of the payrollRun
 * @returns {string}         the KashFlow journal reference/ID
 */
async function postPayrollJournal(runUuid) {
  const PayrollRun   = mdb.INTERNAL?.payrollRun;
  const PayrollConfig = mdb.INTERNAL?.payrollConfig;

  if (!PayrollRun || !PayrollConfig) {
    throw new Error('Database not ready — payrollRun or payrollConfig model unavailable');
  }

  // Atomically claim the run: only matches a locked, unposted run with no
  // live claim. Check-then-act would race across the 30s KashFlow call.
  const staleCutoff = new Date(Date.now() - JOURNAL_CLAIM_STALE_MS);
  const run = await PayrollRun.findOneAndUpdate(
    {
      uuid: runUuid,
      status: 'locked',
      kashflowJournalRef: null,
      $or: [{ journalPostingAt: null }, { journalPostingAt: { $lt: staleCutoff } }]
    },
    { $set: { journalPostingAt: new Date(), journalLastError: null } },
    { new: true }
  ).lean();

  if (!run) {
    // Claim failed — diagnose why for a useful error message
    const existing = await PayrollRun.findOne({ uuid: runUuid })
      .select('status kashflowJournalRef journalPostingAt').lean();
    if (!existing) throw new Error(`Payroll run not found: ${runUuid}`);
    if (existing.kashflowJournalRef) throw new Error(`Journal already posted for this run (ref: ${existing.kashflowJournalRef})`);
    if (existing.status !== 'locked') throw new Error('Only locked runs can be posted to KashFlow');
    throw new Error('A journal posting for this run is already in progress — wait for it to finish before retrying.');
  }

  const reference = `PAY-${runUuid.slice(0, 8).toUpperCase()}`;

  try {
    const config = await PayrollConfig.findOne().lean();
    if (!config?.kashflowNominals) {
      throw new Error('Payroll nominal codes not configured. Go to Settings → Payroll to set them up.');
    }

    const nominals = config.kashflowNominals;
    const paymentDate = new Date(run.paymentDate).toISOString().split('T')[0];
    const periodLabel = `${run.taxYear} ${run.frequency} W${run.taxWeek || '-'}M${run.taxMonth || '-'}`;

    const lines = buildJournalLines(run.totals, nominals, periodLabel);

    // Verify debits = credits (within 1p rounding tolerance)
    const debitTotal  = round2(lines.filter(l => l.Debit).reduce((s, l) => s + l.Amount, 0));
    const creditTotal = round2(lines.filter(l => !l.Debit).reduce((s, l) => s + l.Amount, 0));
    if (Math.abs(debitTotal - creditTotal) > 0.02) {
      logger.warn(`payrollJournal: imbalanced journal (Dr £${debitTotal} vs Cr £${creditTotal}) for run ${runUuid}`);
    }

    const journalPayload = {
      Date: paymentDate,
      Description: `Payroll — ${periodLabel}`,
      Reference: reference,
      Lines: lines
    };

    logger.info(`payrollJournalService: posting journal to KashFlow for run ${runUuid}`);

    const journalRef = await kfSession.withKfAuth(async (token) => {
      const resp = await axios.post(
        `${KF_BASE_URL()}/journals`,
        journalPayload,
        {
          headers: {
            Authorization: `KfToken ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          timeout: 30000
        }
      );
      // KashFlow returns the created journal ID/reference
      const data = resp.data || {};
      return data.Id || data.JournalId || data.Reference || journalPayload.Reference;
    });

    await PayrollRun.updateOne(
      { _id: run._id },
      { $set: { kashflowJournalRef: String(journalRef), journalPostedAt: new Date(), journalPostingAt: null } }
    );

    logger.info(`payrollJournalService: journal posted, ref=${journalRef}, run=${runUuid}`);
    return String(journalRef);
  } catch (err) {
    // Ambiguous outcomes — request reached KashFlow but the response was lost
    // (timeout, connection drop, 5xx) — mean the journal MAY exist there.
    const status = err?.response?.status;
    const ambiguous = err.code === 'ECONNABORTED' || (!err.response && !!err.request) || (status != null && status >= 500);
    const note = ambiguous
      ? ` The journal may still have been created in KashFlow — search for reference ${reference} there before retrying.`
      : '';

    // Release the claim and record the failure on the run
    await PayrollRun.updateOne(
      { _id: run._id },
      { $set: { journalPostingAt: null, journalLastError: `${err.message}${note}`.slice(0, 500) } }
    ).catch(releaseErr => {
      logger.error(`payrollJournalService: failed to release posting claim for ${runUuid}: ${releaseErr.message}`);
    });

    err.message = `${err.message}${note}`;
    throw err;
  }
}

export default { buildJournalLines, postPayrollJournal, JOURNAL_CLAIM_STALE_MS };
