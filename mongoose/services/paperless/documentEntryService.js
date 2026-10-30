/**
 * documentEntryService.js — data entry on the hcs-app entry screen
 * (Paperless migration H5; PB-2, PB-4, PB-5, PB-9, PB-12).
 *
 * Entered values are stored on OcrDocument.entry and nowhere else: they are
 * not written to the Paperless custom fields (decision 3 Oct 2026). The
 * KashFlow draft reads them first through entryAsCustomFields() and falls
 * back to the Paperless fields for anything left blank.
 *
 * The two actions that change a document's state also tell Paperless, so its
 * workflows keep sending the emails until cutover (H8):
 *
 *   Complete entry   awaiting_entry → entered, then adds `data entry done`  (WF3 sends the invoice email)
 *   Credit note on   → manual_kashflow, then sets Credit Note = true         (WF5 sends the credit note email)
 *   Credit note off  → awaiting_entry (admin), then sets Credit Note = false
 *   Reopen entry     entered → awaiting_entry (admin), removes `data entry done`
 *
 * The state change is made first and is what counts. If Paperless then can't
 * be updated, the action still succeeds and returns a `paperlessWarning`
 * saying what to do by hand.
 */

import { transition, isInvoiceDocument, markStatementReviewed, notForEntryMessage, setExcludedReason } from './documentStateService.js';
import { notifySafely } from './documentNotifyService.js';
import { classifyDocument } from './documentIngestService.js';
import { isDocumentType } from '../../config/paperlessTypesConfig.js';
import __paperlessUpdateService from './paperlessUpdateService.js';
import __kfSendClaim from './kashflowSendClaimService.js';
import __paperlessClient from './paperlessClient.js';
import logger from '../../../services/loggerService.js';
import { entryAsCustomFields } from './entryOverlay.js';
import { parseVatRate, vatRateProblem } from '../../../public/js/entry-checks.js';
import { normalizeWhtRate } from '../../../services/cisService.js';

export { entryAsCustomFields };

const { modifyPaperlessDocumentTags } = __paperlessUpdateService;

// ── Parsing ───────────────────────────────────────────────────────────

const INVALID = Symbol('invalid');

const roundTo = (n, dp) => {
  const f = 10 ** dp;
  return Math.round((n + Math.sign(n) * Number.EPSILON) * f) / f;
};

/**
 * '', 'GBP123.45', '£1,234.50', '-12', 12 → number | null | INVALID.
 * Amounts are pennies; a unit price may carry more places (`dp: 4`).
 */
export function parseMoneyInput(v, { dp = 2 } = {}) {
  if (typeof v === 'number') return Number.isFinite(v) ? roundTo(v, dp) : INVALID;
  const s = String(v ?? '').trim();
  if (!s) return null;
  const cleaned = s.replace(/^[A-Z]{3}/i, '').replace(/[£$€,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return INVALID;
  return roundTo(Number(cleaned), dp);
}

function parseNumberInput(v, { integer = false, min = null, max = null } = {}) {
  const s = String(v ?? '').trim().replace(/,/g, '');
  if (!s) return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return INVALID;
  const n = Number(s);
  if (integer && !Number.isInteger(n)) return INVALID;
  if ((min != null && n < min) || (max != null && n > max)) return INVALID;
  return n;
}

/** 'YYYY-MM-DD' (what <input type="date"> sends) → UTC midnight Date | null | INVALID */
export function parseDateInput(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return INVALID;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 ? d : INVALID;
}

const str = (v) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, 500) : null;
};

// qs turns lines[0][description] into an array, but past 20 indexes into an
// object keyed by index; accept both.
const asLineList = (raw) => {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    return Object.keys(raw).sort((a, b) => Number(a) - Number(b)).map((k) => raw[k]);
  }
  return [];
};

/** Which form a document gets (PB-2). Remittances and untyped documents get none. */
export function entryKind(doc) {
  if (isInvoiceDocument(doc)) return 'invoice';
  if (isDocumentType(doc?.documentType, 'bankStatement')) return 'bank';
  if (isDocumentType(doc?.documentType, 'supplierStatement')) return 'statement';
  return null;
}

/** A Subcontractor Invoice: each line is labour or materials, for CIS. */
export function isSubcontractorEntry(doc) {
  return entryKind(doc) === 'invoice' && isDocumentType(doc?.documentType, 'subcontractorInvoice');
}

/** A line's role as chosen, or guessed from its description: materials if it says so, otherwise labour. */
export function lineRole(chosen, description) {
  if (chosen === 'labour' || chosen === 'materials') return chosen;
  return /material/i.test(description || '') ? 'materials' : 'labour';
}

/** The labour and materials totals of a subcontractor invoice's lines; null when there are none of that kind. */
function roleTotals(lines) {
  const sum = (role) => {
    const ls = lines.filter((l) => l.role === role && l.total != null);
    return ls.length ? roundTo(ls.reduce((s, l) => s + l.total, 0), 2) : null;
  };
  return { labour: sum('labour'), materials: sum('materials') };
}

/**
 * Parse a submitted entry form. Never throws. On a subcontractor invoice
 * each line keeps its Labour or Materials role, and the labour and
 * materials totals are worked out from them.
 * @returns {{entry: object, errors: Record<string,string>}}
 */
