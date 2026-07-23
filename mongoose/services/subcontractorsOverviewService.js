import mdb from './mongooseDatabaseService.js';
import { cisSupplierQuery, isCisSupplier, isHmrcVerified } from '../../services/cisService.js';

async function getSubcontractorsOverview() {
  const Supplier = mdb.REST?.supplier;
  if (!Supplier) throw new Error('Supplier model not loaded');

  const allSuppliers = await Supplier.find({}).lean();
  const totalCount = allSuppliers.length;

  // ── CIS rate breakdown ─────────────────────────────────────────────────────
  // CISRate field: null, 0, 0.2, 0.3
  const cisRateCounts = { '0%': 0, '20%': 0, '30%': 0, 'Not Set': 0 };
  for (const s of allSuppliers) {
    if (s.CISRate === 0) cisRateCounts['0%']++;
    else if (s.CISRate === 0.2) cisRateCounts['20%']++;
    else if (s.CISRate === 0.3) cisRateCounts['30%']++;
    else cisRateCounts['Not Set']++;
  }

  // ── CIS-applicable — any CIS indicator set ──────────────────────────────────
  const cisApplicable = allSuppliers.filter(isCisSupplier);
  const nonCIS = allSuppliers.filter(s => !isCisSupplier(s));

  // ── HMRC Verified — have a valid HMRC verification number ─────────────────
  const cisVerifiedCount = allSuppliers.filter(isHmrcVerified).length;

  // ── IR35 — suppliers linked to an employee ─────────────────────────────────
  let ir35Linked = [];
  try {
    const Employee = mdb.INTERNAL?.employee;
    if (Employee) {
      const ir35Employees = await Employee.find({ ir35: true, subcontractorSupplierId: { $ne: null } })
        .select('name uuid subcontractorSupplierId')
        .lean();

      const linkedSupplierIds = new Set(ir35Employees.map(e => e.subcontractorSupplierId?.toString()));
      const linkedSuppliers = allSuppliers.filter(s => linkedSupplierIds.has(s._id.toString()));

      // Enrich with employee name
      const supplierToEmp = Object.fromEntries(
        ir35Employees.map(e => [e.subcontractorSupplierId?.toString(), e])
      );
      ir35Linked = linkedSuppliers.map(s => ({
        ...s,
        _employee: supplierToEmp[s._id.toString()] || null,
      }));
    }
  } catch (_) {
    // Non-fatal
  }

  // ── Users with subcontractor role ──────────────────────────────────────────
  let subcontractorUsers = [];
  try {
    const User = mdb.INTERNAL?.user;
    if (User) {
      subcontractorUsers = await User.find({ role: 'subcontractor' })
        .select('uuid username email subcontractorId emailVerified')
        .lean();

      // Enrich with supplier name
      const subIds = subcontractorUsers.map(u => u.subcontractorId).filter(Boolean);
      if (subIds.length) {
        const sups = await Supplier.find({ _id: { $in: subIds } }).select('_id Name uuid').lean();
        const supMap = Object.fromEntries(sups.map(s => [s._id.toString(), s]));
        for (const u of subcontractorUsers) {
          const sup = supMap[u.subcontractorId?.toString()];
          u._supplierName = sup?.Name || '—';
          u._supplierUuid = sup?.uuid || null;
        }
      }
    }
  } catch (_) {
    // Non-fatal
  }

  // ── Recent by updatedAt ────────────────────────────────────────────────────
  const recentSuppliers = await Supplier.find(cisSupplierQuery())
    .sort({ updatedAt: -1 })
    .limit(10)
    .select('uuid Name CISRate ApplyWithholdingTax updatedAt')
    .lean();

  return {
    totalCount,
    cisRateCounts,
    cisApplicable: cisApplicable.length,
    cisVerifiedCount,
    nonCIS: nonCIS.length,
    ir35Linked,
    subcontractorUsers,
    recentSuppliers,
  };
}

export default { getSubcontractorsOverview };
