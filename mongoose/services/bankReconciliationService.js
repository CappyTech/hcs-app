import mdb from './mongooseDatabaseService.js';
import { amountsAgree, expectedAllocation } from './bankLinkService.js';

/**
 * Write side of bank reconciliation: confirming, rejecting and superseding
 * matches, and signing off periods.
 *
 * Two rules run through everything here:
 *
 *   1. KashFlow is never written to. It stays the system of record; this is
 *      our own record of what has been accounted for and who said so.
 *
 *   2. Nothing is destroyed. A correction supersedes rather than mutates, and
 *      a re-sync that changes the underlying document sets `integrity` rather
 *      than touching `status`. What somebody signed off, and what they were
 *      looking at when they signed it, stays readable afterwards.
 */

const ALLOCATION_TOLERANCE = 0.01;

class BankReconciliationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'BankReconciliationError';
    this.statusCode = statusCode;
  }
}

function models() {
  const BankMatch = mdb.INTERNAL?.bankMatch;
  const BankSignOff = mdb.INTERNAL?.bankSignOff;
  if (!BankMatch) throw new BankReconciliationError('bankMatch model is not loaded', 503);
  return { BankMatch, BankSignOff };
}

/** Denormalised reviewer identity, so the trail survives a user rename. */
function reviewerFrom(user) {
  return {
    reviewedBy: user?._id || null,
    reviewedByName: user?.name || user?.username || user?.email || 'Unknown',
    reviewedByEmail: user?.email || '',
    reviewedAt: new Date(),
  };
}

function sumAllocations(documents) {
  return (documents || []).reduce((sum, d) => sum + (Number(d.allocatedAmount) || 0), 0);
}

/**
 * Check that the allocations account for the bank movement exactly.
 *
 * Bank totals are signed (money in positive), and allocations follow the
 * document's own sign convention, so the comparison goes through
 * expectedAllocation rather than comparing raw magnitudes — otherwise a
 * supplier refund reads as an error and a genuinely inverted sign does not.
 */
export function validateAllocations(match) {
  const bankTotal = (match.bankLines || []).reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const allocated = sumAllocations(match.documents);

  // Nothing to allocate against: transfers, charges, journals.
  if (!match.documents?.length) {
    return { ok: true, bankTotal, allocated: 0, expected: 0 };
  }

  const kind = match.documents[0].kind;
  const expected = expectedAllocation(bankTotal, kind);
  const ok = amountsAgree(allocated, expected, ALLOCATION_TOLERANCE);

  return { ok, bankTotal, allocated, expected };
}

/**
 * Bank lines and documents already claimed by a *confirmed* match.
 *
 * The model carries partial-unique indexes for this, but they are not relied
 * on alone: hcs-sync already carries workarounds for restricted
 * partialFilterExpression support on the deployed server, so a silent index
 * failure must not become a silent double-claim.
 */
export async function findConflicts(match, { excludeId = null } = {}) {
  const { BankMatch } = models();
  const conflicts = [];

  const bankIds = (match.bankLines || []).map(l => l.bankTransactionId).filter(v => v != null);
  const docKeys = (match.documents || []).map(d => d.docKey).filter(Boolean);

  const base = { status: 'confirmed' };
  if (excludeId) base._id = { $ne: excludeId };

  if (bankIds.length) {
    const clashes = await BankMatch.find({ ...base, 'bankLines.bankTransactionId': { $in: bankIds } })
      .select('uuid bankLines.bankTransactionId').lean();
    for (const c of clashes) {
      const overlap = (c.bankLines || []).map(l => l.bankTransactionId).filter(id => bankIds.includes(id));
      conflicts.push({ kind: 'bankLine', uuid: c.uuid, values: overlap });
    }
  }

  if (docKeys.length) {
    const clashes = await BankMatch.find({ ...base, 'documents.docKey': { $in: docKeys } })
      .select('uuid documents.docKey').lean();
    for (const c of clashes) {
      const overlap = (c.documents || []).map(d => d.docKey).filter(k => docKeys.includes(k));
      conflicts.push({ kind: 'document', uuid: c.uuid, values: overlap });
    }
  }

  return conflicts;
}

/**
 * Confirm a match. `patch` may adjust the documents and their allocations —
 * that is how a reviewer corrects a suggestion before accepting it.
 */