export function parseEntryForm(body = {}, kind, { subcontractor = false } = {}) {
  const errors = {};
  const take = (field, value, label) => {
    if (value === INVALID) { errors[field] = `${label} isn't valid.`; return null; }
    return value;
  };

  if (kind === 'bank') {
    const b = body.bank || {};
    const bank = {
      accountId: take('bank.accountId', parseNumberInput(b.accountId, { integer: true, min: 0 }), 'Bank account ID'),
      periodStart: take('bank.periodStart', parseDateInput(b.periodStart), 'Period start'),
      periodEnd: take('bank.periodEnd', parseDateInput(b.periodEnd), 'Period end'),
      openingBalance: take('bank.openingBalance', parseMoneyInput(b.openingBalance), 'Opening balance'),
      closingBalance: take('bank.closingBalance', parseMoneyInput(b.closingBalance), 'Closing balance'),
    };
    if (bank.periodStart && bank.periodEnd && bank.periodEnd < bank.periodStart) {
      errors['bank.periodEnd'] = 'Period end is before period start.';
    }
    return { entry: { bank }, errors };
  }

  if (kind !== 'invoice') return { entry: {}, errors };

  const entry = {
    invoiceNumber: str(body.invoiceNumber),
    invoiceDate: take('invoiceDate', parseDateInput(body.invoiceDate), 'Invoice date'),
    dueDate: take('dueDate', parseDateInput(body.dueDate), 'Due date'),
    totalGoods: take('totalGoods', parseMoneyInput(body.totalGoods), 'Total goods'),
    totalVat: take('totalVat', parseMoneyInput(body.totalVat), 'Total VAT'),
    invoiceTotal: take('invoiceTotal', parseMoneyInput(body.invoiceTotal), 'Invoice total'),
    lines: [],
  };

  asLineList(body.lines).forEach((raw, i) => {
    const n = i + 1;
    const line = {
      description: str(raw?.description),
      quantity: take(`lines.${i}.quantity`, parseNumberInput(raw?.quantity), `Line ${n} quantity`),
      price: take(`lines.${i}.price`, parseMoneyInput(raw?.price, { dp: 4 }), `Line ${n} price`),
      total: take(`lines.${i}.total`, parseMoneyInput(raw?.total), `Line ${n} total`),
      vatRate: null,
    };
    const rate = parseVatRate(raw?.vatRate);
    if (Number.isNaN(rate)) errors[`lines.${i}.vatRate`] = vatRateProblem(raw.vatRate, n);
    else line.vatRate = rate;
    // A completely blank row is how a line is removed
    if (Object.values(line).every((v) => v == null)) return;
    if (line.total == null && line.quantity != null && line.price != null) {
      line.total = roundTo(line.quantity * line.price, 2);
    }
    // After the blank check: the role picker always sends a value
    if (subcontractor) line.role = lineRole(raw?.role, line.description);
    entry.lines.push(line);
  });

  if (subcontractor) Object.assign(entry, roleTotals(entry.lines));

  return { entry, errors };
}

/** What must be filled in before Complete entry (PB-5). */
export function completionErrors(entry) {
  const errors = {};
  if (!entry) return { form: 'Nothing has been entered yet.' };
  if (!entry.invoiceNumber) errors.invoiceNumber = 'Invoice number is required.';
  if (!entry.invoiceDate) errors.invoiceDate = 'Invoice date is required.';
  if (entry.invoiceTotal == null) errors.invoiceTotal = 'Invoice total is required.';
  const lines = entry.lines || [];
  if (!lines.some((l) => l.description && l.total != null)) {
    errors.lines = 'At least one line needs a description and a total.';
  }
  return errors;
}

/**
 * The CIS deduction on a subcontractor invoice: the supplier's rate on the
 * labour, and what is left to pay. Null when the rate or labour is unknown.
 * `whtRate` is the supplier's WithholdingTaxRate (20 or 0.2 both work).
 */
export function cisDeduction({ labour, invoiceTotal } = {}, whtRate) {
  const rate = normalizeWhtRate(whtRate);
  const lab = parseMoneyInput(labour);
  if (rate == null || rate === -1 || lab == null || lab === INVALID) return null;
  const deduction = roundTo(lab * rate, 2);
  const total = parseMoneyInput(invoiceTotal);
  return {
    ratePct: roundTo(rate * 100, 0),
    deduction,
    payable: total == null || total === INVALID ? null : roundTo(total - deduction, 2),
  };
}

// Why VAT may still be right on a VAT-registered subcontractor's invoice
const VAT_EXCEPTIONS = "That's only right if we're the end user of the work, it's zero-rated (most new-build housing, at 0%), it's labour from an employment business, or it isn't construction work (goods only, or plant without an operator).";

/**
 * Which of the three VAT cases a subcontractor invoice is, from what each
 * step knows: the VAT numbers read off the document and its OCR text
 * (Paperless), the VAT entered here, and the supplier synced from KashFlow.
 *
 *   not_registered  no VAT number anywhere: no VAT can be charged
 *   reverse_charge  VAT-registered, no VAT charged: we account for the VAT
 *   charged         VAT-registered and VAT charged: only right in the exceptions
 *   unknown         nothing entered yet
 *
 * `supplier` is the matched KashFlow supplier, or null. Pure.
 * @returns {{case: string, tone: 'green'|'amber'|'red', title: string, text: string, items: string[]}}
 */
