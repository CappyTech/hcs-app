/**
 * cisCheckService.js — our CIS deduction against KashFlow's.
 *
 * Sending a subcontractor invoice creates the purchase at its gross; the CIS
 * deduction is added by hand in KashFlow afterwards (the draft page's CIS
 * Reminder). At send we keep what we worked out (`cisAtSend`: the
 * supplier's rate on the labour entered), and once hcs-sync brings the
 * purchase back we set KashFlow's CIS lines against it (`cisCheck`), so a
 * deduction that was never added, or added wrong, shows up:
 *
 *   matches     KashFlow's CIS lines come to our deduction (to the penny)
 *   differs     they don't
 *   missing     we expect a deduction and KashFlow has no CIS line yet
 *   not-synced  the purchase isn't in the synced data (yet)
 *
 * `missing` and `differs` documents are the "CIS to check" queue.
 */

import cisMappings from '../../config/cisMappings.js';
import entry from './documentEntryService.js';
import { CIS_CHECK_STATUSES } from '../../models/mongoose/PAPERLESS/OcrDocument.js';

export { CIS_CHECK_STATUSES };
/** The statuses that need someone to look in KashFlow. */
export const CIS_OPEN_STATUSES = ['missing', 'differs'];

const pennies = (n) => Math.round(Number(n) * 100);

/** A purchase line's amount, as cisController and returnsController read it. */
function lineAmount(line) {
  if (line.Amount != null && line.Amount !== '') return Number(line.Amount);
  if (line.NetAmount != null && line.NetAmount !== '') return Number(line.NetAmount);
  const qty = Number(line.Quantity ?? line.Qty) || 0;
  const rate = Number(line.Rate ?? line.UnitPrice ?? line.Price ?? line.Unit) || 0;
  return rate * qty;
}

/** A CIS deduction line: KashFlow's CIS charge type, or a CIS deduction nominal. */
export function isCisLine(line) {
  if (!line) return false;
  if (line.ChargeType != null && Number(line.ChargeType) === cisMappings.chargeTypes.cisDeduction) return true;
  const nc = Number(line.NominalCode) || null;
  return !!nc && (cisMappings.cisDeductionNominalCodes || []).includes(nc);
}

/**
 * The CIS deduction recorded on a KashFlow purchase: its CIS lines, as a
 * positive amount. Null when it has no CIS line.
 */
export function kashflowCisDeduction(purchase) {
  const lines = Array.isArray(purchase?.LineItems) && purchase.LineItems.length ? purchase.LineItems
    : Array.isArray(purchase?.Lines) ? purchase.Lines : [];
  const cis = lines.filter(isCisLine);
  if (!cis.length) return null;
  return pennies(cis.reduce((s, l) => s + Math.abs(lineAmount(l)), 0)) / 100;
}

/**
 * What we work out at send: the supplier's CIS rate on the labour entered.
 * Null for anything but a subcontractor invoice with a supplier, a rate and
 * labour.
 * @param {object} doc OcrDocument (lean) with entry, documentType, correspondent
 * @param {object|null} supplier REST supplier (Code, WithholdingTaxRate)
 */
export function cisAtSend(doc, supplier, at = new Date()) {
  if (!supplier || !entry.isSubcontractorEntry(doc)) return null;
  const v = entry.formValues(doc);
  const c = entry.cisDeduction(v, supplier.WithholdingTaxRate);
  if (!c) return null;
  return {
    supplierCode: supplier.Code || null,
    ratePct: c.ratePct,
    labour: Number(v.labour),
    deduction: c.deduction,
    payable: c.payable,
    at,
  };
}

/**
 * The deduction rounded down to the penny: HMRC sets no rounding for
 * fractions of a penny (the CIS300 only wants pounds and pence), and
 * subcontractors often round down where we round to the nearest. Null
 * without the labour and rate it was worked out from.
 */
