import mdb from './mongooseDatabaseService.js';
import { signedAmount, bankLineFactHash, LIVE_BANK_LINE } from './bankLinkService.js';

/**
 * Applies accountant-authored rules to bank lines that carry no KashFlow
 * document link.
 *
 * The evaluation half is pure — `ruleMatches` and `firstMatchingRule` take
 * plain objects and touch nothing — so the behaviour an accountant depends on
 * is testable without a database.
 */

class BankRuleError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'BankRuleError';
    this.statusCode = statusCode;
  }
}

function models() {
  const BankRule = mdb.INTERNAL?.bankRule;
  const BankMatch = mdb.INTERNAL?.bankMatch;
  if (!BankRule) throw new BankRuleError('bankRule model is not loaded', 503);
  return { BankRule, BankMatch };
}

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * Does this rule apply to this bank line?
 *
 * Every populated condition must hold — they are AND-ed. An empty condition is
 * not a wildcard match, it is simply not considered; a rule with no conditions
 * at all matches nothing rather than everything, since a rule that silently
 * swallowed every line would be a disaster to diagnose.
 */
export function ruleMatches(rule, bankTx) {
  const c = rule?.conditions || {};
  const amount = signedAmount(bankTx);
  const magnitude = Math.abs(amount);

  const tests = [];

  if (c.typeEquals) tests.push(norm(bankTx?.Type) === norm(c.typeEquals));
  if (c.typeContains) tests.push(norm(bankTx?.Type).includes(norm(c.typeContains)));
  if (c.commentContains) tests.push(norm(bankTx?.Comment).includes(norm(c.commentContains)));
  if (c.accountId != null) tests.push(Number(bankTx?.AccountId) === Number(c.accountId));

  if (c.direction && c.direction !== 'any') {
    tests.push(c.direction === 'in' ? amount > 0 : amount < 0);
  }

  // Compared in pence: a float tolerance rejects an exact match at the
  // boundary (Math.abs(100 - 100.01) is 0.010000000000005).
  const pence = (v) => Math.round((Number(v) || 0) * 100);
  if (c.amountEquals != null) tests.push(pence(magnitude) === pence(c.amountEquals));
  if (c.amountMin != null) tests.push(pence(magnitude) >= pence(c.amountMin));
  if (c.amountMax != null) tests.push(pence(magnitude) <= pence(c.amountMax));

  if (!tests.length) return false;
  return tests.every(Boolean);
}

/** The first rule that applies, by priority then age. Null when none do. */
export function firstMatchingRule(rules, bankTx) {
  const ordered = [...(rules || [])].sort((a, b) => {
    const p = (a.priority ?? 100) - (b.priority ?? 100);
    if (p !== 0) return p;
    return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
  });
  return ordered.find(r => r.enabled !== false && ruleMatches(r, bankTx)) || null;
}

/**
 * Build the bankMatch payload a rule produces for a line.
 *
 * These matches carry no documents: the line is a posting to a nominal
 * account, not the settlement of an invoice or purchase, so there is nothing
 * to allocate against.
 */
export function buildMatchFromRule(rule, bankTx) {
  const amount = signedAmount(bankTx);
  const action = rule.action || {};

  const reasons = [`Rule "${rule.name}"`];
  if (action.category) reasons.push(`Categorised as ${action.category}`);
  if (action.note) reasons.push(action.note);

  return {
    accountId: bankTx.AccountId,
    direction: amount >= 0 ? 'in' : 'out',
    matchType: action.matchType || 'no-document',
    bankLines: [{
      source: 'banktransaction',
      bankTransactionId: bankTx.Id,
      date: bankTx.Date || null,
      amount,
      description: bankTx.Comment || bankTx.Type || '',
      factHash: bankLineFactHash(bankTx),
    }],
    documents: [],
    totals: { bankTotal: Number(amount.toFixed(2)), documentTotal: 0, variance: 0 },
    // autoConfirm is the one place the "a person confirms" guarantee is
    // relaxed, so it is opt-in per rule and admin-only to set.
    status: rule.autoConfirm ? 'confirmed' : 'suggested',
    ...(rule.autoConfirm
      ? { reviewedByName: `Rule: ${rule.name}`, reviewedAt: new Date() }
      : {}),
    confidence: 100,
    origin: 'rule',
    appliedRuleId: rule._id || null,
    reasons,
  };
}

