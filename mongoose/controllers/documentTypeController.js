/**
 * documentTypeController.js — change a document's type, or say it is right,
 * without going into Paperless.
 *
 *   POST /paperless/ocr/:paperlessId/type            documentType=<id>, back=entry|details|check-type
 *   POST /paperless/ocr/:paperlessId/type-confirmed  back=…
 */

import mdb from '../services/mongooseDatabaseService.js';
import { actorFromUser } from '../services/paperless/documentStateService.js';
import typeSvc from '../services/paperless/documentTypeService.js';
import typeCheck from '../services/paperless/documentTypeCheck.js';
import logger from '../../services/loggerService.js';

const idParam = (req) => {
  const n = Number(req.params.paperlessId);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Where to go afterwards: only the pages that offer these actions. */
export function backUrl(back, paperlessId) {
  if (back === 'details') return `/paperless/ocr/${paperlessId}`;
  if (back === 'check-type') return '/paperless/queues/check-type';
  return `/paperless/ocr/${paperlessId}/entry`;
}

const QUEUE_NAMES = { awaiting_entry: 'Needs Data Entry', entered: 'Ready for KashFlow', manual_kashflow: 'the credit notes (keyed into KashFlow by hand)' };

/** What the person is told after a change. */
export function changedMessage(r) {
  const where = r.state ? ` It's in ${QUEUE_NAMES[r.state] || r.state}.`
    : /supplier\s*statement/i.test(r.to) ? " It's in Statements to Review." : '';
  return `Type changed${r.from ? ` from ${r.from}` : ''} to ${r.to}.${where}`;
}

export const postType = async (req, res, next) => {
  const id = idParam(req);
  if (!id) return res.redirect('/paperless/queues/check-type');
  const back = backUrl(req.body?.back, id);
  try {
    await mdb.connect();
    const r = await typeSvc.changeDocumentType(mdb.PAPERLESS.OcrDocument, id, req.body?.documentType, actorFromUser(req.user));
    if (!r.ok) req.flash('error', r.message);
    else req.flash('success', r.changed ? changedMessage(r) : `It's already a ${r.to}.`);
    return res.redirect(back);
  } catch (err) {
    logger.error(`[documentType] POST type ${req.params.paperlessId}: ${err.message}`);
    req.flash('error', `Couldn't change the type in Paperless: ${err.message}`);
    return res.redirect(back);
  }
};

export const postTypeConfirmed = async (req, res, next) => {
  const id = idParam(req);
  if (!id) return res.redirect('/paperless/queues/check-type');
  try {
    await mdb.connect();
    const r = await typeCheck.confirmType(mdb.PAPERLESS.OcrDocument, id, actorFromUser(req.user));
    if (!r.ok) req.flash('error', r.message);
    else if (r.changed) req.flash('success', 'Marked the type as right. It has left Check the type.');
    return res.redirect(backUrl(req.body?.back, id));
  } catch (err) {
    logger.error(`[documentType] POST type-confirmed ${req.params.paperlessId}: ${err.message}`);
    next(err);
  }
};

export default { postType, postTypeConfirmed, backUrl, changedMessage };
