import path from 'path';
import mdb from '../services/mongooseDatabaseService.js';
import auditLog from '../../services/auditLogService.js';
import worklist from '../services/bankWorklistService.js';
import recon from '../services/bankReconciliationService.js';
import { resolveBankLine, signedAmount } from '../services/bankLinkService.js';

/**
 * HTTP layer for bank reconciliation. Thin by design: parse and validate,
 * delegate to the services, render or flash-and-redirect.
 *
 * Auth lives in bankRoutes.js, not here.
 */

const VIEW = (name) => path.join('tailwindcss', 'bank', name);

/** Where to send the user back to after a POST on a bank line. */
function backTo(req, fallback = '/bank') {
  const ref = req.get('referer');
  return ref || fallback;
}

/* ── overview ─────────────────────────────────────────────────────── */

export const getOverview = async (req, res, next) => {
  try {
    await mdb.connect();
    const overview = await worklist.getOverview();
    res.render(VIEW('index'), { title: 'Bank Reconciliation', ...overview });
  } catch (err) { next(err); }
};

/* ── worklist ─────────────────────────────────────────────────────── */

export const getAccount = async (req, res, next) => {
  try {
    await mdb.connect();
    const accountId = Number(req.params.accountId);
    if (!Number.isFinite(accountId)) {
      req.flash('error', 'That account id is not valid.');
      return res.redirect('/bank');
    }

    const filters = {
      state: String(req.query.state || 'outstanding'),
      search: String(req.query.search || '').trim().slice(0, 100),
      from: req.query.from || '',
      to: req.query.to || '',
      entity: String(req.query.entity || ''),
      pageSize: worklist.clampPageSize(req.query.pageSize),
    };

    const accounts = await worklist.listAccounts();
    const account = accounts.find(a => a.accountId === accountId) || {
      accountId, accountName: 'Unknown account', known: false,
    };

    const result = await worklist.getWorklist({
      accountId,
      page: req.query.page,
      ...filters,
    });

    res.render(VIEW('account'), {
      title: `${account.accountName} — Reconciliation`,
      account,
      filters,
      ...result,
    });
  } catch (err) { next(err); }
};

/* ── single line ──────────────────────────────────────────────────── */

export const getLine = async (req, res, next) => {
  try {
    await mdb.connect();
    const bankTransactionId = Number(req.params.bankTransactionId);
    const BankTransaction = mdb.REST?.bankTransaction;
    if (!BankTransaction) throw Object.assign(new Error('Bank data is unavailable'), { statusCode: 503 });

    const line = await BankTransaction.findOne({ Id: bankTransactionId }).lean();
    if (!line) {
      req.flash('error', 'That bank line no longer exists.');
      return res.redirect('/bank');
    }

    const resolution = await resolveBankLine(line);
    const BankMatch = mdb.INTERNAL?.bankMatch;
    const matches = BankMatch
      ? await BankMatch.find({ 'bankLines.bankTransactionId': bankTransactionId, deletedAt: null })
        .sort({ createdAt: -1 }).lean()
      : [];

    const accounts = await worklist.listAccounts();
    const account = accounts.find(a => a.accountId === line.AccountId) || null;

    res.render(VIEW('match'), {
      title: `Bank line ${line.Id}`,
      line: { ...line, amount: signedAmount(line) },
      account,
      resolution,
      matches,
      current: matches.find(m => ['suggested', 'confirmed'].includes(m.status)) || null,
    });
  } catch (err) { next(err); }
};

/* ── decisions ────────────────────────────────────────────────────── */

export const postConfirm = async (req, res, next) => {
  try {
    await mdb.connect();
    const { uuid } = req.params;

    // Reviewer-adjusted allocations arrive as parallel arrays from the form.
    let documents = null;
    if (req.body.docKey) {
      const keys = [].concat(req.body.docKey);
      const amounts = [].concat(req.body.allocatedAmount || []);
      const BankMatch = mdb.INTERNAL?.bankMatch;
      const existing = await BankMatch.findOne({ uuid, deletedAt: null }).lean();
      if (existing) {
        documents = (existing.documents || [])
          .filter(d => keys.includes(d.docKey))
          .map((d) => {
            const idx = keys.indexOf(d.docKey);
            const raw = Number(amounts[idx]);
            return { ...d, allocatedAmount: Number.isFinite(raw) ? raw : d.allocatedAmount };
          });
      }
    }

    const match = await recon.confirmMatch(uuid, {
      user: req.user,
      documents,
      reviewNote: String(req.body.reviewNote || '').trim().slice(0, 1000),
    });

    auditLog.record('bank_match_confirmed', req, {
      meta: {
        matchUuid: match.uuid,
        accountId: match.accountId,
        bankTransactionIds: (match.bankLines || []).map(l => l.bankTransactionId),
        docKeys: (match.documents || []).map(d => d.docKey),
        bankTotal: match.totals?.bankTotal,
      },
    });

    req.flash('success', 'Match confirmed.');
    res.redirect(backTo(req));
  } catch (err) {
    if (err.name === 'BankReconciliationError') {
      req.flash('error', err.message);
      return res.redirect(backTo(req));
    }
    next(err);
  }
};

