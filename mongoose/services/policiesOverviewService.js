import mdb from './mongooseDatabaseService.js';

async function getPoliciesOverview({ staleDays = 365 } = {}) {
  const PolicyDocument = mdb.INTERNAL?.policyDocument;
  if (!PolicyDocument) throw new Error('policyDocument model not loaded');

  const now = new Date();
  const staleFrom = new Date(now);
  staleFrom.setDate(staleFrom.getDate() - staleDays);

  const recentFrom = new Date(now);
  recentFrom.setDate(recentFrom.getDate() - 30);

  const all = await PolicyDocument.find({})
    .select('uuid title category version isPublished createdAt updatedAt')
    .lean();

  const totalCount = all.length;
  const publishedCount = all.filter(p => p.isPublished).length;
  const draftCount = totalCount - publishedCount;

  const byCategory = {};
  for (const p of all) {
    const cat = p.category || 'General';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  }

  const draftPolicies = all
    .filter(p => !p.isPublished)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  const stalePolicies = all
    .filter(p => p.updatedAt && new Date(p.updatedAt) < staleFrom)
    .sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));

  const recentlyUpdated = all
    .filter(p => p.updatedAt && new Date(p.updatedAt) >= recentFrom)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  return {
    totalCount,
    publishedCount,
    draftCount,
    byCategory,
    draftPolicies,
    stalePolicies,
    recentlyUpdated,
    staleDays,
  };
}

export default { getPoliciesOverview };
