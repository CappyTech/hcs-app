import mdb from './mongooseDatabaseService.js';

async function getAdminOverview({ recentDays = 30 } = {}) {
  const User = mdb.INTERNAL?.user;
  if (!User) throw new Error('User model not loaded');

  const now = new Date();
  const recentFrom = new Date(now);
  recentFrom.setDate(recentFrom.getDate() - recentDays);

  const allUsers = await User.find({})
    .select('uuid username email role emailVerified totpSecret createdAt lastLoginAt')
    .lean();

  const totalUsers = allUsers.length;

  // ── Role breakdown ─────────────────────────────────────────────────────────
  const byRole = {};
  for (const u of allUsers) {
    const r = u.role || 'none';
    byRole[r] = (byRole[r] || 0) + 1;
  }

  // ── Email verification ─────────────────────────────────────────────────────
  const unverifiedUsers = allUsers.filter(u => !u.emailVerified);

  // ── 2FA adoption ──────────────────────────────────────────────────────────
  const with2FA = allUsers.filter(u => !!u.totpSecret).length;
  const without2FA = allUsers.filter(u => !u.totpSecret);

  // ── Role 'none' — awaiting assignment ─────────────────────────────────────
  const pendingRoleUsers = allUsers.filter(u => u.role === 'none');

  // ── Recent registrations ───────────────────────────────────────────────────
  const recentUsers = allUsers
    .filter(u => u.createdAt && new Date(u.createdAt) >= recentFrom)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // ── Session / meta counts ──────────────────────────────────────────────────
  let activeSessionCount = 0;
  try {
    const Session = mdb.INTERNAL?.session;
    if (Session) {
      activeSessionCount = await Session.countDocuments({ expires: { $gte: now } });
    }
  } catch (_) {
    // Non-fatal
  }

  return {
    totalUsers,
    byRole,
    unverifiedUsers,
    with2FA,
    without2FA,
    pendingRoleUsers,
    recentUsers,
    activeSessionCount,
    recentDays,
  };
}

export default { getAdminOverview };
