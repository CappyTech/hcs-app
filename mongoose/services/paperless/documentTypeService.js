/**
 * documentTypeService.js — change a document's type from hcs-app.
 *
 * The type is Paperless's, so it is set there (PATCH document_type) and then
 * the cached copy is refreshed. hcs-app's own state follows the new type:
 *
 *   invoice → invoice (Purchase ↔ Subcontractor)   state kept
 *   anything else                                  state cleared, then the
 *                                                  document is classified again
 *                                                  as if it had just arrived
 *
 * So a statement that came in as a Purchase Invoice leaves Needs Data Entry
 * for Statements to Review, and an untyped upload typed as an invoice joins
 * Needs Data Entry. An invoice already in KashFlow can't change type; it has
 * to be unlinked first. Every change is in processingHistory.
 */

import __paperlessClient from './paperlessClient.js';
import __grabServicePaperless from '../grabServicePaperless.js';
import { PAPERLESS_DOCUMENT_TYPES } from '../../config/paperlessTypesConfig.js';
import { isInvoiceDocument } from './documentStateService.js';
import { classifyDocument } from './documentIngestService.js';
import { readSoon } from './documentReadingService.js';
import { refreshTypeCheck } from './documentTypeCheck.js';
import logger from '../../../services/loggerService.js';

const defaultDeps = () => ({
  api: __paperlessClient.makeClient(),
  ingestOne: (id) => __grabServicePaperless.ingestOnePaperlessDoc(id),
  readSoon,
});

const TYPES_TTL_MS = 10 * 60 * 1000;
let typesCache = null; // { at, types }

const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/** The types hcs-app knows by itself, for when Paperless can't be reached. */
export function fallbackTypes() {
  return Object.values(PAPERLESS_DOCUMENT_TYPES)
    .map((t) => ({ id: t.id, name: titleCase(t.names.at(-1)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Every Paperless document type as { id, name }, cached for ten minutes. */
export async function documentTypeOptions(deps = {}, { now = Date.now() } = {}) {
  if (!deps.api && typesCache && now - typesCache.at < TYPES_TTL_MS) return typesCache.types;
  const api = deps.api ?? __paperlessClient.makeClient();
  try {
    const types = (await api.listDocumentTypes()).map((t) => ({ id: Number(t.id), name: t.name }));
    if (!deps.api) typesCache = { at: now, types };
    return types;
  } catch (err) {
    logger.warn(`[documentType] Couldn't list Paperless document types: ${err.message}`);
    return typesCache?.types ?? fallbackTypes();
  }
}

/** Forget the cached type list (tests). */
export function clearTypeCache() {
  typesCache = null;
}

/**
 * Set `paperlessId`'s type to `typeId` in Paperless and move it to the right queue.
 * @returns {Promise<{ok: true, changed: boolean, from?, to?, state?} | {ok: false, reason, message}>}
 */
export async function changeDocumentType(OcrDocument, paperlessId, typeId, actor, deps = {}, { now = new Date() } = {}) {
  const d = { ...defaultDeps(), ...deps };
  const doc = await OcrDocument.findOne({ paperlessId })
    .select('paperlessId documentType processingState kashflowPurchaseId kashflowPurchaseNumber deletedInPaperlessAt')
    .lean();
  if (!doc) return { ok: false, reason: 'not-found', message: 'Document not found.' };
  if (doc.deletedInPaperlessAt) return { ok: false, reason: 'deleted', message: 'It has been deleted in Paperless.' };
  if (doc.processingState === 'sent' || doc.kashflowPurchaseId) {
    const num = doc.kashflowPurchaseNumber ? ` as purchase #${doc.kashflowPurchaseNumber}` : '';
    return { ok: false, reason: 'in-kashflow', message: `It's in KashFlow${num}. Unlink it from KashFlow before changing its type.` };
  }
  const types = await documentTypeOptions(deps.api ? { api: d.api } : {});
  const target = types.find((t) => t.id === Number(typeId));
  if (!target) return { ok: false, reason: 'invalid-type', message: 'Choose a document type from the list.' };
  if (doc.documentType?.id === target.id) return { ok: true, changed: false, to: target.name };

  await d.api.updateDocumentType(paperlessId, target.id);
  // Refresh the cached copy (title, tags, fields) as Paperless now has it
  await Promise.resolve(d.ingestOne(paperlessId)).catch((err) => {
    logger.warn(`[documentType] Refreshing ${paperlessId} after the type change failed: ${err.message}`);
  });

  const from = doc.documentType?.name ?? null;
  const keepsState = isInvoiceDocument(doc) && isInvoiceDocument({ documentType: target });
  const by = actor ? { userId: actor.userId ?? null, name: actor.name ?? null } : null;
  const $set = { documentType: { id: target.id, name: target.name }, 'typeCheck.confirmed': null };
  const history = [{ field: 'documentType', from, to: target.name, action: 'change_type', at: now, by, note: null }];
  if (!keepsState) {
    if (doc.processingState) {
      history.push({ field: 'processingState', from: doc.processingState, to: null, action: 'change_type', at: now, by, note: `Type changed to ${target.name}` });
    }
    Object.assign($set, { processingState: null, processingStateChanged: { at: now, by }, classifiedAt: null });
  }
  await OcrDocument.findOneAndUpdate({ paperlessId }, { $set, $push: { processingHistory: { $each: history } } }).lean();
  if (!keepsState) await classifyDocument(OcrDocument, paperlessId, { now });
  await refreshTypeCheck(OcrDocument, paperlessId, { now });

  const after = await OcrDocument.findOne({ paperlessId }).select('processingState').lean();
  const state = after?.processingState ?? null;
  if (state === 'awaiting_entry') Promise.resolve(d.readSoon(paperlessId)).catch(() => {});
  logger.info(`[documentType] ${paperlessId}: ${from || 'no type'} → ${target.name} by ${by?.name || 'system'} (state ${doc.processingState || 'none'} → ${state || 'none'})`);
  return { ok: true, changed: true, from, to: target.name, state };
}

export default { documentTypeOptions, fallbackTypes, clearTypeCache, changeDocumentType };
