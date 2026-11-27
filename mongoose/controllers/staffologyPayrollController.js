// Payroll pages in Staffology mode (services/staffologyModeService.js): the
// dashboard, pay run list and employee payroll page show the synced Staffology
// data instead of the in-house pay-run engine, plus payslips and My pay.
//
// Payslips are fetched live from Staffology for one entry at a time and
// streamed back (services/staffologyPayslipService.js); nothing is stored.
import path from 'path';
import mdb from '../services/mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';
import taxService from '../../services/taxService.js';
import auditLogService from '../../services/auditLogService.js';
import provider from '../services/payrollProviderService.js';
import payslips from '../../services/staffologyPayslipService.js';

const view = (...p) => path.join('tailwindcss', ...p);

export const fmtMoney = (n) => (n == null ? '—' : `£${Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' }) : '—');
export const taxYearLabel = (y) => (y ? `${y}/${String(Number(y) + 1).slice(-2)}` : '');
const helpers = { fmtMoney, fmtDate, taxYearLabel, periodKey: provider.periodKey };

const notFound = (res, message = 'Not found.') =>
  res.status(404).render(view('error'), { title: '404', error: { title: '404', message } });

function pickYear(req, years) {
  const wanted = Number(req.query.year);
  if (years.includes(wanted)) return wanted;
  const current = taxService.getCurrentTaxYear();
  return years.includes(current) ? current : (years[0] || current);
}

// ── Dashboard ────────────────────────────────────────────────────────────────

export const renderDashboard = async (req, res, next) => {
  try {
    const years = await provider.listTaxYears();
    const taxYear = pickYear(req, years);
    const [summary, monthly] = years.length
      ? await Promise.all([provider.dashboardSummary(taxYear), provider.monthlySummary(taxYear)])
      : [null, null];
    res.render(view('payroll', 'staffologyDashboard'), {
      title: 'Payroll',
      years, taxYear, summary, monthly, FLAGS: provider.FLAGS, ...helpers,
    });
  } catch (err) { next(err); }
};

// ── Pay runs ─────────────────────────────────────────────────────────────────

export const renderRuns = async (req, res, next) => {
  try {
    const years = await provider.listTaxYears();
    const taxYear = pickYear(req, years);
    const runs = years.length ? await provider.listRuns({ taxYear }) : [];
    res.render(view('payroll', 'staffologyRuns'), {
      title: 'Pay runs',
      years, taxYear, runs, ...helpers,
    });
  } catch (err) { next(err); }
};

// ── Employee payroll ─────────────────────────────────────────────────────────

export const renderEmployeePayroll = async (req, res, next) => {
  try {
    const Employee = mdb.INTERNAL?.employee;
    const employee = await Employee?.findOne({ uuid: req.params.uuid }).select('name uuid status payroll.payrollId').lean();
    if (!employee) return notFound(res, 'Employee not found.');
    const code = employee.payroll?.payrollId;
    const [record, entries] = await Promise.all([
      provider.payrollEmployeeByCode(code).catch(() => null),
      provider.entriesForPayrollCode(code).catch(() => []),
    ]);
    res.render(view('payroll', 'staffologyEmployeePayroll'), {
      title: `Payroll — ${employee.name || 'Employee'}`,
      employee, record, years: provider.groupByTaxYear(entries),
      payrollName: provider.payrollName,
      ...helpers,
    });
  } catch (err) { next(err); }
};

/** Staffology mode: only the Payroll ID (the link to Staffology) is editable here. */
export const saveEmployeePayrollId = async (req, res, next) => {
  const back = `/payroll/employee/${encodeURIComponent(req.params.uuid)}`;
  try {
    const Employee = mdb.INTERNAL?.employee;
    const employee = await Employee?.findOne({ uuid: req.params.uuid });
    if (!employee) return notFound(res, 'Employee not found.');
    const code = String(req.body.payrollId || '').trim();
    if (code.length > 35) {
      req.flash?.('error', 'A payroll ID is at most 35 characters.');
      return res.redirect(back);
    }
    if (code) {
      const taken = await Employee.findOne({ 'payroll.payrollId': code, uuid: { $ne: employee.uuid } }).select('name').lean();
      if (taken) {
        req.flash?.('error', `Payroll ID ${code} is already on ${taken.name}.`);
        return res.redirect(back);
      }
    }
    employee.set('payroll.payrollId', code || null);
    await employee.save();
    req.flash?.('success', code ? 'Payroll ID saved.' : 'Payroll ID cleared.');
    res.redirect(back);
  } catch (err) { next(err); }
};

// ── Payslips ─────────────────────────────────────────────────────────────────

async function sendPayslip(req, res, entry, { self }) {
  try {
    const { pdf, filename } = await payslips.payslipFor(entry);
    auditLogService.record('payslip_viewed', req, {
      userId: req.user?._id,
      username: req.user?.username,
      meta: { entry: entry.uuid, taxYear: entry.TaxYear, payPeriod: entry.PayPeriod, period: entry.Period, self },
    });
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.send(pdf);
  } catch (err) {
    logger.warn(`[payslip] ${err.message}`);
    req.flash?.('error', err.message);
    return res.redirect(self ? '/my-pay' : '/payroll/staffology');
  }
}

/** Payroll staff: any entry. */
export const staffPayslip = async (req, res, next) => {
  try {
    const entry = await provider.entryByUuid(req.params.entryUuid);
    if (!entry) return notFound(res, 'Pay entry not found.');
    return sendPayslip(req, res, entry, { self: false });
  } catch (err) { next(err); }
};

// ── My pay (self-service) ────────────────────────────────────────────────────

/** The signed-in user's employee and payroll code, if linked. */
export async function myPayrollCode(user) {
  const employeeId = user?.employeeId;
  if (!employeeId) return { employee: null, code: null };
  const employee = await mdb.INTERNAL?.employee?.findById(employeeId).select('name uuid payroll.payrollId').lean();
  const code = employee?.payroll?.payrollId ? String(employee.payroll.payrollId).trim() : null;
  return { employee: employee || null, code };
}

/** May this user see this entry? Only their own payroll code (pure). */
export function ownsEntry(code, entry) {
  return Boolean(code && entry && String(entry.PayrollCode || '').trim().toLowerCase() === String(code).trim().toLowerCase());
}

export const renderMyPay = async (req, res, next) => {
  try {
    const { employee, code } = await myPayrollCode(req.user);
    const entries = code ? await provider.entriesForPayrollCode(code) : [];
    res.render(view('myPay', 'index'), {
      title: 'My pay',
      linked: Boolean(employee && code),
      years: provider.groupByTaxYear(entries),
      ...helpers,
    });
  } catch (err) { next(err); }
};

export const myPayslip = async (req, res, next) => {
  try {
    const [{ code }, entry] = await Promise.all([
      myPayrollCode(req.user),
      provider.entryByUuid(req.params.entryUuid),
    ]);
    // Someone else's entry looks exactly like a missing one.
    if (!ownsEntry(code, entry)) return notFound(res, 'Payslip not found.');
    return sendPayslip(req, res, entry, { self: true });
  } catch (err) { next(err); }
};

export default {
  renderDashboard,
  renderRuns,
  renderEmployeePayroll,
  saveEmployeePayrollId,
  staffPayslip,
  renderMyPay,
  myPayslip,
  myPayrollCode,
  ownsEntry,
};
