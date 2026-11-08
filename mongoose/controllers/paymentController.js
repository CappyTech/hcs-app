import path from 'path';
import mdb from '../services/mongooseDatabaseService.js';
import { getClientIp } from '../../services/ipService.js';
import logger from '../../services/loggerService.js';
import bulkPay from '../services/bulkPaymentService.js';
import sod from '../services/separationOfDutiesService.js';

/**
 * HTTP layer for bulk supplier payments. Thin: parse and validate, delegate to
 * bulkPaymentService, render or flash-and-redirect. Auth lives in
 * paymentRoutes.js.
 *
 * The flow is three stateless steps — select (GET), preview+re-verify (POST),
 * confirm (POST) — and the confirm step RE-VERIFIES against the live KashFlow
 * ledger a second time before writing, so a stale confirmation cannot double-pay
 * an invoice that was settled in between.
 */

const VIEW = (name) => path.join('tailwindcss', 'payments', name);

/**
 * Separation of duties: how many of these purchases did this user enter
 * (saved the Documents entry that sent them to KashFlow)? 0 when the rule
 * doesn't apply to them.
 */
export async function countEnteredBy(user, numbers) {
  if (!sod.applies(user) || !user?._id || !numbers.length) return 0;
  const OcrDocument = mdb.PAPERLESS?.OcrDocument;
  if (!OcrDocument) return 0;
  return OcrDocument.countDocuments({
    kashflowPurchaseNumber: { $in: numbers.map(Number) },
    'entry.savedBy.userId': user._id,
  });
}

/** Parse the posted line rows into [{ number, amount }]. */
function parseLines(body) {
  const numbers = [].concat(body.number || []);
  const amounts = [].concat(body.amount || []);
  const selected = new Set([].concat(body.selected || []).map(String));
  // No explicit selection means pay nothing — never fall through to "all rows".
  // The number[]/amount[] arrays are index-aligned (every row posts both, even
  // unticked ones), and we keep only the rows named in the `selected` set.
  if (!selected.size) return [];
  const out = [];
  for (let i = 0; i < numbers.length; i += 1) {
    const number = String(numbers[i]);
    if (!selected.has(number)) continue;
    out.push({ number: Number(number), amount: Number(amounts[i]) });
  }
  return out;
}

/* ── step 1: select ───────────────────────────────────────────────── */

export const getBulkPay = async (req, res, next) => {
  try {
    await mdb.connect();
    const filters = {
      supplierId: String(req.query.supplierId || ''),
      search: String(req.query.search || '').trim().slice(0, 100),
      from: req.query.from || '',
      to: req.query.to || '',
      pageSize: bulkPay.clampPageSize(req.query.pageSize),
    };

    const [result, suppliers, bankAccounts, suggestions] = await Promise.all([
      bulkPay.listOutstanding({ ...filters, page: req.query.page }),
      bulkPay.listOutstandingSuppliers(),
      bulkPay.listBankAccounts(),
      bulkPay.paymentSuggestions(),
    ]);

    res.render(VIEW('bulk'), {
      title: 'Bulk Supplier Payment',
      filters,
      suppliers,
      bankAccounts,
      suggestions,
      todayIso: new Date().toISOString().slice(0, 10),
      ...result,
    });
  } catch (err) { next(err); }
};

/* ── step 2: preview + live re-verify ─────────────────────────────── */

export const postPreview = async (req, res, next) => {
  try {
    await mdb.connect();
    const accountId = Number(req.body.accountId);
    const method = Number(req.body.method);
    const date = String(req.body.date || '').slice(0, 10);
    const comment = String(req.body.comment || '').trim().slice(0, 500);
    const items = parseLines(req.body);

    if (!items.length) {
      req.flash('error', 'Select at least one invoice to pay.');
      return res.redirect('/payments/bulk');
    }
    if (!Number.isFinite(accountId)) {
      req.flash('error', 'Choose the bank account to pay from.');
      return res.redirect('/payments/bulk');
    }
    if (!Number.isFinite(method)) {
      req.flash('error', 'Enter the payment method.');
      return res.redirect('/payments/bulk');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      req.flash('error', 'Enter a valid payment date.');
      return res.redirect('/payments/bulk');
    }

    const mine = await countEnteredBy(req.user, items.map((i) => i.number));
    if (mine) {
      req.flash('error', sod.MESSAGES.payPurchases(mine));
      return res.redirect('/payments/bulk');
    }

    const bankAccounts = await bulkPay.listBankAccounts();
    const account = bankAccounts.find((a) => Number(a.Id) === accountId) || null;
    if (!account) {
      req.flash('error', 'That bank account is not recognised.');
      return res.redirect('/payments/bulk');
    }

    const verification = await bulkPay.reverify(items);

    res.render(VIEW('confirm'), {
      title: 'Confirm Bulk Payment',
      account,
      accountId,
      method,
      date,
      comment,
      verification,
    });
  } catch (err) { next(err); }
};

