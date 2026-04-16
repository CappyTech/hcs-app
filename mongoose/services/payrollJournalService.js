'use strict';

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

const axios = require('axios');
const mdb = require('../services/mongooseDatabaseService');
const kfSession = require('../../services/kashflowSessionService');
const logger = require('../../services/loggerService');

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
 * Posts the payroll journal to KashFlow and saves the journal reference on
 * the run document.
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

  const run = await PayrollRun.findOne({ uuid: runUuid });
  if (!run) throw new Error(`Payroll run not found: ${runUuid}`);
  if (run.status !== 'locked') throw new Error('Only locked runs can be posted to KashFlow');
  if (run.kashflowJournalRef) throw new Error(`Journal already posted for this run (ref: ${run.kashflowJournalRef})`);

  const config = await PayrollConfig.findOne().lean();
  if (!config?.kashflowNominals) {
    throw new Error('Payroll nominal codes not configured. Go to Settings → Payroll to set them up.');
  }

  const nominals = config.kashflowNominals;
  const paymentDate = run.paymentDate.toISOString().split('T')[0];
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
    Reference: `PAY-${runUuid.slice(0, 8).toUpperCase()}`,
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

  run.kashflowJournalRef = String(journalRef);
  run.journalPostedAt = new Date();
  await run.save();

  logger.info(`payrollJournalService: journal posted, ref=${journalRef}, run=${runUuid}`);
  return String(journalRef);
}

module.exports = { buildJournalLines, postPayrollJournal };
