// Staffology pay next to hcs-app attendance. Read-only views over the
// STAFFOLOGY namespace (written by hcs-sync), plus linking a Staffology
// employee to an hcs-app employee by payroll ID.
import path from 'path';
import mdb from '../services/mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';
import provider from '../services/payrollProviderService.js';

const view = (name) => path.join('tailwindcss', 'payroll', name);

const fmtMoney = (n) => (n == null ? '—' : `£${Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' }) : '—');
const taxYearLabel = (y) => (y ? `${y}/${String(y + 1).slice(-2)}` : '');

export const renderComparison = async (req, res, next) => {
  try {
    const periods = await provider.listPeriods();
    if (!periods.length) {
      return res.render(view('staffology'), {
        title: 'Staffology pay vs attendance',
        periods, selected: null, comparison: null,
        FLAGS: provider.FLAGS, fmtMoney, fmtDate, taxYearLabel, periodKey: provider.periodKey,
      });
    }

    const wanted = provider.parsePeriodKey(req.query.period);
    // Default: the latest period on the company's pay frequency (fall back to the latest of any kind).
    const selected = (wanted && periods.find((p) => provider.periodKey(p) === provider.periodKey(wanted)))
      || periods.find((p) => p.PayPeriod === provider.payFrequency())
      || periods[0];

    const comparison = await provider.loadComparison(selected);
    res.render(view('staffology'), {
      title: 'Staffology pay vs attendance',
      periods, selected, comparison,
      FLAGS: provider.FLAGS, fmtMoney, fmtDate, taxYearLabel, periodKey: provider.periodKey,
    });
  } catch (err) {
    next(err);
  }
};

export const renderEmployees = async (req, res, next) => {
  try {
    const matches = await provider.loadEmployeeMatches();
    res.render(view('staffologyEmployees'), {
      title: 'Staffology employees',
      matches,
      payrollName: provider.payrollName,
      fmtMoney, fmtDate,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Link: set employee.payroll.payrollId to a Staffology payroll code. Refused
 * when another employee already has that code, or the code isn't one
 * Staffology knows.
 */
export const linkEmployee = async (req, res, next) => {
  const back = '/payroll/staffology/employees';
  try {
    const Employee = mdb.INTERNAL?.employee;
    const PayrollEmployee = mdb.STAFFOLOGY?.payrollemployee;
    const code = String(req.body.payrollCode || '').trim();
    const employeeUuid = String(req.params.uuid || req.body.employeeUuid || '').trim();
    if (!employeeUuid) {
      req.flash?.('error', 'Choose the hcs-app employee to link.');
      return res.redirect(back);
    }
    if (!Employee || !PayrollEmployee) {
      req.flash?.('error', 'Staffology data is not available.');
      return res.redirect(back);
    }
    if (!code || code.length > 35) {
      req.flash?.('error', 'Choose a Staffology payroll code to link.');
      return res.redirect(back);
    }

    const [employee, known, taken] = await Promise.all([
      Employee.findOne({ uuid: employeeUuid }),
      PayrollEmployee.exists({ PayrollCode: code }),
      Employee.findOne({ 'payroll.payrollId': code, uuid: { $ne: employeeUuid } }).select('name').lean(),
    ]);
    if (!employee) {
      req.flash?.('error', 'Employee not found.');
      return res.redirect(back);
    }
    if (!known) {
      req.flash?.('error', 'That payroll code is not in the Staffology data.');
      return res.redirect(back);
    }
    if (taken) {
      req.flash?.('error', `Payroll code ${code} is already linked to ${taken.name}. Unlink it there first.`);
      return res.redirect(back);
    }

    employee.set('payroll.payrollId', code);
    await employee.save();
    logger.info(`payrollProvider: linked employee ${employee.uuid} to payroll code (by ${req.session?.user?.id || 'unknown'})`);
    req.flash?.('success', `${employee.name} linked to Staffology payroll code ${code}.`);
    res.redirect(back);
  } catch (err) {
    next(err);
  }
};

export default { renderComparison, renderEmployees, linkEmployee };