export async function confirmMatch(uuid, { user, documents = null, reviewNote = '' } = {}) {
  const { BankMatch } = models();

  const match = await BankMatch.findOne({ uuid, deletedAt: null });
  if (!match) throw new BankReconciliationError('Match not found', 404);
  if (match.status === 'confirmed') throw new BankReconciliationError('This match is already confirmed');
  if (match.status === 'superseded') throw new BankReconciliationError('This match has been superseded');

  if (Array.isArray(documents)) match.documents = documents;

  const check = validateAllocations(match);
  if (!check.ok) {
    throw new BankReconciliationError(
      `Allocations total ${check.allocated.toFixed(2)} but the bank line implies ${check.expected.toFixed(2)}. `
      + 'Adjust the allocations so they account for the full amount.',
    );
  }

  const conflicts = await findConflicts(match, { excludeId: match._id });
  if (conflicts.length) {
    const first = conflicts[0];
    throw new BankReconciliationError(
      `Already accounted for by confirmed match ${first.uuid} (${first.kind}: ${first.values.join(', ')}).`,
      409,
    );
  }

  match.status = 'confirmed';
  match.totals = {
    bankTotal: Number(check.bankTotal.toFixed(2)),
    documentTotal: Number(check.allocated.toFixed(2)),
    variance: Number((check.expected - check.allocated).toFixed(2)),
  };
  Object.assign(match, reviewerFrom(user));
  match.reviewNote = reviewNote || '';

  await match.save();
  return match;
}

/** Reject a suggestion. A reason is required — a bare rejection teaches nobody. */
export async function rejectMatch(uuid, { user, reason = '' } = {}) {
  const { BankMatch } = models();

  if (!String(reason).trim()) throw new BankReconciliationError('A reason is required to reject a suggestion');

  const match = await BankMatch.findOne({ uuid, deletedAt: null });
  if (!match) throw new BankReconciliationError('Match not found', 404);
  if (match.status === 'confirmed') {
    throw new BankReconciliationError('Confirmed matches must be unconfirmed rather than rejected');
  }

  match.status = 'rejected';
  match.rejectedReason = String(reason).trim();
  Object.assign(match, reviewerFrom(user));

  await match.save();
  return match;
}

/**
 * Unconfirm a match by superseding it and reopening its bank lines.
 *
 * The original is kept and marked 'superseded' rather than edited back to
 * 'suggested', so the record of what was confirmed, by whom, and against what
 * facts stays intact. The replacement starts life as a fresh suggestion.
 */
export async function unconfirmMatch(uuid, { user, reason = '' } = {}) {
  const { BankMatch } = models();

  const original = await BankMatch.findOne({ uuid, deletedAt: null });
  if (!original) throw new BankReconciliationError('Match not found', 404);
  if (original.status !== 'confirmed') throw new BankReconciliationError('Only confirmed matches can be unconfirmed');
  if (original.signOffId) {
    throw new BankReconciliationError(
      'This match belongs to a signed-off period. Reopen the period first.',
      409,
    );
  }

  const replacement = new BankMatch({
    accountId: original.accountId,
    direction: original.direction,
    matchType: original.matchType,
    bankLines: original.bankLines,
    documents: original.documents,
    totals: original.totals,
    status: 'suggested',
    confidence: original.confidence,
    origin: original.origin,
    reasons: original.reasons,
    supersedes: original._id,
  });

  // Release the original's claim before the replacement takes it, or the
  // confirmed-uniqueness index rejects the pair.
  original.status = 'superseded';
  original.supersededAt = new Date();
  original.reviewNote = [original.reviewNote, String(reason || '').trim()].filter(Boolean).join(' | ');
  await original.save();

  await replacement.save();

  original.supersededBy = replacement._id;
  await original.save();

  return { original, replacement };
}

/** Confirm many matches in one action — how a decade of backlog gets cleared. */
export async function bulkConfirm(uuids, { user } = {}) {
  const results = { confirmed: [], failed: [] };

  for (const uuid of uuids) {
    try {
      const match = await confirmMatch(uuid, { user });
      results.confirmed.push(match.uuid);
    } catch (err) {
      // One bad row must not abandon the rest of the batch.
      results.failed.push({ uuid, message: err.message });
    }
  }

  return results;
}

/**
 * Sign off a period on one account.
 *
 * Refuses while anything in the period is still unreviewed, unless explicitly
 * forced — signing off over an unreviewed backlog is exactly the thing that
 * makes a reconciliation worthless. When forced, the counts are recorded so
 * the gap is visible afterwards.
 */
