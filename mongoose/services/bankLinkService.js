import crypto from 'crypto';
import mdb from './mongooseDatabaseService.js';

/**
 * Resolves a KashFlow bank transaction to the document(s) it settles.
 *
 * This is a lookup, not a guess. KashFlow already records the link on every
 * bank line it generated, via EntityName + ResourceNumber:
 *
 *   purchase / invoice                  -> that document's Number
 *   purchasebatchpayment /
 *   invoicebatchpayment                 -> PaymentLines.BulkPaymentNumber,
 *                                          fanning out to several documents
 *   journal                             -> a journal entry
 *   banktransaction                     -> nothing; no ResourceNumber at all
 *
 * Measured against the live database, 10,882 of 13,429 bank lines (81%) carry
 * one of the linked EntityNames, and a 400-line sample of each of the direct
 * kinds resolved 400/400 to a real document. The remaining 2,547 are
 * EntityName 'banktransaction' — wages control, directors loan, loan
 * repayments, transfers, charges — which is what the rules engine and the
 * scoring matcher are for.
 *
 * Nothing here writes to KashFlow, and nothing here confirms a match: it
 * produces proposals for a person to review.
 */

/**
 * Bank lines that still exist in KashFlow.
 *
 * hcs-sync soft-deletes transactions KashFlow stops returning. A deleted line
 * must never reach the worklist: it looks perfectly reconcilable and could be
 * matched against a document it never paid for.
 *
 * Spread into every query that reads bank transactions.
 */
export const LIVE_BANK_LINE = { deletedAt: null };

// Bank lines KashFlow generated from a document.
const DIRECT_ENTITIES = { purchase: 'purchase', invoice: 'invoice' };
const BATCH_ENTITIES = { purchasebatchpayment: 'purchase', invoicebatchpayment: 'invoice' };

/** Money in is positive, money out negative, so allocations are plain addition. */
export function signedAmount(bankTx) {
  const paidIn = Number(bankTx?.PaidIn) || 0;
  const paidOut = Number(bankTx?.PaidOut) || 0;
  return paidIn > 0 ? paidIn : -paidOut;
}

/**
 * Two money amounts agree within a tolerance, expressed in pounds.
 *
 * Compared in integer pence. A plain float subtraction fails at the boundary —
 * Math.abs(100 - 100.01) is 0.010000000000005, which is not <= 0.01 — so an
 * exact penny difference would be reported as a mismatch.
 */
export function amountsAgree(a, b, tolerance = 0.01) {
  const pence = (v) => Math.round((Number(v) || 0) * 100);
  return Math.abs(pence(a) - pence(b)) <= Math.round(tolerance * 100);
}

/**
 * The allocation a document should carry for a given bank movement.
 *
 * Purchases settle money out, so an ordinary purchase payment is a negative
 * bank amount against a positive allocation. A supplier refund inverts both:
 * the purchase is a credit note with a negative gross and a negative payment
 * line, and the money comes back in. Invoices run the other way.
 *
 * Comparing absolute values would hide a genuinely inverted sign, and would
 * wrongly flag the ten refunds in the live data as mismatches.
 */
export function expectedAllocation(bankSigned, kind) {
  return kind === 'invoice' ? bankSigned : -bankSigned;
}

/**
 * Stable fingerprint of the facts a match was made against, so the drift job
 * can tell "the document changed underneath us" from "nothing happened".
 * Deliberately excludes anything the sync rewrites on every run (syncedAt,
 * _kfHash) — those would make every match look drifted after one sync.
 */