export const postReject = async (req, res, next) => {
  try {
    await mdb.connect();
    await recon.rejectMatch(req.params.uuid, {
      user: req.user,
      reason: String(req.body.reason || '').trim().slice(0, 1000),
    });

    auditLog.record('bank_match_rejected', req, { meta: { matchUuid: req.params.uuid } });
    req.flash('success', 'Suggestion rejected.');
    res.redirect(backTo(req));
  } catch (err) {
    if (err.name === 'BankReconciliationError') {
      req.flash('error', err.message);
      return res.redirect(backTo(req));
    }
    next(err);
  }
};

export const postUnconfirm = async (req, res, next) => {
  try {
    await mdb.connect();
    const { original } = await recon.unconfirmMatch(req.params.uuid, {
      user: req.user,
      reason: String(req.body.reason || '').trim().slice(0, 1000),
    });

    auditLog.record('bank_match_unconfirmed', req, {
      meta: { matchUuid: original.uuid, accountId: original.accountId },
    });
    req.flash('success', 'Match reopened. The previous confirmation has been kept for the record.');
    res.redirect(backTo(req));
  } catch (err) {
    if (err.name === 'BankReconciliationError') {
      req.flash('error', err.message);
      return res.redirect(backTo(req));
    }
    next(err);
  }
};

export const postBulkConfirm = async (req, res, next) => {
  try {
    await mdb.connect();
    const uuids = [].concat(req.body.uuid || []).filter(Boolean);
    if (!uuids.length) {
      req.flash('error', 'Select at least one line to confirm.');
      return res.redirect(backTo(req));
    }

    const result = await recon.bulkConfirm(uuids, { user: req.user });

    auditLog.record('bank_match_bulk_confirmed', req, {
      meta: { accountId: Number(req.params.accountId), confirmed: result.confirmed.length, failed: result.failed.length },
    });

    if (result.confirmed.length) {
      req.flash('success', `Confirmed ${result.confirmed.length} match${result.confirmed.length === 1 ? '' : 'es'}.`);
    }
    if (result.failed.length) {
      // Name the first few rather than a bare count, so the reviewer can act.
      const detail = result.failed.slice(0, 3).map(f => f.message).join(' ');
      req.flash('error', `${result.failed.length} could not be confirmed. ${detail}`);
    }
    res.redirect(backTo(req, `/bank/accounts/${req.params.accountId}`));
  } catch (err) { next(err); }
};

/* ── suggestions ──────────────────────────────────────────────────── */

export const postGenerate = async (req, res, next) => {
  try {
    await mdb.connect();
    const accountId = req.body.accountId ? Number(req.body.accountId) : null;
    const stats = await worklist.generateSuggestions({ accountId });

    req.flash(
      'success',
      `Examined ${stats.examined} linked lines: ${stats.created} new suggestion${stats.created === 1 ? '' : 's'}, `
      + `${stats.skipped} already tracked, ${stats.unresolved} could not be resolved.`,
    );
    res.redirect(backTo(req));
  } catch (err) { next(err); }
};

/* ── sign-off ─────────────────────────────────────────────────────── */

export const getSignOffs = async (req, res, next) => {
  try {
    await mdb.connect();
    const BankSignOff = mdb.INTERNAL?.bankSignOff;
    const signOffs = BankSignOff
      ? await BankSignOff.find({ deletedAt: null }).sort({ periodEnd: -1 }).limit(200).lean()
      : [];
    const accounts = await worklist.listAccounts();

    res.render(VIEW('signoff'), { title: 'Period sign-off', signOffs, accounts });
  } catch (err) { next(err); }
};

export const postSignOff = async (req, res, next) => {
  try {
    await mdb.connect();
    const accountId = Number(req.body.accountId);
    const accounts = await worklist.listAccounts();
    const account = accounts.find(a => a.accountId === accountId);

    const signOff = await recon.createSignOff({
      accountId,
      accountName: account?.accountName || '',
      periodStart: req.body.periodStart,
      periodEnd: req.body.periodEnd,
      openingBalance: Number(req.body.openingBalance) || 0,
      closingBalancePerStatement: req.body.closingBalancePerStatement === ''
        ? null
        : Number(req.body.closingBalancePerStatement),
      notes: String(req.body.notes || '').trim().slice(0, 2000),
      force: req.body.force === 'on' || req.body.force === 'true',
      user: req.user,
    });

    auditLog.record('bank_signoff_signed', req, {
      meta: {
        signOffUuid: signOff.uuid,
        accountId,
        periodStart: signOff.periodStart,
        periodEnd: signOff.periodEnd,
        matchedCount: signOff.matchedCount,
        unmatchedCount: signOff.unmatchedCount,
      },
    });

    req.flash('success', `Signed off ${signOff.matchedCount} matches for the period.`);
    res.redirect('/bank/signoff');
  } catch (err) {
    if (err.name === 'BankReconciliationError') {
      req.flash('error', err.message);
      return res.redirect('/bank/signoff');
    }
    next(err);
  }
};