function roundedDown(ours) {
  if (ours?.labour == null || ours?.ratePct == null) return null;
  const labour = pennies(ours.labour);
  const rate = Number(ours.ratePct);
  if (!Number.isFinite(labour) || !Number.isFinite(rate)) return null;
  return Math.floor(Math.round(labour * rate * 1e6) / 1e8);
}

/**
 * Our deduction against the synced purchase. KashFlow's figure matches when
 * it's ours to the penny, or the same worked out rounded down instead.
 * @returns {{status, kashflow: number|null, difference: number|null}}
 */
export function compareCis(ours, purchase) {
  if (!purchase) return { status: 'not-synced', kashflow: null, difference: null };
  const kashflow = kashflowCisDeduction(purchase);
  const expected = Number(ours?.deduction) || 0;
  if (kashflow == null) {
    // Nothing to take off (a 0% supplier) and nothing taken: that's right
    return expected === 0
      ? { status: 'matches', kashflow: null, difference: 0 }
      : { status: 'missing', kashflow: null, difference: null };
  }
  if (pennies(kashflow) === roundedDown(ours)) return { status: 'matches', kashflow, difference: 0 };
  const diff = pennies(kashflow) - pennies(expected);
  return { status: diff === 0 ? 'matches' : 'differs', kashflow, difference: diff / 100 };
}

/** The synced purchase a document was sent as, or null. */
async function purchaseFor(Purchase, doc) {
  if (!Purchase || doc.kashflowPurchaseId == null) return null;
  return Purchase.findOne({ Id: doc.kashflowPurchaseId, deletedAt: null, DeletedAt: null }).select('Id Number LineItems Lines').lean();
}

/**
 * Check one document now and keep the result on it. Returns the new
 * `cisCheck`, or null when the document has nothing to check.
 */
export async function refreshCisCheck(OcrDocument, Purchase, doc, now = new Date()) {
  if (!doc?.cisAtSend || doc.kashflowPurchaseId == null) return null;
  const purchase = await purchaseFor(Purchase, doc);
  const cisCheck = { ...compareCis(doc.cisAtSend, purchase), checkedAt: now };
  await OcrDocument.updateOne({ paperlessId: doc.paperlessId }, { $set: { cisCheck } });
  return cisCheck;
}

/**
 * The scheduled pass: every sent subcontractor invoice that isn't known to
 * match yet. A match is final unless someone opens the document again.
 */
export async function checkSentCis(OcrDocument, Purchase, { limit = 200, now = new Date() } = {}) {
  const docs = await OcrDocument.find({
    cisAtSend: { $ne: null },
    kashflowPurchaseId: { $ne: null },
    'cisCheck.status': { $ne: 'matches' },
    deletedInPaperlessAt: null,
  }).sort({ lastSentAt: -1 }).limit(limit).select('paperlessId kashflowPurchaseId cisAtSend').lean();
  const counts = Object.fromEntries(CIS_CHECK_STATUSES.map((s) => [s, 0]));
  for (const doc of docs) {
    const c = await refreshCisCheck(OcrDocument, Purchase, doc, now);
    if (c) counts[c.status] += 1;
  }
  return { checked: docs.length, ...counts };
}

/**
 * Our deductions for a set of KashFlow purchases, by purchase Id (as a
 * string), for the CIS dashboard. Purchases not sent from a document are
 * left out.
 */
export async function cisAtSendByPurchaseId(OcrDocument, purchaseIds) {
  const ids = [...new Set(purchaseIds.map(Number).filter(Number.isFinite))];
  if (!OcrDocument || !ids.length) return new Map();
  const docs = await OcrDocument.find({ kashflowPurchaseId: { $in: ids }, cisAtSend: { $ne: null } })
    .select('paperlessId kashflowPurchaseId cisAtSend').lean();
  return new Map(docs.map((d) => [String(d.kashflowPurchaseId), { paperlessId: d.paperlessId, ...d.cisAtSend }]));
}

export default { CIS_CHECK_STATUSES, CIS_OPEN_STATUSES, isCisLine, kashflowCisDeduction, cisAtSend, compareCis, refreshCisCheck, checkSentCis, cisAtSendByPurchaseId };
