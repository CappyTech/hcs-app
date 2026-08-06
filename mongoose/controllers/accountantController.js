import path from 'path';
import mdb from '../services/mongooseDatabaseService.js';
import worklist from '../services/bankWorklistService.js';
import statements from '../services/statementImportService.js';
import threeWay from '../services/bankThreeWayService.js';
import { resolveBankLine, signedAmount, bankLineKey, LIVE_BANK_LINE } from '../services/bankLinkService.js';

/**
 * Read-only bank reconciliation portal for an external accountant.
 *
 * Every handler here is a GET, and nothing in this file writes: no model is
 * saved, no job is triggered, no flash is set. That is the whole point — the
 * portal is a separate surface rather than /bank with its buttons hidden,
 * because a hidden button is a UI convention and this needs to be a routing
 * fact. See accountantRoutes.js, which has no POST handler to expose.
 *
 * All reads go through the same services /bank uses, so the two views of the
 * data cannot drift apart. Nothing is duplicated here except presentation.
 *
 * The ordering is deliberately statement-first. The house workflow is to
 * reconcile from a printed statement, writing the KashFlow number beside each
 * line; this portal leads with the same thing on screen, rather than with
 * KashFlow's ledger, which is the opposite direction from how the work is
 * actually done.
 */

const VIEW = (name) => path.join('tailwindcss', 'accountant', name);

/** Sign-offs are the accountant's landing context: what has been closed. */
async function recentSignOffs(limit = 5) {
  const BankSignOff = mdb.INTERNAL?.bankSignOff;
  if (!BankSignOff) return [];
  return BankSignOff.find({ deletedAt: null }).sort({ periodEnd: -1 }).limit(limit)
    .select('uuid accountId accountName periodStart periodEnd status signedByName signedAt variance')
    .lean();
}

/* ── overview ─────────────────────────────────────────────────────── */

export const getOverview = async (req, res, next) => {
  try {
    await mdb.connect();

    const [overview, imports] = await Promise.all([
      worklist.getOverview(),
      statements.listImports({ limit: 6 }),
    ]);

    // A statement whose running balance did not verify is not evidence of
    // anything, so it is counted separately rather than folded into a total
    // that would imply more coverage than exists.
    const trusted = imports.filter(i => i.status === 'parsed' && i.balanceChainOk).length;

    res.render(VIEW('index'), {
      title: 'Bank reconciliation',
      accounts: overview.accounts,
      totals: overview.totals,
      imports,
      trustedImports: trusted,
      signOffs: await recentSignOffs(),
    });
  } catch (err) { next(err); }
};

/* ── one account's ledger ─────────────────────────────────────────── */

export const getAccount = async (req, res, next) => {
  try {
    await mdb.connect();
    const accountId = Number(req.params.accountId);
    if (!Number.isFinite(accountId)) return res.redirect('/accountant');

    const filters = {
      // 'all' rather than /bank's 'outstanding': an external accountant is
      // reading the ledger, not working a review queue, and 'outstanding'
      // silently hides every line that has no match record at all.
      state: String(req.query.state || 'all'),
      search: String(req.query.search || '').trim().slice(0, 100),
      from: req.query.from || '',
      to: req.query.to || '',
      entity: String(req.query.entity || ''),
      pageSize: worklist.clampPageSize(req.query.pageSize),
    };

    const accounts = await worklist.listAccounts();
    const account = accounts.find(a => a.accountId === accountId)
      || { accountId, accountName: 'Unknown account', known: false };

    const result = await worklist.getWorklist({ accountId, page: req.query.page, ...filters });

    res.render(VIEW('account'), {
      title: `${account.accountName} — ledger`,
      account,
      accounts,
      filters,
      ...result,
    });
  } catch (err) { next(err); }
};

/* ── one bank line ────────────────────────────────────────────────── */

export const getLine = async (req, res, next) => {
  try {
    await mdb.connect();
    const bankAccountId = Number(req.params.bankAccountId);
    const bankTransactionId = Number(req.params.bankTransactionId);

    const BankTransaction = mdb.REST?.bankTransaction;
    if (!BankTransaction) throw Object.assign(new Error('Bank data is unavailable'), { statusCode: 503 });

    // Both halves of the composite key. An internal transfer is two ledger
    // lines sharing one KashFlow Id, so `Id` alone resolves to whichever half
    // Mongo happened to return — and for a reader comparing against a
    // statement, that is the difference between the right line and a line on
    // another account for the same money.
    const line = await BankTransaction.findOne({ AccountId: bankAccountId, Id: bankTransactionId }).lean();
    if (!line) return res.redirect('/accountant');

    const key = bankLineKey(line);
    const [resolution, accounts] = await Promise.all([
      resolveBankLine(line),
      worklist.listAccounts(),
    ]);

    const BankMatch = mdb.INTERNAL?.bankMatch;
    const matches = BankMatch
      ? (await BankMatch.find({ 'bankLines.bankTransactionId': bankTransactionId, deletedAt: null })
        .sort({ createdAt: -1 }).lean())
        .filter(m => (m.bankLines || []).some(l => (l.bankLineKey || bankLineKey(l)) === key))
      : [];

    // The other half of a transfer, if this is one. Shown because on a
    // statement it appears once, and an accountant chasing "where did this go"
    // otherwise has to search the whole ledger for the counterpart.
    const otherHalf = await BankTransaction.findOne({
      Id: bankTransactionId,
      AccountId: { $ne: bankAccountId },
      ...LIVE_BANK_LINE,
    }).lean();

    // The statement line this was matched to, if a statement has been imported
    // covering it — the on-screen equivalent of the number written in the margin.
    const StatementLine = mdb.INTERNAL?.statementLine;
    const statementLine = StatementLine
      ? await StatementLine.findOne({
        matchedBankAccountId: bankAccountId,
        matchedBankTransactionId: bankTransactionId,
        deletedAt: null,
      }).lean()
      : null;

    res.render(VIEW('line'), {
      title: `Bank line ${line.Id}`,
      line: { ...line, amount: signedAmount(line) },
      account: accounts.find(a => a.accountId === line.AccountId) || null,
      resolution,
      matches,
      current: matches.find(m => ['suggested', 'confirmed'].includes(m.status)) || null,
      otherHalf: otherHalf ? { ...otherHalf, amount: signedAmount(otherHalf) } : null,
      statementLine,
    });
  } catch (err) { next(err); }
};

