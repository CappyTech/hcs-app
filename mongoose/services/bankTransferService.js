import mdb from './mongooseDatabaseService.js';
import { signedAmount, bankLineFactHash } from './bankLinkService.js';

/**
 * Pairs up money moving between the company's own accounts.
 *
 * An internal transfer appears twice — once leaving one account, once arriving
 * in another — and neither half has a document, so both would otherwise sit on
 * the worklist forever. Pairing them accounts for both at once and, more
 * usefully, makes it obvious when only one half exists.
 *
 * Rare in this dataset: 22 candidate pairs across 2,547 unlinked lines, mostly
 * CIS deductions moving from the CIS Payments account to the main account.
 * Cheap to detect and it removes a class of line a rule cannot sensibly cover.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Pence, so a float comparison cannot miss an exact pairing. */
const pence = (v) => Math.round((Number(v) || 0) * 100);

/**
 * Find transfer pairs among a set of bank lines.
 *
 * Pure: takes plain objects, returns pairs. A line pairs with another when the
 * amounts are equal and opposite, the accounts differ, and the dates are
 * within `windowDays` — banks post the two halves on different days.
 *
 * Each line is used at most once. Where several candidates fit, the closest by
 * date wins, then the lowest Id, so the result does not depend on input order.
 */
export function findTransferPairs(lines, { windowDays = 1 } = {}) {
  const outs = lines.filter(l => signedAmount(l) < 0).sort((a, b) => a.Id - b.Id);
  const ins = lines.filter(l => signedAmount(l) > 0);

  // Bucket the money-in side by amount so pairing is a lookup, not a scan.
  const byAmount = new Map();
  for (const line of ins) {
    const key = pence(Math.abs(signedAmount(line)));
    if (!byAmount.has(key)) byAmount.set(key, []);
    byAmount.get(key).push(line);
  }

  const used = new Set();
  const pairs = [];

  for (const out of outs) {
    if (used.has(out.Id)) continue;

    const key = pence(Math.abs(signedAmount(out)));
    const outTime = new Date(out.Date).getTime();

    const candidates = (byAmount.get(key) || [])
      .filter(c => !used.has(c.Id)
        && Number(c.AccountId) !== Number(out.AccountId)
        && Math.abs(new Date(c.Date).getTime() - outTime) <= windowDays * DAY_MS)
      .sort((a, b) => {
        const da = Math.abs(new Date(a.Date).getTime() - outTime);
        const db = Math.abs(new Date(b.Date).getTime() - outTime);
        return da - db || a.Id - b.Id;
      });

    if (!candidates.length) continue;

    const match = candidates[0];
    used.add(out.Id);
    used.add(match.Id);
    pairs.push({ out, in: match });
  }

  return pairs;
}

/** The bankMatch payload for one transfer pair: two bank lines, no documents. */
export function buildMatchFromTransfer(pair) {
  const { out, in: incoming } = pair;
  const amount = Math.abs(signedAmount(out));

  return {
    // Attributed to the account the money left; the counterpart is on the
    // second bank line.
    accountId: out.AccountId,
    direction: 'out',
    matchType: 'transfer',
    bankLines: [out, incoming].map(l => ({
      source: 'banktransaction',
      bankTransactionId: l.Id,
      date: l.Date || null,
      amount: signedAmount(l),
      description: l.Comment || l.Type || '',
      factHash: bankLineFactHash(l),
    })),
    documents: [],
    // The two halves cancel, which is what makes a transfer self-evidencing.
    totals: { bankTotal: 0, documentTotal: 0, variance: 0 },
    status: 'suggested',
    confidence: 100,
    origin: 'auto',
    reasons: [
      `Transfer of ${amount.toFixed(2)} from account ${out.AccountId} to ${incoming.AccountId}`,
      'Equal and opposite amounts on two accounts within a day of each other',
    ],
  };
}

/**
 * Detect transfers among unlinked lines and record them as suggestions.
 *
 * Idempotent: lines already carrying any match are excluded before pairing, so
 * re-running neither duplicates nor churns the audit log.
 */