export function factHash(parts) {
  const canonical = JSON.stringify(parts, Object.keys(parts).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

export function bankLineFactHash(bankTx) {
  return factHash({
    id: bankTx?.Id ?? null,
    accountId: bankTx?.AccountId ?? null,
    amount: signedAmount(bankTx),
    date: bankTx?.Date ? new Date(bankTx.Date).toISOString() : null,
    resourceNumber: bankTx?.ResourceNumber ?? null,
  });
}

export function documentFactHash(doc) {
  return factHash({
    id: doc?.Id ?? null,
    number: doc?.Number ?? null,
    gross: Number(doc?.GrossAmount) || 0,
    status: doc?.Status ?? null,
    issued: doc?.IssuedDate ? new Date(doc.IssuedDate).toISOString() : null,
  });
}

function partyNameOf(doc, kind) {
  return (kind === 'invoice' ? doc?.CustomerName : doc?.SupplierName) || '';
}

function docKeyOf(kind, kfId) {
  return `${kind}:${kfId}`;
}

/** Shape a REST document into the snapshot a bankMatch stores. */
function toMatchedDocument(doc, kind, allocatedAmount) {
  return {
    kind,
    kfId: doc.Id ?? null,
    kfNumber: doc.Number ?? null,
    docKey: docKeyOf(kind, doc.Id),
    allocatedAmount: Number(allocatedAmount.toFixed(2)),
    docGross: Number(doc.GrossAmount) || 0,
    docDate: doc.IssuedDate || null,
    partyName: partyNameOf(doc, kind),
    factHash: documentFactHash(doc),
  };
}

/** The model for a document kind, or null if REST is not loaded. */
function modelFor(kind) {
  if (kind === 'invoice') return mdb.REST?.invoice || null;
  if (kind === 'purchase') return mdb.REST?.purchase || null;
  return null;
}

/**
 * Classify a bank line without touching the database.
 *
 * Exported separately so the worklist can bucket thousands of lines cheaply
 * before deciding which ones are worth a document lookup.
 */
export function classify(bankTx) {
  const entity = String(bankTx?.EntityName || '').toLowerCase();

  if (DIRECT_ENTITIES[entity]) {
    return { matchType: 'document', kind: DIRECT_ENTITIES[entity], strategy: 'direct' };
  }
  if (BATCH_ENTITIES[entity]) {
    return { matchType: 'batch', kind: BATCH_ENTITIES[entity], strategy: 'batch' };
  }
  if (entity === 'journal') {
    return { matchType: 'journal', kind: 'journal', strategy: 'journal' };
  }
  // 'banktransaction', or anything KashFlow adds later that we do not know.
  return { matchType: null, kind: null, strategy: 'unlinked' };
}

/**
 * Resolve one bank transaction to its document(s).
 *
 * Returns { resolved, matchType, documents, reasons, problems }.
 * `problems` is never a thrown error: an unresolvable line is a row on the
 * exception report, not a failure.
 */
export async function resolveBankLine(bankTx) {
  const problems = [];
  const reasons = [];
  const { matchType, kind, strategy } = classify(bankTx);
  const bankAmount = signedAmount(bankTx);

  if (strategy === 'unlinked') {
    return { resolved: false, matchType: null, documents: [], reasons, problems, strategy };
  }

  if (strategy === 'journal') {
    // Journals settle against the nominal ledger, not a purchase or sales
    // document. There is nothing to fan out to, so this is recorded as
    // accounted-for rather than left on the worklist forever.
    return {
      resolved: true,
      matchType: 'journal',
      documents: [],
      reasons: [`Journal entry ${bankTx.ResourceNumber ?? ''}`.trim()],
      problems,
      strategy,
    };
  }

  const resourceNumber = Number(bankTx?.ResourceNumber);
  if (!Number.isFinite(resourceNumber) || resourceNumber <= 0) {
    problems.push(`EntityName is '${bankTx?.EntityName}' but ResourceNumber is missing`);
    return { resolved: false, matchType, documents: [], reasons, problems, strategy };
  }

  const Model = modelFor(kind);
  if (!Model) {
    problems.push(`${kind} model is not loaded`);
    return { resolved: false, matchType, documents: [], reasons, problems, strategy };
  }

  const projection = 'Id Number GrossAmount IssuedDate Status SupplierName CustomerName PaymentLines';

  const expected = expectedAllocation(bankAmount, kind);

  if (strategy === 'direct') {
    const doc = await Model.findOne({ Number: resourceNumber }).select(projection).lean();
    if (!doc) {
      problems.push(`${kind} ${resourceNumber} referenced by this bank line no longer exists`);
      return { resolved: false, matchType, documents: [], reasons, problems, strategy };
    }

    const documents = [toMatchedDocument(doc, kind, expected)];
    reasons.push(`KashFlow links this line to ${kind} ${doc.Number}`);

    if (!amountsAgree(doc.GrossAmount, expected)) {
      // Normal for part payments and CIS deductions — recorded, not rejected.
      problems.push(
        `Bank amount ${expected.toFixed(2)} differs from ${kind} gross ${(Number(doc.GrossAmount) || 0).toFixed(2)}`,
      );
    } else {
      reasons.push('Amount matches the document gross exactly');
    }

    return { resolved: true, matchType, documents, reasons, problems, strategy };
  }

  // Batch: one bank line settling several documents. ResourceNumber is the
  // batch number, found on the payment lines of every document it paid.
  const docs = await Model.find({ 'PaymentLines.BulkPaymentNumber': resourceNumber })
    .select(projection)
    .lean();

  if (!docs.length) {
    problems.push(`No ${kind} carries batch payment ${resourceNumber}`);
    return { resolved: false, matchType, documents: [], reasons, problems, strategy };
  }

  const documents = [];
  let allocated = 0;
  for (const doc of docs) {
    // Allocate this document's share from its own payment lines, not the
    // document gross — a batch may part-pay an invoice.
    const share = (doc.PaymentLines || [])
      .filter(pl => Number(pl?.BulkPaymentNumber) === resourceNumber)
      .reduce((sum, pl) => sum + (Number(pl?.Amount) || 0), 0);
    allocated += share;
    documents.push(toMatchedDocument(doc, kind, share));
  }

  reasons.push(`Batch payment ${resourceNumber} settles ${documents.length} ${kind}${documents.length === 1 ? '' : 's'}`);

  if (!amountsAgree(allocated, expected)) {
    problems.push(
      `Allocations total ${allocated.toFixed(2)} but the bank line implies ${expected.toFixed(2)}`,
    );
  } else {
    reasons.push('Allocations sum exactly to the bank amount');
  }

  return { resolved: true, matchType, documents, reasons, problems, strategy };
}

/**
 * Build the bankMatch payload for a resolved bank line.
 * Returns null when the line could not be resolved.
 */
export async function buildMatchFromLink(bankTx) {
  const result = await resolveBankLine(bankTx);
  if (!result.resolved) return null;

  const bankAmount = signedAmount(bankTx);
  const documentTotal = result.documents.reduce((s, d) => s + (Number(d.allocatedAmount) || 0), 0);

  return {
    accountId: bankTx.AccountId,
    direction: bankAmount >= 0 ? 'in' : 'out',
    matchType: result.matchType,
    bankLines: [{
      source: 'banktransaction',
      bankTransactionId: bankTx.Id,
      date: bankTx.Date || null,
      amount: bankAmount,
      description: bankTx.Comment || bankTx.Type || '',
      factHash: bankLineFactHash(bankTx),
    }],
    documents: result.documents,
    totals: {
      bankTotal: Number(bankAmount.toFixed(2)),
      documentTotal: Number(documentTotal.toFixed(2)),
      variance: Number((Math.abs(bankAmount) - documentTotal).toFixed(2)),
    },
    status: 'suggested',
    // KashFlow's own link, so there is no scoring involved and nothing to be
    // uncertain about — but it is still only a suggestion until a person
    // confirms it.
    confidence: 100,
    origin: 'link',
    reasons: result.reasons,
  };
}

export default {
  classify,
  resolveBankLine,
  buildMatchFromLink,
  signedAmount,
  amountsAgree,
  expectedAllocation,
  factHash,
  bankLineFactHash,
  documentFactHash,
};
