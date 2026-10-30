/**
 * documentSupplierService.js — set a document's KashFlow supplier from the
 * entry screen.
 *
 * The supplier is held in Paperless as the document's correspondent, named
 * "<Name> (<Code>)" (correspondentName.js), so choosing one here:
 *
 *   1. finds that supplier's correspondent by its code, or
 *   2. renames the one hand-made correspondent with exactly the supplier's
 *      name to carry the code (more than one: leave them, make a new one), or
 *   3. creates it,
 *
 * then sets it on the document in Paperless and on hcs-app's copy, with a
 * processingHistory row. An invoice already in KashFlow keeps its supplier;
 * it has to be unlinked first.
 */
import __paperlessClient from './paperlessClient.js';
import { correspondentLabel, parseCorrespondentName } from './correspondentName.js';
import logger from '../../../services/loggerService.js';

const MATCH_AUTO = 6;
const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

async function allCorrespondents(api) {
  const out = [];
  for (let page = 1; ; page += 1) {
    const chunk = await api.listCorrespondents({ page, pageSize: 100, ordering: 'name' });
    const results = Array.isArray(chunk?.results) ? chunk.results : [];
    out.push(...results.filter((c) => c?.name));
    if (!chunk?.next || !results.length) break;
  }
  return out;
}

/** The supplier's correspondent in Paperless, made to carry its code. */
export async function correspondentForSupplier(api, supplier) {
  const label = correspondentLabel(supplier);
  const all = await allCorrespondents(api);
  const coded = all.find((c) => parseCorrespondentName(c.name).code?.toLowerCase() === String(supplier.Code).toLowerCase());
  if (coded) {
    if (coded.name === label) return { id: coded.id, name: label, how: 'existing' };
    await api.updateCorrespondent(coded.id, { name: label });
    return { id: coded.id, name: label, how: 'renamed', from: coded.name };
  }
  const handMade = all.filter((c) => !parseCorrespondentName(c.name).code && norm(c.name) === norm(supplier.Name));
  if (handMade.length === 1) {
    await api.updateCorrespondent(handMade[0].id, { name: label });
    return { id: handMade[0].id, name: label, how: 'renamed', from: handMade[0].name };
  }
  const made = await api.createCorrespondent({ name: label, matchingAlgorithm: MATCH_AUTO });
  return { id: made.id, name: label, how: 'created' };
}

/**
 * Set `paperlessId`'s supplier to the KashFlow supplier with `code`.
 * @returns {Promise<{ok: true, changed: boolean, from?, to, how?} | {ok: false, reason, message}>}
 */
export async function assignSupplier({ OcrDocument, Supplier }, paperlessId, code, actor, deps = {}, { now = new Date() } = {}) {
  const api = deps.api ?? __paperlessClient.makeClient();
  const wanted = String(code || '').trim();
  const doc = await OcrDocument.findOne({ paperlessId })
    .select('paperlessId correspondent processingState kashflowPurchaseId kashflowPurchaseNumber deletedInPaperlessAt')
    .lean();
  if (!doc) return { ok: false, reason: 'not-found', message: 'Document not found.' };
  if (doc.deletedInPaperlessAt) return { ok: false, reason: 'deleted', message: 'It has been deleted in Paperless.' };
  if (doc.processingState === 'sent' || doc.kashflowPurchaseId) {
    const num = doc.kashflowPurchaseNumber ? ` as purchase #${doc.kashflowPurchaseNumber}` : '';
    return { ok: false, reason: 'in-kashflow', message: `It's in KashFlow${num}. Unlink it from KashFlow before changing its supplier.` };
  }
  const supplier = wanted && Supplier
    ? await Supplier.findOne({ Code: wanted, IsArchived: { $ne: true } }).select('Code Name').lean()
    : null;
  if (!supplier) return { ok: false, reason: 'invalid-supplier', message: 'Choose a KashFlow supplier from the list.' };

  const label = correspondentLabel(supplier);
  if (doc.correspondent?.name === label) return { ok: true, changed: false, to: label };

  const corr = await correspondentForSupplier(api, supplier);
  await api.updateDocumentCorrespondent(paperlessId, corr.id);

  const from = doc.correspondent?.name ?? null;
  const by = actor ? { userId: actor.userId ?? null, name: actor.name ?? null } : null;
  await OcrDocument.findOneAndUpdate({ paperlessId }, {
    $set: { correspondent: { id: corr.id, name: corr.name } },
    $push: { processingHistory: { field: 'correspondent', from, to: corr.name, action: 'set_supplier', at: now, by, note: corr.how === 'existing' ? null : `Correspondent ${corr.how}${corr.from ? ` from "${corr.from}"` : ''}` } },
  }).lean();
  // Other documents filed against a renamed correspondent show the new name too
  if (corr.how === 'renamed') {
    await OcrDocument.updateMany({ 'correspondent.id': corr.id }, { $set: { 'correspondent.name': corr.name } });
  }
  logger.info(`[documentSupplier] ${paperlessId}: ${from || 'no supplier'} → ${corr.name} (${corr.how}) by ${by?.name || 'system'}`);
  return { ok: true, changed: true, from, to: corr.name, how: corr.how };
}

/** Active KashFlow suppliers for the picker, as "<Name> (<Code>)". */
export async function supplierOptions(Supplier) {
  if (!Supplier) return [];
  const rows = await Supplier.find({ IsArchived: { $ne: true }, Name: { $nin: [null, ''] }, Code: { $nin: [null, ''] } })
    .select('Code Name').sort({ Name: 1 }).lean();
  return rows.map((s) => ({ code: s.Code, label: correspondentLabel(s) }));
}

export default { assignSupplier, correspondentForSupplier, supplierOptions };