/**
 * Preview a rule without writing anything.
 *
 * The point is that an accountant can see what a rule would do before turning
 * it on — a rule that quietly claimed hundreds of lines would be tedious to
 * unpick.
 */
export async function testRule(rule, { limit = 20 } = {}) {
  const BankTransaction = mdb.REST?.bankTransaction;
  const { BankMatch } = models();
  if (!BankTransaction) throw new BankRuleError('bankTransaction model is not loaded', 503);

  const query = { EntityName: 'banktransaction', ...LIVE_BANK_LINE };
  if (rule?.conditions?.accountId != null) query.AccountId = Number(rule.conditions.accountId);

  const lines = await BankTransaction.find(query)
    .select('Id AccountId Date Type Comment PaidIn PaidOut')
    .lean();

  const matched = lines.filter(l => ruleMatches(rule, l));

  const claimed = BankMatch
    ? new Set((await BankMatch.distinct('bankLines.bankTransactionId', {
      status: { $in: ['suggested', 'confirmed'] }, deletedAt: null,
    })).filter(v => v != null))
    : new Set();

  const fresh = matched.filter(l => !claimed.has(l.Id));

  return {
    examined: lines.length,
    matched: matched.length,
    alreadyTracked: matched.length - fresh.length,
    wouldCreate: fresh.length,
    sample: fresh.slice(0, limit).map(l => ({
      Id: l.Id, Date: l.Date, Type: l.Type, Comment: l.Comment, amount: signedAmount(l),
    })),
  };
}

/**
 * Apply every enabled rule to unlinked lines that have no match record yet.
 *
 * Idempotent: a line already carrying any match is skipped. bankMatch is
 * INTERNAL so auditPlugin records every write, and a job that rewrote the same
 * suggestions each run would bury the audit log.
 */
export async function applyRules({ accountId = null, limit = 10000 } = {}) {
  const { BankRule, BankMatch } = models();
  const BankTransaction = mdb.REST?.bankTransaction;
  if (!BankTransaction || !BankMatch) {
    return { examined: 0, created: 0, skipped: 0, unmatched: 0, byRule: {} };
  }

  const rules = await BankRule.find({ enabled: true, deletedAt: null })
    .sort({ priority: 1, createdAt: 1 }).lean();
  if (!rules.length) return { examined: 0, created: 0, skipped: 0, unmatched: 0, byRule: {} };

  const query = { EntityName: 'banktransaction', ...LIVE_BANK_LINE };
  if (accountId != null) query.AccountId = Number(accountId);

  // See generateSuggestions: excluding claimed lines after the fetch would make
  // `limit` apply to already-processed rows and stall the backlog.
  const claimed = (await BankMatch.distinct('bankLines.bankTransactionId', { deletedAt: null }))
    .filter(v => v != null);
  if (claimed.length) query.Id = { $nin: claimed };

  const lines = await BankTransaction.find(query)
    .sort({ Date: -1 }).limit(limit)
    .select('Id AccountId Date Type Comment PaidIn PaidOut')
    .lean();

  const stats = { examined: lines.length, created: 0, skipped: 0, unmatched: 0, byRule: {} };
  const pending = [];
  const applied = new Map();

  for (const line of lines) {
    const rule = firstMatchingRule(rules, line);
    if (!rule) { stats.unmatched += 1; continue; }

    pending.push(buildMatchFromRule(rule, line));
    stats.byRule[rule.name] = (stats.byRule[rule.name] || 0) + 1;
    applied.set(String(rule._id), (applied.get(String(rule._id)) || 0) + 1);
  }

  if (pending.length) {
    const created = await BankMatch.insertMany(pending, { ordered: false });
    stats.created = created.length;
  }

  // Record usage so an accountant can see which rules earn their keep.
  const now = new Date();
  await Promise.all([...applied.entries()].map(([id, n]) => BankRule.updateOne(
    { _id: id },
    { $set: { 'stats.lastAppliedAt': now }, $inc: { 'stats.appliedCount': n } },
  )));

  return stats;
}