/* ── statements ───────────────────────────────────────────────────── */

export const getStatements = async (req, res, next) => {
  try {
    await mdb.connect();
    const accountId = req.query.accountId ? Number(req.query.accountId) : null;

    const [imports, accounts] = await Promise.all([
      statements.listImports({ accountId: Number.isFinite(accountId) ? accountId : null }),
      worklist.listAccounts(),
    ]);

    res.render(VIEW('statements'), {
      title: 'Bank statements',
      imports,
      accounts,
      selectedAccountId: Number.isFinite(accountId) ? accountId : null,
    });
  } catch (err) { next(err); }
};

export const getStatement = async (req, res, next) => {
  try {
    await mdb.connect();
    const found = await statements.getImport(req.params.uuid);
    if (!found) return res.redirect('/accountant/statements');

    // Counts for the summary strip. Derived here rather than in the view so
    // the view stays presentational and the arithmetic is testable.
    const lines = found.lines || [];
    const summary = {
      total: lines.length,
      matched: lines.filter(l => l.status === 'matched').length,
      unmatched: lines.filter(l => l.status === 'unmatched').length,
      ignored: lines.filter(l => l.status === 'ignored').length,
    };

    res.render(VIEW('statement'), {
      title: `Statement — ${found.statementImport.originalFileName || found.statementImport.uuid}`,
      summary,
      ...found,
    });
  } catch (err) { next(err); }
};

/* ── queries ──────────────────────────────────────────────────────── */

/**
 * The accountant's version of /bank/exceptions.
 *
 * Deliberately narrower than the internal one: it carries the two findings an
 * outside reader can actually act on — money on the statement that was never
 * booked, and lines still unexplained — and omits the internal housekeeping
 * (drifted fact hashes, KashFlow's own reconciled flag disagreeing with ours),
 * which reads as alarming without the context to judge it.
 */
export const getQueries = async (req, res, next) => {
  try {
    await mdb.connect();

    const BankTransaction = mdb.REST?.bankTransaction;
    const BankMatch = mdb.INTERNAL?.bankMatch;

    const [gaps, unexplained] = await Promise.all([
      threeWay.findDiscrepancies(),

      // Live lines that no job could explain: no KashFlow document link, no
      // rule, no transfer pairing. These are the ones an accountant is best
      // placed to identify, so they lead rather than hide behind a filter.
      (async () => {
        if (!BankTransaction || !BankMatch) return [];
        const claimed = new Set(
          (await BankMatch.distinct('bankLines.bankLineKey', { deletedAt: null })).filter(Boolean),
        );
        const rows = await BankTransaction.find({ ...LIVE_BANK_LINE })
          .sort({ Date: -1 })
          .select('Id AccountId Date EntityName ResourceNumber PaidIn PaidOut Comment Type')
          .limit(4000)
          .lean();
        return rows
          .filter(l => !claimed.has(bankLineKey(l)))
          .slice(0, 200)
          .map(l => ({ ...l, amount: signedAmount(l) }));
      })(),
    ]);

    res.render(VIEW('queries'), {
      title: 'Queries',
      gaps,
      unexplained,
    });
  } catch (err) { next(err); }
};

/* ── sign-off history ─────────────────────────────────────────────── */

export const getSignOffs = async (req, res, next) => {
  try {
    await mdb.connect();
    const BankSignOff = mdb.INTERNAL?.bankSignOff;
    const signOffs = BankSignOff
      ? await BankSignOff.find({ deletedAt: null }).sort({ periodEnd: -1 }).limit(200).lean()
      : [];

    res.render(VIEW('signoff'), {
      title: 'Signed periods',
      signOffs,
      accounts: await worklist.listAccounts(),
    });
  } catch (err) { next(err); }
};

export default {
  getOverview,
  getAccount,
  getLine,
  getStatements,
  getStatement,
  getQueries,
  getSignOffs,
};