/* ── step 3: confirm + write ──────────────────────────────────────── */

export const postConfirm = async (req, res, next) => {
  try {
    await mdb.connect();
    const accountId = Number(req.body.accountId);
    const method = Number(req.body.method);
    const date = String(req.body.date || '').slice(0, 10);
    const comment = String(req.body.comment || '').trim().slice(0, 500);
    const items = parseLines(req.body);

    if (!items.length || !Number.isFinite(accountId) || !Number.isFinite(method) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      req.flash('error', 'The payment could not be confirmed — please start again.');
      return res.redirect('/payments/bulk');
    }

    // Checked again here: the confirm form can be posted without the preview
    const mine = await countEnteredBy(req.user, items.map((i) => i.number));
    if (mine) {
      req.flash('error', sod.MESSAGES.payPurchases(mine));
      return res.redirect('/payments/bulk');
    }

    const account = (await bulkPay.listBankAccounts()).find((a) => Number(a.Id) === accountId)
      || { Id: accountId, AccountName: `Account ${accountId}` };

    // Re-verify a second time immediately before the write: the confirm page may
    // have sat open while the ledger moved.
    const verification = await bulkPay.reverify(items);
    const payable = verification.lines.filter((l) => l.ok);
    if (!payable.length) {
      req.flash('error', 'None of the selected invoices are still payable — nothing was sent.');
      return res.redirect('/payments/bulk');
    }
    if (verification.blocking > 0) {
      // Something changed since preview. Bounce back to a fresh preview rather
      // than silently paying a subset.
      req.flash('error', `${verification.blocking} line(s) changed in KashFlow since you reviewed them — check the amounts and try again.`);
      return res.render(VIEW('confirm'), {
        title: 'Confirm Bulk Payment',
        account, accountId, method, date, comment, verification,
      });
    }

    let result;
    try {
      result = await bulkPay.createBulkPayment({ accountId, date, method, comment, lines: payable });
    } catch (err) {
      const status = err?.response?.status;
      const body = err?.response?.data;
      logger.error(`[bulkPay] createBulkPayment failed: ${status || ''} ${err.message}`);
      if (body) logger.error(`[bulkPay] error body: ${typeof body === 'object' ? JSON.stringify(body).slice(0, 2000) : String(body).slice(0, 2000)}`);
      req.flash('error', `KashFlow rejected the bulk payment${status ? ` (${status})` : ''}: ${err.message}`);
      return res.redirect('/payments/bulk');
    }

    const numbers = payable.map((l) => l.number);
    // Append a manual audit-trail entry: the write lands in KashFlow, not a
    // Mongo model, so the global audit plugin never sees it. 'bulkPayment' is a
    // logical collection label; the KashFlow request/response is also captured
    // by kashflowApiLog.
    try {
      const Audit = mdb.INTERNAL && mdb.INTERNAL.auditLog;
      if (Audit) {
        await Audit.create({
          collectionName: 'bulkPayment',
          op: 'create',
          actor: req.user?._id || null,
          actorName: req.user?.username || req.user?.name || '',
          actorEmail: req.user?.email || '',
          ip: getClientIp(req) || '',
          method: req.method,
          route: req.originalUrl,
          after: {
            bulkPaymentNumber: result.bulkPaymentNumber,
            accountId,
            accountName: account?.AccountName || null,
            method,
            date,
            total: verification.total,
            comment: comment || null,
            purchaseNumbers: numbers,
          },
        });
      }
    } catch (e) {
      logger.warn('[bulkPay] audit log failed: ' + e.message);
    }

    // Refresh the paid purchases so the list and reconciliation reflect it now.
    await bulkPay.refetchPurchases(numbers).catch((e) =>
      logger.warn('[bulkPay] post-payment refetch failed: ' + e.message));

    const ref = result.bulkPaymentNumber != null ? ` (bulk payment #${result.bulkPaymentNumber})` : '';
    req.flash('success', `Paid ${payable.length} invoice(s), £${verification.total.toFixed(2)}${ref}.`);
    res.redirect('/payments/bulk');
  } catch (err) { next(err); }
};

export default { getBulkPay, postPreview, postConfirm };