export async function createSignOff({
  accountId, accountName = '', periodStart, periodEnd,
  openingBalance = 0, closingBalancePerStatement = null,
  notes = '', force = false, user,
} = {}) {
  const { BankMatch, BankSignOff } = models();
  if (!BankSignOff) throw new BankReconciliationError('bankSignOff model is not loaded', 503);

  if (!Number.isFinite(Number(accountId))) throw new BankReconciliationError('An account is required');
  const start = new Date(periodStart);
  const end = new Date(periodEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new BankReconciliationError('A valid period start and end are required');
  }
  if (end < start) throw new BankReconciliationError('Period end must be on or after the period start');

  const existing = await BankSignOff.findOne({
    accountId, periodStart: start, periodEnd: end, status: 'signed', deletedAt: null,
  }).lean();
  if (existing) throw new BankReconciliationError('This period has already been signed off', 409);

  const inPeriod = { accountId, 'bankLines.date': { $gte: start, $lte: end }, deletedAt: null };
  const confirmed = await BankMatch.find({ ...inPeriod, status: 'confirmed' }).lean();
  const outstanding = await BankMatch.countDocuments({ ...inPeriod, status: { $in: ['suggested'] } });

  if (outstanding > 0 && !force) {
    throw new BankReconciliationError(
      `${outstanding} match${outstanding === 1 ? '' : 'es'} in this period are still awaiting review. `
      + 'Review them, or sign off explicitly acknowledging the gap.',
    );
  }

  const movement = confirmed.reduce(
    (sum, m) => sum + (m.bankLines || []).reduce((s, l) => s + (Number(l.amount) || 0), 0),
    0,
  );
  const unmatchedValue = (await BankMatch.find({ ...inPeriod, status: 'suggested' }).lean())
    .reduce((sum, m) => sum + (m.bankLines || []).reduce((s, l) => s + (Number(l.amount) || 0), 0), 0);

  const closingPerLedger = Number(openingBalance) + movement;
  const variance = closingBalancePerStatement == null
    ? 0
    : Number(closingBalancePerStatement) - closingPerLedger;

  const signOff = new BankSignOff({
    accountId,
    accountName,
    periodStart: start,
    periodEnd: end,
    openingBalance: Number(openingBalance) || 0,
    closingBalancePerStatement: closingBalancePerStatement == null ? null : Number(closingBalancePerStatement),
    closingBalancePerLedger: Number(closingPerLedger.toFixed(2)),
    variance: Number(variance.toFixed(2)),
    matchedCount: confirmed.length,
    unmatchedCount: outstanding,
    unmatchedValue: Number(unmatchedValue.toFixed(2)),
    status: 'signed',
    signedBy: user?._id || null,
    signedByName: user?.name || user?.username || user?.email || 'Unknown',
    signedByEmail: user?.email || '',
    signedAt: new Date(),
    notes,
  });

  await signOff.save();

  // Stamp the matches so they cannot be unconfirmed without reopening.
  await BankMatch.updateMany(
    { _id: { $in: confirmed.map(m => m._id) } },
    { $set: { signOffId: signOff._id } },
  );

  return signOff;
}

/** Reopen a signed period, releasing its matches. Recorded, never deleted. */
export async function reopenSignOff(uuid, { user, reason = '' } = {}) {
  const { BankMatch, BankSignOff } = models();
  if (!BankSignOff) throw new BankReconciliationError('bankSignOff model is not loaded', 503);

  if (!String(reason).trim()) throw new BankReconciliationError('A reason is required to reopen a period');

  const signOff = await BankSignOff.findOne({ uuid, deletedAt: null });
  if (!signOff) throw new BankReconciliationError('Sign-off not found', 404);
  if (signOff.status !== 'signed') throw new BankReconciliationError('Only a signed period can be reopened');

  signOff.status = 'reopened';
  signOff.reopenedBy = user?._id || null;
  signOff.reopenedByName = user?.name || user?.username || user?.email || 'Unknown';
  signOff.reopenedAt = new Date();
  signOff.reopenReason = String(reason).trim();
  await signOff.save();

  await BankMatch.updateMany({ signOffId: signOff._id }, { $set: { signOffId: null } });

  return signOff;
}

export default {
  validateAllocations,
  findConflicts,
  confirmMatch,
  rejectMatch,
  unconfirmMatch,
  bulkConfirm,
  createSignOff,
  reopenSignOff,
  BankReconciliationError,
};
export { BankReconciliationError };