export function vatCase({ supplier = null, docVatNumbers = [], ocrText = '', totalVat = null, lines = [] } = {}) {
  const vat = parseMoneyInput(totalVat);
  const lineVat = (lines || []).some((l) => Number(l?.vatRate) > 0);
  const entered = (vat != null && vat !== INVALID) || (lines || []).some((l) => l?.vatRate != null && l.vatRate !== '');
  const charged = (vat !== INVALID && vat > 0) || lineVat;
  const kashflowVat = String(supplier?.VatNumber || '').trim();
  const onDocument = (docVatNumbers || []).length > 0;
  const saysReverse = /reverse[\s-]*charge/i.test(ocrText || '');
  const registered = !!kashflowVat || onDocument || saysReverse;
  const items = [];
  if (!supplier) items.push("The supplier isn't matched in KashFlow, so this is from the invoice alone.");

  if (!entered) {
    return { case: 'unknown', tone: 'amber', title: 'VAT: enter it to check', text: registered ? 'The subcontractor looks VAT-registered: expect no VAT on the invoice (reverse charge).' : 'No VAT number found: expect no VAT on the invoice.', items };
  }

  if (!registered) {
    if (!charged) return { case: 'not_registered', tone: 'green', title: 'VAT: not VAT-registered', text: 'No VAT number on the invoice or in KashFlow, and no VAT charged.', items };
    return { case: 'not_registered', tone: 'red', title: 'VAT: charged without a VAT number', text: "VAT is entered, but there's no VAT number on the invoice or in KashFlow. A subcontractor that isn't VAT-registered can't charge VAT: find their VAT number, or enter VAT as 0.", items };
  }

  if (!charged) {
    if (!saysReverse) items.push(`The invoice doesn't say "reverse charge". A reverse-charge invoice has to, so ask for it to be reissued, unless the work is zero-rated.`);
    if (supplier && supplier.IsCISReverseCharge !== true) items.push("KashFlow doesn't have this supplier set as CIS reverse charge.");
    const vatNo = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^GB/, '');
    if (onDocument && kashflowVat && !docVatNumbers.some((n) => vatNo(n) === vatNo(kashflowVat))) {
      items.push("The VAT number on the invoice isn't the one KashFlow has for this supplier.");
    }
    return {
      case: 'reverse_charge', tone: items.some((m) => !m.startsWith("The supplier isn't matched")) ? 'amber' : 'green',
      title: 'VAT: reverse charge',
      text: 'VAT-registered and no VAT charged: the domestic reverse charge. We account for the VAT on our own return instead.', items,
    };
  }

  if (saysReverse) {
    return { case: 'charged', tone: 'red', title: 'VAT: says reverse charge, but VAT entered', text: "The invoice says reverse charge, so there's no VAT for us to pay. Enter VAT as 0.", items };
  }
  if (supplier?.IsCISReverseCharge === true) items.push('KashFlow has this supplier set as CIS reverse charge.');
  return {
    case: 'charged', tone: 'amber', title: 'VAT: charged normally',
    text: `A VAT-registered subcontractor has charged VAT. CIS work between VAT-registered businesses is normally reverse charged, with no VAT on the invoice. ${VAT_EXCEPTIONS}`, items,
  };
}

const money = (n) => (n == null ? '—' : Number(n).toFixed(2));
const off = (a, b) => Math.abs(a - b) > 0.01;

/** Totals that don't add up. Shown as warnings; the KashFlow send checks again. */
export function consistencyWarnings(entry) {
  if (!entry) return [];
  const out = [];
  const lines = entry.lines || [];
  lines.forEach((l, i) => {
    // Saved before VAT % was limited to the rates
    const badRate = l.vatRate != null ? vatRateProblem(l.vatRate, i + 1) : null;
    if (badRate) out.push(badRate);
    // A price kept to 4 places (bricks per thousand: 0.7945) can be out by half a
    // ten-thousandth a unit, so 5,000 bricks may be a few pence out
    const slack = Math.max(0.01, Math.abs(l.quantity ?? 0) * 0.00005);
    if (l.quantity != null && l.price != null && l.total != null && Math.abs(l.quantity * l.price - l.total) > slack + 1e-9) {
      out.push(`Line ${i + 1}: ${l.quantity} × ${money(l.price)} is ${money(l.quantity * l.price)}, not ${money(l.total)}.`);
    }
  });
  const lineSum = lines.reduce((s, l) => s + (l.total ?? 0), 0);
  if (entry.totalGoods != null && lines.some((l) => l.total != null) && off(lineSum, entry.totalGoods)) {
    out.push(`Line totals add up to ${money(lineSum)}, but total goods is ${money(entry.totalGoods)}.`);
  }
  const priced = lines.filter((l) => l.total != null);
  if (entry.totalVat != null && priced.length && priced.every((l) => l.vatRate != null && !Number.isNaN(parseVatRate(l.vatRate)))) {
    const lineVat = priced.reduce((s, l) => s + (l.total * l.vatRate) / 100, 0);
    // Suppliers round VAT per line or on the total, so allow a penny a line
    if (Math.abs(lineVat - entry.totalVat) > Math.max(0.02, 0.01 * priced.length) + 1e-9) {
      out.push(`VAT at the line rates comes to ${money(lineVat)}, but total VAT is ${money(entry.totalVat)}.`);
    }
  }
  if (entry.totalGoods != null && entry.totalVat != null && entry.invoiceTotal != null
      && off(entry.totalGoods + entry.totalVat, entry.invoiceTotal)) {
    out.push(`Goods ${money(entry.totalGoods)} + VAT ${money(entry.totalVat)} is ${money(entry.totalGoods + entry.totalVat)}, not the invoice total ${money(entry.invoiceTotal)}.`);
  }
  return out;
}