export const postReopen = async (req, res, next) => {
  try {
    await mdb.connect();
    const signOff = await recon.reopenSignOff(req.params.uuid, {
      user: req.user,
      reason: String(req.body.reason || '').trim().slice(0, 1000),
    });

    auditLog.record('bank_signoff_reopened', req, {
      meta: { signOffUuid: signOff.uuid, accountId: signOff.accountId, reason: signOff.reopenReason },
    });

    req.flash('success', 'Period reopened.');
    res.redirect('/bank/signoff');
  } catch (err) {
    if (err.name === 'BankReconciliationError') {
      req.flash('error', err.message);
      return res.redirect('/bank/signoff');
    }
    next(err);
  }
};

/* ── exceptions ───────────────────────────────────────────────────── */

export const getExceptions = async (req, res, next) => {
  try {
    await mdb.connect();
    const BankMatch = mdb.INTERNAL?.bankMatch;
    const BankTransaction = mdb.REST?.bankTransaction;

    const fortyFiveDaysAgo = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);

    const [drifted, unresolvable, staleUnmatched, kfDisagreement] = await Promise.all([
      // Confirmed, but the underlying document has since changed or vanished.
      BankMatch
        ? BankMatch.find({ status: 'confirmed', integrity: { $ne: 'ok' }, deletedAt: null })
          .sort({ driftDetectedAt: -1 }).limit(200).lean()
        : [],

      // Carries a KashFlow link that does not resolve to anything.
      (async () => {
        if (!BankTransaction) return [];
        const lines = await BankTransaction.find({
          EntityName: { $in: ['purchase', 'invoice', 'purchasebatchpayment', 'invoicebatchpayment'] },
        }).select('Id AccountId Date EntityName ResourceNumber PaidIn PaidOut Comment').limit(5000).lean();

        const out = [];
        for (const line of lines) {
          const r = await resolveBankLine(line);
          if (!r.resolved || r.problems.length) {
            out.push({ line: { ...line, amount: signedAmount(line) }, problems: r.problems, resolved: r.resolved });
          }
          if (out.length >= 200) break;
        }
        return out;
      })(),

      // Old and still not accounted for.
      (async () => {
        if (!BankTransaction || !BankMatch) return [];
        const claimed = await BankMatch.distinct('bankLines.bankTransactionId', {
          status: { $in: ['confirmed'] }, deletedAt: null,
        });
        return BankTransaction.find({
          Date: { $lt: fortyFiveDaysAgo },
          Id: { $nin: claimed.filter(v => v != null) },
        }).sort({ Date: 1 }).limit(200)
          .select('Id AccountId Date EntityName ResourceNumber PaidIn PaidOut Comment').lean();
      })(),

      // KashFlow says reconciled, we have no confirmed match — and the inverse.
      (async () => {
        if (!BankTransaction || !BankMatch) return { kfOnly: [], usOnly: [] };
        const confirmedIds = (await BankMatch.distinct('bankLines.bankTransactionId', {
          status: 'confirmed', deletedAt: null,
        })).filter(v => v != null);

        const [kfOnly, usOnly] = await Promise.all([
          BankTransaction.find({ Reconciled: true, Id: { $nin: confirmedIds } })
            .limit(100).select('Id AccountId Date Comment PaidIn PaidOut').lean(),
          BankTransaction.find({ Reconciled: { $ne: true }, Id: { $in: confirmedIds } })
            .limit(100).select('Id AccountId Date Comment PaidIn PaidOut').lean(),
        ]);
        return { kfOnly, usOnly };
      })(),
    ]);

    res.render(VIEW('exceptions'), {
      title: 'Reconciliation exceptions',
      drifted,
      unresolvable,
      staleUnmatched,
      kfDisagreement,
      staleCutoff: fortyFiveDaysAgo,
    });
  } catch (err) { next(err); }
};

export default {
  getOverview,
  getAccount,
  getLine,
  postConfirm,
  postReject,
  postUnconfirm,
  postBulkConfirm,
  postGenerate,
  getSignOffs,
  postSignOff,
  postReopen,
  getExceptions,
};
