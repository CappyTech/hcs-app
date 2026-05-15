'use strict';

/**
 * peoplesPensionService.js
 *
 * Generates a People's Pension contribution CSV and provides an API stub
 * for future direct-upload integration.
 *
 * CSV format follows The People's Pension contribution upload specification:
 *   Employer Reference, Member ID, Forename, Surname, NI Number,
 *   Employee Contribution, Employer Contribution, Payment Date
 *
 * Reference: https://thepeoplespension.co.uk/employers/
 */

const encSvc   = require('./encryptionService');
const mdb      = require('../mongoose/services/mongooseDatabaseService');
const logger   = require('./loggerService');

function safeDecrypt(enc) {
  if (!enc) return '';
  try { return encSvc.decrypt(enc); } catch { return ''; }
}

function toNum(v) {
  if (v == null) return 0;
  if (typeof v === 'object' && typeof v.toString === 'function') return Number(v.toString());
  return Number(v) || 0;
}

function fmtMoney(v) { return toNum(v).toFixed(2); }
function fmtDate(d)  { return d instanceof Date ? d.toISOString().split('T')[0] : String(d || '').split('T')[0]; }

// CSV cell escaping (RFC 4180)
function csvCell(value) {
  const s = String(value == null ? '' : value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(fields) {
  return fields.map(csvCell).join(',') + '\r\n';
}

/**
 * Generates a contribution CSV for uploading to People's Pension.
 *
 * @param {object} run      – payrollRun document (lean)
 * @param {Array}  entries  – payrollEntry documents with employeeId populated
 * @returns {Promise<Buffer>} UTF-8 CSV
 */
async function generateContributionsCSV(run, entries) {
  const PayrollConfig = mdb.INTERNAL?.payrollConfig;
  if (!PayrollConfig) throw new Error('Database not ready — payrollConfig model unavailable');

  const config = await PayrollConfig.findOne().lean();
  const employerRef = safeDecrypt(config?.pensionEmployerRef) || (config?.kashflowNominals?.grossWages ? '' : '');

  const paymentDate = fmtDate(run.paymentDate);

  let csv = csvRow([
    'Employer Reference',
    'Member ID',
    'Forename',
    'Surname',
    'NI Number',
    'Employee Contribution',
    'Employer Contribution',
    'Payment Date'
  ]);

  for (const entry of entries) {
    const emp = entry.employeeId || {};
    const payroll = emp.payroll || {};

    // Only include enrolled employees with contributions
    const empPension = toNum(entry.employeePension);
    const erpPension = toNum(entry.employerPension);
    if (!payroll.pensionEnrolled && empPension === 0 && erpPension === 0) continue;

    const niNumber = safeDecrypt(payroll.niNumber) || '';
    const nameParts = (emp.name || '').trim().split(/\s+/);
    const forename = nameParts[0] || '';
    const surname  = nameParts.slice(1).join(' ') || '';
    const memberId = payroll.payrollId || emp.uuid?.slice(0, 8) || '';

    csv += csvRow([
      employerRef,
      memberId,
      forename,
      surname,
      niNumber,
      fmtMoney(empPension),
      fmtMoney(erpPension),
      paymentDate
    ]);
  }

  logger.info(`[peoplesPensionService] Generated CSV for run ${run.uuid}, ${entries.length} entries`);
  return Buffer.from(csv, 'utf-8');
}

/**
 * Submits pension contributions via the People's Pension API.
 *
 * This is currently a STUB — the People's Pension API integration requires
 * separate credentials and an API contract with the provider.
 *
 * When credentials are configured (PEOPLES_PENSION_API_KEY env var), this
 * method will perform the upload; otherwise it throws an informative error.
 *
 * @param {object} run     – payrollRun document
 * @param {Array}  entries – payrollEntry documents with employeeId populated
 */
async function submitViaAPI(run, entries) {
  const apiKey = process.env.PEOPLES_PENSION_API_KEY || '';
  if (!apiKey) {
    throw new Error(
      "People's Pension API credentials are not configured. " +
      "Use the CSV download instead, or configure PEOPLES_PENSION_API_KEY when the API integration is enabled."
    );
  }

  // Future: POST contributions to People's Pension API
  // const csvBuffer = await generateContributionsCSV(run, entries);
  // await axios.post('https://api.thepeoplespension.co.uk/v1/contributions', csvBuffer, {
  //   headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'text/csv' }
  // });

  throw new Error("People's Pension API integration is not yet available. Please use CSV download.");
}

module.exports = { generateContributionsCSV, submitViaAPI };