// ── Form values ──────────────────────────────────────────────────────

const isoDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const cfValue = (doc, names) => {
  const wanted = names.map((n) => n.toLowerCase());
  const hit = (doc.customFields || []).find((cf) => wanted.includes(String(cf.fieldName || '').trim().toLowerCase()));
  return hit?.value ?? null;
};
const cfMoney = (doc, name) => {
  const v = parseMoneyInput(cfValue(doc, [name]));
  return v === INVALID ? null : v;
};
const cfDate = (doc, name) => {
  const v = cfValue(doc, [name]);
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * What the form shows. The saved hcs-app entry when there is one; otherwise
 * whatever was already keyed into the Paperless custom fields, so nothing has
 * to be typed twice. `source` says which.
 */
export function formValues(doc) {
  const kind = entryKind(doc);
  const e = doc.entry;
  if (kind === 'bank') {
    const b = e?.bank;
    const v = b ? b : {
      accountId: cfValue(doc, ['Bank Account ID']),
      periodStart: cfDate(doc, 'Statement Period Start'),
      periodEnd: cfDate(doc, 'Statement Period End'),
      openingBalance: cfMoney(doc, 'Statement Opening Balance'),
      closingBalance: cfMoney(doc, 'Statement Closing Balance'),
    };
    return {
      source: b ? 'hcs-app' : 'paperless',
      bank: { ...v, periodStart: isoDate(v.periodStart), periodEnd: isoDate(v.periodEnd) },
    };
  }
  if (kind !== 'invoice') return { source: null };
  const v = invoiceFormValues(doc, e);
  return isSubcontractorEntry(doc) ? subcontractorFormValues(v) : v;
}

/**
 * A subcontractor invoice's lines each with a role, and the labour and
 * materials totals for the CIS box. Lines with no role yet (the Paperless
 * fields, or a save before roles) are guessed from their description.
 */
function subcontractorFormValues(v) {
  const lines = (v.lines || []).map((l) => ({ ...l, role: lineRole(l.role, l.description) }));
  return { ...v, lines, ...roleTotals(lines) };
}

function invoiceFormValues(doc, e) {
  if (e && e.savedAt) {
    return {
      source: 'hcs-app',
      ...e,
      invoiceDate: isoDate(e.invoiceDate),
      dueDate: isoDate(e.dueDate),
      lines: (e.lines || []).map((l) => ({ ...l })),
    };
  }
  const lines = [];
  for (let n = 1; n <= 30; n++) {
    const line = {
      description: cfValue(doc, [`Description_Line${n}`]),
      quantity: (() => { const q = parseNumberInput(cfValue(doc, [`Qty_Line${n}`])); return q === INVALID ? null : q; })(),
      price: cfMoney(doc, `Price_Line${n}`),
      total: cfMoney(doc, `Total_Line${n}`),
      vatRate: (() => { const r = parseNumberInput(cfValue(doc, [`VAT_Line${n}`])); return r === INVALID ? null : r; })(),
    };
    if (Object.values(line).some((v) => v != null && v !== '')) lines.push(line);
  }
  return {
    source: 'paperless',
    invoiceNumber: cfValue(doc, ['Invoice Number']),
    invoiceDate: isoDate(cfDate(doc, 'Invoice Date')),
    dueDate: isoDate(cfDate(doc, 'Invoice Due Date')),
    totalGoods: cfMoney(doc, 'Total Goods'),
    totalVat: cfMoney(doc, 'Total VAT'),
    invoiceTotal: cfMoney(doc, 'Invoice Total'),
    lines,
  };
}

// ── Actions ──────────────────────────────────────────────────────────

const storedActor = (actor) => (actor ? { userId: actor.userId ?? null, name: actor.name ?? null } : null);

const defaultDeps = () => ({
  modifyTags: (id, changes) => modifyPaperlessDocumentTags(id, changes),
  setFields: (id, pairs) => __paperlessClient.makeClient().setDocumentCustomFields([id], pairs),
  // H6: in shadow mode this only records what would be sent
  notify: (kind, id, opts) => notifySafely(kind, id, opts),
});

/**
 * Give a document its first state if it has none yet, so the entry screen
 * works on documents that arrived before the H3 webhook.
 */
export async function ensureClassified(OcrDocument, paperlessId) {
  return classifyDocument(OcrDocument, paperlessId);
}

const ENTRY_FIELD_LABELS = {
  invoiceNumber: 'invoice number', invoiceDate: 'invoice date', dueDate: 'due date',
  totalGoods: 'total goods', totalVat: 'total VAT', invoiceTotal: 'invoice total',
  labour: 'labour', materials: 'materials',
};
const BANK_FIELD_LABELS = {
  accountId: 'bank account', periodStart: 'period start', periodEnd: 'period end',
  openingBalance: 'opening balance', closingBalance: 'closing balance',
};
const sameValue = (a, b) => {
  const norm = (v) => (v instanceof Date ? v.getTime() : v == null ? null : v);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
};

/**
 * What a save changed, in words, for the audit log: ["invoice number", "line 2",
 * "line 3 removed"]. Pure. An empty list means nothing changed.
 */
export function entryChanges(before, after) {
  const changed = [];
  const b = before || {};
  const a = after || {};
  const labels = a.bank || b.bank ? BANK_FIELD_LABELS : ENTRY_FIELD_LABELS;
  const bFields = labels === BANK_FIELD_LABELS ? (b.bank || {}) : b;
  const aFields = labels === BANK_FIELD_LABELS ? (a.bank || {}) : a;
  for (const [key, label] of Object.entries(labels)) {
    if (!sameValue(bFields[key], aFields[key])) changed.push(label);
  }
  const bLines = b.lines || [];
  const aLines = a.lines || [];
  const n = Math.max(bLines.length, aLines.length);
  for (let i = 0; i < n; i++) {
    const was = bLines[i];
    const is = aLines[i];
    if (was && !is) changed.push(`line ${i + 1} removed`);
    else if (!was && is) changed.push(`line ${i + 1} added`);
    else if (!sameValue(was, is)) changed.push(`line ${i + 1}`);
  }
  return changed;
}

/** Save the entry. Refused once the invoice is in KashFlow. Each save that changes something is in processingHistory. */
export async function saveEntry(OcrDocument, paperlessId, entry, actor, { now = new Date() } = {}) {
  const doc = await OcrDocument.findOne({ paperlessId }).select('documentType processingState entry').lean();
  if (!doc) return { ok: false, reason: 'not-found', message: 'Document not found.' };
  if (!entryKind(doc) || entryKind(doc) === 'statement') {
    return { ok: false, reason: 'no-form', message: 'This type of document has no fields to enter.' };
  }
  if (doc.processingState === 'sent') {
    return { ok: false, reason: 'locked', message: 'This invoice is already in KashFlow. Unlink it before changing what was entered.' };
  }
  const changed = entryChanges(doc.entry?.savedAt ? doc.entry : null, entry);
  const update = { $set: { entry: { ...entry, savedAt: now, savedBy: storedActor(actor) } } };
  if (changed.length) {
    const note = doc.entry?.savedAt ? `Changed ${changed.join(', ')}` : `First save: ${changed.join(', ')}`;
    update.$push = { processingHistory: { field: 'entry', from: null, to: null, action: 'save_entry', at: now, by: storedActor(actor), note } };
  }
  const updated = await OcrDocument.findOneAndUpdate(
    { paperlessId, processingState: { $ne: 'sent' } },
    update,
    { new: true },
  ).lean();
  if (!updated) return { ok: false, reason: 'conflict', message: 'The document changed while you were working on it. Reload and try again.' };
  return { ok: true, doc: updated };
}

// ── Audit log ─────────────────────────────────────────────────────────

const STATE_WORDS = {
  null: 'no state', awaiting_entry: 'Needs data entry', entered: 'Ready for KashFlow', sent: 'In KashFlow', manual_kashflow: 'Credit note, keyed by hand',
};
const EXCLUDED_WORDS = { null: 'in its queue', original_multiple: 'original of several invoices', manually_added: 'keyed into KashFlow by hand', not_for_kashflow: 'not for KashFlow' };
const ACTION_WORDS = {
  initialise: 'Classified', complete_entry: 'Entry completed', mark_sent: 'Sent to KashFlow', unlink: 'Unlinked from KashFlow',
  unlink_unentered: 'Unlinked from KashFlow', reopen_entry: 'Entry reopened', flag_credit_note: 'Marked as a credit note',
  unflag_credit_note: 'Credit note flag removed', backfill: 'Backfilled from Paperless', follow_paperless: 'Followed a Paperless change',
  mark_reviewed: 'Marked reviewed', set_excluded: 'Queue exclusion changed', save_entry: 'Entry saved', change_type: 'Type changed',
};
const NOTIFICATION_WORDS = {
  new_doc: 'New document posted', invoice: 'Invoice emailed', invoice_resend: 'Invoice email re-sent', kashflow: 'Added to KashFlow posted',
  statement: 'Statement emailed', credit_note: 'Credit note emailed',
};
const word = (table, v) => table[v == null ? 'null' : v] ?? String(v);

/**
 * Everything that happened to a document, newest first, for the admin Audit
 * log tab: state and flag changes, entry saves, server readings, type checks
 * and notifications. Pure. Each row is { at, who, what, detail, kind }.
 */
export function auditTimeline(doc, notifications = []) {
  const rows = [];
  const whoOf = (by) => by?.name || (by === undefined ? '' : 'system');
  for (const h of doc?.processingHistory || []) {
    let detail = h.note || '';
    if (h.field === 'processingState') detail = `${word(STATE_WORDS, h.from)} → ${word(STATE_WORDS, h.to)}${h.note ? `. ${h.note}` : ''}`;
    else if (h.field === 'excludedReason') detail = `${word(EXCLUDED_WORDS, h.from)} → ${word(EXCLUDED_WORDS, h.to)}${h.note ? `. ${h.note}` : ''}`;
    else if (h.field === 'statementReviewed') detail = h.to ? 'Reviewed' : 'Not reviewed';
    else if (h.field === 'creditNote') detail = h.to ? 'Credit note' : 'Not a credit note';
    else if (h.field === 'documentType') detail = `${h.from?.name ?? h.from ?? '—'} → ${h.to?.name ?? h.to ?? '—'}`;
    rows.push({ at: h.at, who: whoOf(h.by), what: ACTION_WORDS[h.action] || h.action || h.field, detail, kind: h.field === 'entry' ? 'entry' : 'state' });
  }
  if (doc?.reading?.at) {
    rows.push({
      at: doc.reading.at, who: 'hcs-app', what: doc.reading.error ? "Couldn't read the PDF" : 'Read from the PDF',
      detail: doc.reading.error || (doc.reading.hasText === false ? 'No text in the PDF' : `${doc.reading.usedLayout ? "Using this supplier's layout, " : ''}found ${doc.reading.score ?? 0} of 3 header fields${doc.reading.lineCount ? `, ${doc.reading.lineCount} lines` : ''}`),
      kind: 'read',
    });
  }
  if (doc?.statement?.at) {
    rows.push({ at: doc.statement.at, who: 'hcs-app', what: 'Set against KashFlow', detail: doc.statement.error || doc.statement.summaryText || '', kind: 'read' });
  }
  if (doc?.typeCheck?.confirmed?.at) {
    rows.push({ at: doc.typeCheck.confirmed.at, who: whoOf(doc.typeCheck.confirmed.by), what: 'Type confirmed', detail: doc.typeCheck.confirmed.code || '', kind: 'state' });
  }
  for (const n of notifications || []) {
    const failed = (n.channels || []).filter((c) => c.status === 'failed').map((c) => `${c.channel}: ${c.error}`);
    const status = { shadow: 'would send', recorded: 'recorded from Paperless', sent: 'sent', failed: 'failed', claimed: 'sending' }[n.status] || n.status || '';
    const who = n.triggeredBy?.name || (n.source === 'paperless' ? 'Paperless' : n.source === 'backfill' ? 'backfill' : 'hcs-app');
    rows.push({ at: n.createdAt, who, what: NOTIFICATION_WORDS[n.kind] || n.kind, detail: [status, ...failed].filter(Boolean).join('; '), kind: 'notify' });
  }
  return rows
    .filter((r) => r.at)
    .sort((a, b) => new Date(b.at) - new Date(a.at));
}

async function tellPaperless(label, fn, manual) {
  try {
    await fn();
    return null;
  } catch (err) {
    logger.warn(`[documentEntry] ${label} failed: ${err.message}`);
    return `Saved in hcs-app, but Paperless couldn't be updated. ${manual}`;
  }
}

/** Complete entry (PB-5): requires the core fields, then tags Paperless. */
export async function completeEntry(OcrDocument, paperlessId, actor, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const doc = await OcrDocument.findOne({ paperlessId }).select('documentType processingState excludedReason entry').lean();
  if (!doc) return { ok: false, reason: 'not-found', message: 'Document not found.' };
  const excluded = notForEntryMessage(doc);
  if (excluded) return { ok: false, reason: 'excluded', message: excluded };
  const errors = completionErrors(doc.entry?.savedAt ? doc.entry : null);
  if (Object.keys(errors).length) {
    return { ok: false, reason: 'incomplete', errors, message: Object.values(errors).join(' ') };
  }
  const res = await transition(OcrDocument, paperlessId, 'complete_entry', actor);
  if (!res.ok) return res;
  const paperlessWarning = await tellPaperless(
    `Adding "data entry done" to ${paperlessId}`,
    () => d.modifyTags(paperlessId, { add: ['dataEntryDone'] }),
    'Add the "data entry done" tag in Paperless so the invoice email is sent.',
  );
  const notification = await d.notify('invoice', paperlessId, { actor });
  return { ...res, paperlessWarning, notification };
}

/** Credit Note checkbox (PB-9, PB-12). Unticking is admin-only. */
export async function setCreditNote(OcrDocument, paperlessId, flag, actor, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const res = await transition(OcrDocument, paperlessId, flag ? 'flag_credit_note' : 'unflag_credit_note', actor);
  if (!res.ok) return res;
  const paperlessWarning = await tellPaperless(
    `Setting Credit Note=${flag} on ${paperlessId}`,
    () => d.setFields(paperlessId, { 'Credit Note': flag ? 'true' : 'false' }),
    flag ? 'Tick Credit Note in Paperless so the credit note email is sent.' : 'Untick Credit Note in Paperless.',
  );
  // One-shot: unflagging and flagging again does not send the credit note email twice
  const notification = flag ? await d.notify('credit_note', paperlessId, { actor }) : null;
  return { ...res, paperlessWarning, notification };
}

export const NOT_FOR_KASHFLOW_NOTE_MAX = 300;

/**
 * Not for KashFlow: a real invoice that must never be entered, e.g. one paid
 * with store credit from a refund, so the two net to nothing (#252/#253). It
 * leaves both queues, keeps its reason, and is tagged "not for kashflow" in
 * Paperless. Undoing it is admin-only and puts it back where it was.
 * @param {{flag: boolean, note?: string}} change
 */
export async function setNotForKashflow(OcrDocument, paperlessId, { flag, note = '' }, actor, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const doc = await OcrDocument.findOne({ paperlessId })
    .select('documentType processingState excludedReason excludedNote creditNote deletedInPaperlessAt').lean();
  if (!doc) return { ok: false, reason: 'not-found', message: 'Document not found.' };

  if (flag) {
    const reason = String(note || '').replace(/\s+/g, ' ').trim();
    if (!isInvoiceDocument(doc)) return { ok: false, reason: 'not-invoice', message: 'Only invoices can be marked not for KashFlow.' };
    if (doc.processingState === 'sent') {
      return { ok: false, reason: 'sent', message: "It's linked to a KashFlow purchase. Unlink it first." };
    }
    if (!['awaiting_entry', 'entered'].includes(doc.processingState) || doc.creditNote) {
      return { ok: false, reason: 'state', message: 'Only an invoice waiting for entry or to be sent can be marked not for KashFlow.' };
    }
    if (doc.excludedReason) return { ok: false, reason: 'excluded', message: notForEntryMessage(doc) };
    if (reason.length < 3) return { ok: false, reason: 'no-note', message: "Say why it isn't for KashFlow, so it makes sense later." };
    if (reason.length > NOT_FOR_KASHFLOW_NOTE_MAX) {
      return { ok: false, reason: 'long-note', message: `Keep the reason under ${NOT_FOR_KASHFLOW_NOTE_MAX} characters.` };
    }
    const res = await setExcludedReason(OcrDocument, paperlessId, 'not_for_kashflow', actor, { note: reason, excludedNote: reason });
    if (!res.ok) return res;
    const paperlessWarning = await tellPaperless(
      `Adding "not for kashflow" to ${paperlessId}`,
      () => d.modifyTags(paperlessId, { add: ['notForKashflow'] }),
      'Add the "not for kashflow" tag in Paperless.',
    );
    return { ...res, paperlessWarning };
  }

  if (doc.excludedReason !== 'not_for_kashflow') {
    return { ok: false, reason: 'not-marked', message: "It isn't marked not for KashFlow." };
  }
  const res = await setExcludedReason(OcrDocument, paperlessId, null, actor, { note: 'No longer not for KashFlow' });
  if (!res.ok) return res;
  // Or following Paperless's tags would mark it again
  const paperlessWarning = await tellPaperless(
    `Removing "not for kashflow" from ${paperlessId}`,
    () => d.modifyTags(paperlessId, { remove: ['notForKashflow'] }),
    'Remove the "not for kashflow" tag in Paperless, or it will be marked again.',
  );
  return { ...res, paperlessWarning };
}

/** Reopen entry (admin): back to Needs Data Entry, and untag Paperless. */
export async function reopenEntry(OcrDocument, paperlessId, actor, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const res = await transition(OcrDocument, paperlessId, 'reopen_entry', actor);
  if (!res.ok) return res;
  const paperlessWarning = await tellPaperless(
    `Removing "data entry done" from ${paperlessId}`,
    () => d.modifyTags(paperlessId, { remove: ['dataEntryDone'] }),
    'Remove the "data entry done" tag in Paperless.',
  );
  return { ...res, paperlessWarning };
}

/**
 * Resend the invoice email (PB-6): always sends and is logged every time.
 * Until cutover it also adds the `notify` tag, so Paperless (WF9) does the sending.
 */
export async function resendInvoice(OcrDocument, paperlessId, actor, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const doc = await OcrDocument.findOne({ paperlessId }).select('documentType').lean();
  if (!doc) return { ok: false, reason: 'not-found', message: 'Document not found.' };
  if (!isDocumentType(doc.documentType, 'purchaseInvoice')) {
    return { ok: false, reason: 'not-applicable', message: 'Only purchase invoices have an invoice email.' };
  }
  const paperlessWarning = await tellPaperless(
    `Adding "notify" to ${paperlessId}`,
    () => d.modifyTags(paperlessId, { add: ['notify'] }),
    'Add the "notify" tag in Paperless to re-send it.',
  );
  const notification = await d.notify('invoice_resend', paperlessId, { actor });
  return { ok: true, paperlessWarning, notification };
}

/**
 * Mark a supplier statement reviewed (PB-10). The first time sends the
 * statement email. Paperless isn't told: its WF2 already sends it on the first save there,
 * and adding tag 21 from here would stop that email before cutover.
 */
export async function markReviewed(OcrDocument, paperlessId, actor, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  // What the reviewer saw against KashFlow goes into the history with the mark
  const current = await OcrDocument.findOne({ paperlessId }).select('statement.summaryText statement.at').lean();
  const note = reviewNote(current?.statement);
  const res = await markStatementReviewed(OcrDocument, paperlessId, actor, { note });
  if (!res.ok) return res;
  const notification = res.firstTime ? await d.notify('statement', paperlessId, { actor }) : null;
  return { ...res, notification };
}

/** The history note for a mark reviewed: how the statement stood against KashFlow at the time. */
export function reviewNote(statement) {
  if (!statement?.summaryText) return null;
  const when = statement.at ? ` (checked ${new Date(statement.at).toISOString().slice(0, 10)})` : '';
  return `Against KashFlow: ${statement.summaryText}${when}`;
}

/**
 * After a successful KashFlow send (D2): move the invoice to `sent`, via
 * `entered` if it was sent straight from the draft screen, and fire the
 * "added to kashflow" post (PB-8). Never throws: the purchase already exists.
 */
/**
 * Documents linked to a KashFlow purchase but not marked as sent, moved to In
 * KashFlow. Two ways in: from 6.47.0 until 6.53.1 a send created the purchase
 * and linked it, then failed before moving the document on; and Match Purchase
 * (and the other ways of linking an existing purchase) link without sending, so
 * the invoice stayed in Ready for KashFlow (#1139). Idempotent; sends no
 * notifications, since the purchase is already in KashFlow.
 * @param {{paperlessIds?: number[]}} [opts]  only these documents
 * @returns {Promise<{repaired: number[]}>}
 */
export async function repairUnmarkedSends(OcrDocument, { paperlessIds = null } = {}) {
  const docs = await OcrDocument.find({
    ...__kfSendClaim.LINKED_QUERY,
    processingState: { $in: ['awaiting_entry', 'entered'] },
    deletedInPaperlessAt: null,
    ...(paperlessIds ? { paperlessId: { $in: paperlessIds } } : {}),
  }).select('paperlessId processingState kashflowPurchaseId').lean();
  const repaired = [];
  const note = 'Already in KashFlow (linked to a purchase), so marked as sent';
  for (const doc of docs) {
    try {
      if (doc.processingState === 'awaiting_entry') {
        await transition(OcrDocument, doc.paperlessId, 'complete_entry', null, { note });
      }
      const r = await transition(OcrDocument, doc.paperlessId, 'mark_sent', null, { note });
      if (r.ok) repaired.push(doc.paperlessId);
    } catch (err) {
      logger.warn(`[documentEntry] Repairing the KashFlow send for ${doc.paperlessId} failed: ${err.message}`);
    }
  }
  if (repaired.length) logger.info(`[documentEntry] Marked ${repaired.length} document(s) as in KashFlow that had been sent but not recorded: ${repaired.join(', ')}`);
  return { repaired };
}

export async function recordSentToKashflow(OcrDocument, paperlessId, actor, { note = null, ...deps } = {}) {
  const d = { ...defaultDeps(), ...deps };
  try {
    const doc = await OcrDocument.findOne({ paperlessId }).select('documentType processingState').lean();
    if (doc?.processingState === 'awaiting_entry') {
      await transition(OcrDocument, paperlessId, 'complete_entry', actor, { note: 'Sent to KashFlow from the draft screen' });
    }
    const after = await OcrDocument.findOne({ paperlessId }).select('processingState').lean();
    if (after?.processingState === 'entered') {
      // e.g. that the lines were sent although they don't add up to the invoice
      await transition(OcrDocument, paperlessId, 'mark_sent', actor, note ? { note } : {});
    }
  } catch (err) {
    logger.warn(`[documentEntry] Recording the KashFlow send for ${paperlessId} failed: ${err.message}`);
  }
  return d.notify('kashflow', paperlessId, { actor });
}

/** After a KashFlow link is cleared (unlink or orphan clean-up): sent → entered. */
export async function recordUnlinked(OcrDocument, paperlessId, actor, { note = null } = {}) {
  try {
    const doc = await OcrDocument.findOne({ paperlessId }).select('processingState entry.savedAt').lean();
    if (doc?.processingState !== 'sent') return { ok: false, reason: 'not-sent' };
    // Nothing was ever entered (e.g. a split-out invoice that inherited its
    // original's link): it needs entering, not sending
    const action = doc.entry?.savedAt ? 'unlink' : 'unlink_unentered';
    return await transition(OcrDocument, paperlessId, action, actor, { note });
  } catch (err) {
    logger.warn(`[documentEntry] Recording the unlink for ${paperlessId} failed: ${err.message}`);
    return { ok: false, reason: 'error' };
  }
}

export default {
  parseMoneyInput,
  parseDateInput,
  entryKind,
  isSubcontractorEntry,
  lineRole,
  parseEntryForm,
  completionErrors,
  cisDeduction,
  vatCase,
  consistencyWarnings,
  formValues,
  entryAsCustomFields,
  ensureClassified,
  entryChanges,
  auditTimeline,
  saveEntry,
  completeEntry,
  setCreditNote,
  setNotForKashflow,
  NOT_FOR_KASHFLOW_NOTE_MAX,
  reopenEntry,
  resendInvoice,
  markReviewed,
  reviewNote,
  recordSentToKashflow,
  repairUnmarkedSends,
  recordUnlinked,
};
