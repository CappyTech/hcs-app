import mdb from './mongooseDatabaseService.js';
import taxService from '../../services/taxService.js';

/**
 * Builds data for the payroll overview page.
 *
 * Returns:
 *  - Current tax year summary (runs, totals, YTD)
 *  - Monthly breakdown (runs per tax month)
 *  - Employees on payroll summary
 *  - Recent submissions (FPS/EPS)
 *  - Next RTI deadline
 *  - Draft / locked / submitted run counts
 */
async function getPayrollOverview() {
  const PayrollRun        = mdb.INTERNAL?.payrollRun;
  const PayrollEntry      = mdb.INTERNAL?.payrollEntry;
  const PayrollSubmission = mdb.INTERNAL?.payrollSubmission;
  const Employee          = mdb.INTERNAL?.employee;

  if (!PayrollRun) throw new Error('Database not ready — payrollRun model unavailable');

  const now          = new Date();
  const currentYear  = taxService.getCurrentTaxYear();
  const taxYear      = `${currentYear}/${String(currentYear + 1).slice(-2)}`;
  const { taxMonth } = taxService.calculateTaxYearAndMonth(now);
  const nextDeadline = taxService.getCurrentMonthlyReturn(currentYear, taxMonth);

  // ── All runs for this tax year ─────────────────────────────────────────────
  const allRuns = await PayrollRun.find({ taxYear }).sort({ paymentDate: -1 }).lean();

  // Status counts
  const statusCounts = { draft: 0, locked: 0, submitted: 0 };
  for (const r of allRuns) statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;

  // YTD aggregated totals
  const ytdTotals = allRuns
    .filter(r => r.status !== 'draft')
    .reduce((acc, r) => {
      acc.grossPay        += toNum(r.totals?.grossPay);
      acc.taxDeducted     += toNum(r.totals?.taxDeducted);
      acc.employeeNI      += toNum(r.totals?.employeeNI);
      acc.employerNI      += toNum(r.totals?.employerNI);
      acc.employeePension += toNum(r.totals?.employeePension);
      acc.employerPension += toNum(r.totals?.employerPension);
      acc.netPay          += toNum(r.totals?.netPay);
      return acc;
    }, { grossPay: 0, taxDeducted: 0, employeeNI: 0, employerNI: 0, employeePension: 0, employerPension: 0, netPay: 0 });

  // ── Monthly breakdown (tax months 1–12) ────────────────────────────────────
  const monthlyBreakdown = {};
  for (const r of allRuns) {
    const m = r.taxMonth;
    if (!m) continue;
    if (!monthlyBreakdown[m]) {
      monthlyBreakdown[m] = { taxMonth: m, runs: 0, grossPay: 0, taxDeducted: 0, employeeNI: 0, employerNI: 0, netPay: 0, statuses: [] };
    }
    monthlyBreakdown[m].runs++;
    monthlyBreakdown[m].grossPay    += toNum(r.totals?.grossPay);
    monthlyBreakdown[m].taxDeducted += toNum(r.totals?.taxDeducted);
    monthlyBreakdown[m].employeeNI  += toNum(r.totals?.employeeNI);
    monthlyBreakdown[m].employerNI  += toNum(r.totals?.employerNI);
    monthlyBreakdown[m].netPay      += toNum(r.totals?.netPay);
    monthlyBreakdown[m].statuses.push(r.status);
  }
  const monthlyRows = Object.values(monthlyBreakdown)
    .sort((a, b) => a.taxMonth - b.taxMonth);

  // ── Recent 5 runs ──────────────────────────────────────────────────────────
  const recentRuns = allRuns.slice(0, 5);

  // ── Payroll-enrolled employees ─────────────────────────────────────────────
  let enrolledCount = 0, pensionEnrolledCount = 0;
  if (Employee) {
    const employees = await Employee.find({ status: 'active' }, { 'payroll.pensionEnrolled': 1, 'payroll.taxCode': 1, uuid: 1 }).lean();
    enrolledCount        = employees.length;
    pensionEnrolledCount = employees.filter(e => e.payroll?.pensionEnrolled).length;
  }

  // ── Recent HMRC submissions ────────────────────────────────────────────────
  const recentSubmissions = PayrollSubmission
    ? await PayrollSubmission.find({ taxYear })
        .sort({ createdAt: -1 })
        .limit(8)
        .lean()
    : [];

  // Submission status counts
  const subStatusCounts = {};
  if (PayrollSubmission) {
    const allSubs = await PayrollSubmission.find({ taxYear }).lean();
    for (const s of allSubs) subStatusCounts[s.status] = (subStatusCounts[s.status] || 0) + 1;
  }

  return {
    taxYear,
    taxMonth,
    nextDeadline,
    allRuns,
    recentRuns,
    statusCounts,
    ytdTotals,
    monthlyRows,
    enrolledCount,
    pensionEnrolledCount,
    recentSubmissions,
    subStatusCounts
  };
}

function toNum(v) {
  if (v == null) return 0;
  if (typeof v === 'object' && typeof v.toString === 'function') return Number(v.toString());
  return Number(v) || 0;
}

export default { getPayrollOverview };