export async function detectTransfers({ windowDays = 1, limit = 10000 } = {}) {
  const BankTransaction = mdb.REST?.bankTransaction;
  const BankMatch = mdb.INTERNAL?.bankMatch;
  if (!BankTransaction || !BankMatch) return { examined: 0, pairs: 0, created: 0 };

  const claimed = new Set(
    (await BankMatch.distinct('bankLines.bankTransactionId', { deletedAt: null })).filter(v => v != null),
  );

  const lines = (await BankTransaction.find({ EntityName: 'banktransaction' })
    .sort({ Date: -1 }).limit(limit)
    .select('Id AccountId Date Type Comment PaidIn PaidOut')
    .lean())
    .filter(l => !claimed.has(l.Id));

  const pairs = findTransferPairs(lines, { windowDays });
  if (!pairs.length) return { examined: lines.length, pairs: 0, created: 0 };

  const created = await BankMatch.insertMany(pairs.map(buildMatchFromTransfer), { ordered: false });
  return { examined: lines.length, pairs: pairs.length, created: created.length };
}

/**
 * Lines whose `Type` is the name of one of our own bank accounts.
 *
 * KashFlow writes the counterparty account's name into `Type` for a movement
 * between two of our accounts — money arriving in the VAT or CIS account
 * "from Heron Constructive Solutions LTD", or the monthly loan repayment
 * landing in the Bounce Back Loan account. 422 of the 2,547 unlinked lines are
 * this shape, and they are the single largest remaining group.
 *
 * They are detected rather than covered by a seed rule because the set of
 * account names is data, not something to hardcode: a new account should be
 * recognised without editing code.
 *
 * Note these are recorded as one-sided. The opposite half usually is not
 * present as a separate unlinked line — the money-in rows outnumber the
 * money-out rows roughly thirty to one — so pairing them like a true transfer
 * would misrepresent what is there. The counterpart account is recorded and
 * the line is flagged for review.
 */
export async function detectAccountNamedMovements({ limit = 10000 } = {}) {
  const BankTransaction = mdb.REST?.bankTransaction;
  const BankAccount = mdb.REST?.bankAccount;
  const BankMatch = mdb.INTERNAL?.bankMatch;
  if (!BankTransaction || !BankAccount || !BankMatch) return { examined: 0, created: 0 };

  const accounts = await BankAccount.find({}).select('Id AccountName').lean();
  const byName = new Map(
    accounts
      .filter(a => a.AccountName)
      .map(a => [String(a.AccountName).trim().toLowerCase(), { id: a.Id, name: a.AccountName }]),
  );
  if (!byName.size) return { examined: 0, created: 0 };

  const claimed = new Set(
    (await BankMatch.distinct('bankLines.bankTransactionId', { deletedAt: null })).filter(v => v != null),
  );

  const lines = (await BankTransaction.find({ EntityName: 'banktransaction' })
    .sort({ Date: -1 }).limit(limit)
    .select('Id AccountId Date Type Comment PaidIn PaidOut')
    .lean())
    .filter(l => !claimed.has(l.Id));

  const pending = [];
  for (const line of lines) {
    const counterpart = byName.get(String(line.Type || '').trim().toLowerCase());
    if (!counterpart) continue;
    // A line naming its own account tells us nothing.
    if (Number(counterpart.id) === Number(line.AccountId)) continue;

    const amount = signedAmount(line);
    pending.push({
      accountId: line.AccountId,
      direction: amount >= 0 ? 'in' : 'out',
      matchType: 'transfer',
      bankLines: [{
        source: 'banktransaction',
        bankTransactionId: line.Id,
        date: line.Date || null,
        amount,
        description: line.Comment || line.Type || '',
        factHash: bankLineFactHash(line),
      }],
      documents: [],
      totals: { bankTotal: Number(amount.toFixed(2)), documentTotal: 0, variance: 0 },
      status: 'suggested',
      confidence: 90,
      origin: 'auto',
      reasons: [
        `Movement ${amount >= 0 ? 'from' : 'to'} ${counterpart.name} (account ${counterpart.id})`,
        'KashFlow names the counterparty account in this line’s type',
        'Only this half of the movement is present — the opposite side is not a separate bank line',
      ],
    });
  }

  if (!pending.length) return { examined: lines.length, created: 0 };
  const created = await BankMatch.insertMany(pending, { ordered: false });
  return { examined: lines.length, created: created.length };
}

export default {
  findTransferPairs,
  buildMatchFromTransfer,
  detectTransfers,
  detectAccountNamedMovements,
};
