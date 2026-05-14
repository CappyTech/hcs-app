'use strict';

const mdb = require('./mongooseDatabaseService');
const { computeFinancials } = require('./kashflowProjectService');

async function getProjectsOverview() {
  const Contract = mdb.INTERNAL?.contract;
  const Assignment = mdb.INTERNAL?.assignment;
  const RestProject = mdb.REST?.project;

  if (!Contract) throw new Error('Contract model not loaded');

  const now = new Date();

  // ── Internal contracts ─────────────────────────────────────────────────────
  const allContracts = await Contract.find({}).lean();
  const contractByStatus = { Planned: 0, 'In Progress': 0, Completed: 0 };
  for (const c of allContracts) {
    const s = c.status || 'Planned';
    contractByStatus[s] = (contractByStatus[s] || 0) + 1;
  }

  // Overdue: In Progress/Planned with an endDate in the past
  const overdueContracts = allContracts.filter(c =>
    c.status !== 'Completed' && c.endDate && new Date(c.endDate) < now
  ).sort((a, b) => new Date(a.endDate) - new Date(b.endDate));

  // Ending soon (next 30 days)
  const horizon = new Date(now);
  horizon.setDate(horizon.getDate() + 30);
  const contractsEndingSoon = allContracts.filter(c =>
    c.status !== 'Completed' &&
    c.endDate &&
    new Date(c.endDate) >= now &&
    new Date(c.endDate) <= horizon
  ).sort((a, b) => new Date(a.endDate) - new Date(b.endDate));

  const activeContracts = allContracts.filter(c => c.status === 'In Progress');
  const plannedContracts = allContracts.filter(c => c.status === 'Planned');

  // ── Assignments ────────────────────────────────────────────────────────────
  let assignmentsByContract = {};
  let recentAssignments = [];
  let contractsWithoutAssignments = [];

  if (Assignment) {
    const allAssignments = await Assignment.find({
      status: { $in: ['Planned', 'In Progress'] },
    }).lean();

    for (const a of allAssignments) {
      const key = a.contractId?.toString();
      if (key) assignmentsByContract[key] = (assignmentsByContract[key] || 0) + 1;
    }

    recentAssignments = await Assignment.find({})
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    // Enrich with contract titles
    const contractIds = [...new Set(recentAssignments.map(a => a.contractId?.toString()).filter(Boolean))];
    if (contractIds.length) {
      const contracts = await Contract.find({ _id: { $in: contractIds } }).select('_id title uuid').lean();
      const cMap = Object.fromEntries(contracts.map(c => [c._id.toString(), c]));
      for (const a of recentAssignments) {
        const c = cMap[a.contractId?.toString()];
        a._contractTitle = c?.title || '—';
        a._contractUuid = c?.uuid || null;
      }
    }

    // Active contracts with no current assignments
    contractsWithoutAssignments = activeContracts.filter(c =>
      !assignmentsByContract[c._id.toString()]
    );
  }

  // ── REST projects ──────────────────────────────────────────────────────────
  let restProjects = [];
  let restProjectByStatus = {};
  let restProjectsAtRisk = [];
  let restProjectsReadyToComplete = [];

  if (RestProject) {
    restProjects = await RestProject.find({ Status: { $ne: 'Completed' } })
      .sort({ StartDate: -1 })
      .limit(20)
      .lean();
    const allRestProjects = await RestProject.aggregate([
      { $group: { _id: '$Status', count: { $sum: 1 } } },
    ]);
    for (const r of allRestProjects) {
      restProjectByStatus[r._id || 'Unknown'] = r.count;
    }

    // Attach financial health to each project
    for (const p of restProjects) {
      p._financials = computeFinancials(p);
    }

    restProjectsAtRisk         = restProjects.filter(p => p._financials.atRisk);
    restProjectsReadyToComplete = restProjects.filter(p => !p._financials.atRisk && p._financials.incomeTarget > 0);
  }

  return {
    totalContracts: allContracts.length,
    contractByStatus,
    overdueContracts,
    contractsEndingSoon,
    activeContracts,
    plannedContracts,
    assignmentsByContract,
    recentAssignments,
    contractsWithoutAssignments,
    restProjects,
    restProjectByStatus,
    restProjectsAtRisk,
    restProjectsReadyToComplete,
  };
}

module.exports = { getProjectsOverview };
