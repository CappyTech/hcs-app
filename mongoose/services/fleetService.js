import mdb from './mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';

/**
 * Fetch a full fleet overview: summary stats, vehicles expiring soon,
 * current assignments, and availability breakdown.
 *
 * @param {Object} [opts]
 * @param {number} [opts.expiryDays=30] - How many days ahead to flag as "expiring soon"
 * @returns {Promise<Object>}
 */
async function getFleetOverview({ expiryDays = 30 } = {}) {
  const Vehicle = mdb.INTERNAL.vehicle;
  if (!Vehicle) throw new Error('Vehicle model not loaded');

  const now = new Date();
  const horizon = new Date(now);
  horizon.setDate(horizon.getDate() + expiryDays);

  // ── All vehicles (lean for read-only) ─────────────────────────────────
  const allVehicles = await Vehicle.find({}).lean();
  const totalCount = allVehicles.length;

  // ── Availability breakdown ────────────────────────────────────────────
  const availabilityCounts = {};
  const statuses = ['Available', 'In Use', 'Under Maintenance', 'Out of Service', 'Disposed'];
  for (const s of statuses) availabilityCounts[s] = 0;
  for (const v of allVehicles) {
    const s = v.availabilityStatus || 'Available';
    availabilityCounts[s] = (availabilityCounts[s] || 0) + 1;
  }

  // ── Vehicles expiring soon (MOT, insurance, road tax) ─────────────────
  const expiringMot = await Vehicle.find({
    motExpiryDate: { $gte: now, $lte: horizon },
    availabilityStatus: { $ne: 'Disposed' }
  }).sort({ motExpiryDate: 1 }).lean();

  const expiringInsurance = await Vehicle.find({
    insuranceExpiryDate: { $gte: now, $lte: horizon },
    availabilityStatus: { $ne: 'Disposed' }
  }).sort({ insuranceExpiryDate: 1 }).lean();

  const expiringRoadTax = await Vehicle.find({
    roadTaxExpiryDate: { $gte: now, $lte: horizon },
    availabilityStatus: { $ne: 'Disposed' }
  }).sort({ roadTaxExpiryDate: 1 }).lean();

  // ── Already expired (past due) ────────────────────────────────────────
  const expiredMot = await Vehicle.find({
    motExpiryDate: { $lt: now },
    availabilityStatus: { $ne: 'Disposed' }
  }).sort({ motExpiryDate: 1 }).lean();

  const expiredInsurance = await Vehicle.find({
    insuranceExpiryDate: { $lt: now },
    availabilityStatus: { $ne: 'Disposed' }
  }).sort({ insuranceExpiryDate: 1 }).lean();

  const expiredRoadTax = await Vehicle.find({
    roadTaxExpiryDate: { $lt: now },
    availabilityStatus: { $ne: 'Disposed' }
  }).sort({ roadTaxExpiryDate: 1 }).lean();

  // ── Vehicles with assignments ─────────────────────────────────────────
  const assignedToEmployee = await Vehicle.find({
    employeeId: { $ne: null },
    availabilityStatus: { $ne: 'Disposed' }
  }).lean();

  const assignedToSubcontractor = await Vehicle.find({
    subcontractorId: { $ne: null },
    availabilityStatus: { $ne: 'Disposed' }
  }).lean();

  // ── Resolve employee & subcontractor names ────────────────────────────
  const employeeIds = [...new Set(assignedToEmployee.map(v => v.employeeId?.toString()).filter(Boolean))];
  const subcontractorIds = [...new Set(assignedToSubcontractor.map(v => v.subcontractorId?.toString()).filter(Boolean))];

  const employees = employeeIds.length
    ? await mdb.INTERNAL.employee.find({ _id: { $in: employeeIds } }).select('_id name uuid').lean()
    : [];
  const employeeMap = Object.fromEntries(employees.map(e => [e._id.toString(), e]));

  const suppliers = subcontractorIds.length && mdb.REST?.supplier
    ? await mdb.REST.supplier.find({ _id: { $in: subcontractorIds } }).select('_id Name uuid').lean()
    : [];
  const supplierMap = Object.fromEntries(suppliers.map(s => [s._id.toString(), s]));

  // Enrich assigned vehicles with names
  for (const v of assignedToEmployee) {
    const emp = employeeMap[v.employeeId?.toString()];
    v._assigneeName = emp?.name || 'Unknown';
    v._assigneeUuid = emp?.uuid || null;
    v._assigneeType = 'employee';
  }
  for (const v of assignedToSubcontractor) {
    const sup = supplierMap[v.subcontractorId?.toString()];
    v._assigneeName = sup?.Name || 'Unknown';
    v._assigneeUuid = sup?.uuid || null;
    v._assigneeType = 'subcontractor';
  }

  const assignedVehicles = [...assignedToEmployee, ...assignedToSubcontractor];

  // ── Service due soon ──────────────────────────────────────────────────
  const serviceDueSoon = await Vehicle.find({
    nextServiceDueDate: { $gte: now, $lte: horizon },
    availabilityStatus: { $ne: 'Disposed' }
  }).sort({ nextServiceDueDate: 1 }).lean();

  // ── Unassigned & available ────────────────────────────────────────────
  const unassigned = allVehicles.filter(v =>
    !v.employeeId && !v.subcontractorId && v.availabilityStatus === 'Available'
  );

  return {
    totalCount,
    availabilityCounts,
    expiringMot,
    expiringInsurance,
    expiringRoadTax,
    expiredMot,
    expiredInsurance,
    expiredRoadTax,
    assignedVehicles,
    serviceDueSoon,
    unassigned,
    expiryDays,
  };
}

export default { getFleetOverview };