/**
 * Rules covering the nominal postings present in this dataset.
 *
 * Seeded rather than left blank so the feature is useful immediately: these
 * cover the recurring categories that make up the bulk of the unlinked lines.
 * All are suggest-only. They are matched on `Type`, which is KashFlow's own
 * nominal narrative rather than free text.
 */
export const SEED_RULES = [
  { name: 'Wages — net pay', priority: 10, category: 'payroll', typeEquals: 'Wages Control Net Pay' },
  { name: 'PAYE tax and NI', priority: 11, category: 'payroll', typeEquals: 'tax and NI' },
  { name: "Employer's NIC", priority: 12, category: 'payroll', typeEquals: 'Employers NIC' },
  { name: 'Employee pension contributions', priority: 13, category: 'payroll', typeEquals: 'Employee Pension contributions' },
  { name: 'Employer pension contributions', priority: 14, category: 'payroll', typeContains: 'Pension' },
  { name: 'CIS deductions', priority: 20, category: 'tax', typeEquals: 'CIS deductions' },
  { name: 'VAT control account', priority: 21, category: 'tax', typeEquals: 'VAT control account' },
  { name: 'Corporation tax', priority: 22, category: 'tax', typeContains: 'Corporation Tax' },
  { name: 'Directors loan account', priority: 30, category: 'directors', typeEquals: 'Directors Loan Account' },
  { name: 'Funds introduced', priority: 31, category: 'directors', typeEquals: 'Funds introduced' },
  { name: 'Funds withdrawn', priority: 32, category: 'directors', typeEquals: 'Funds withdrawn' },
  { name: 'Bank charges', priority: 40, category: 'finance costs', typeContains: 'Bank charges' },
  { name: 'Bank interest paid', priority: 41, category: 'finance costs', typeContains: 'interest paid' },
  { name: 'Bank interest received', priority: 42, category: 'finance income', typeContains: 'interest received' },
  { name: 'Credit card charges', priority: 43, category: 'finance costs', typeContains: 'Credit card charges' },
  { name: 'Loan account movements', priority: 50, category: 'loans', typeContains: 'Loan account' },
  { name: 'Mileage', priority: 60, category: 'expenses', typeEquals: 'Mileage' },
];

/** Create the seed rules, skipping any that already exist by name. */
export async function seedRules({ user = null } = {}) {
  const { BankRule } = models();

  const existing = new Set((await BankRule.find({}).select('name').lean()).map(r => r.name));
  const toCreate = SEED_RULES.filter(r => !existing.has(r.name)).map(r => ({
    name: r.name,
    priority: r.priority,
    enabled: true,
    seeded: true,
    autoConfirm: false,
    conditions: {
      ...(r.typeEquals ? { typeEquals: r.typeEquals } : {}),
      ...(r.typeContains ? { typeContains: r.typeContains } : {}),
      direction: 'any',
    },
    action: { matchType: 'no-document', category: r.category },
    createdBy: user?._id || null,
    createdByName: user?.name || 'System (seed)',
  }));

  if (!toCreate.length) return { created: 0, skipped: SEED_RULES.length };
  const created = await BankRule.insertMany(toCreate, { ordered: false });
  return { created: created.length, skipped: SEED_RULES.length - created.length };
}

export default {
  ruleMatches,
  firstMatchingRule,
  buildMatchFromRule,
  testRule,
  applyRules,
  seedRules,
  SEED_RULES,
  BankRuleError,
};
export { BankRuleError };
