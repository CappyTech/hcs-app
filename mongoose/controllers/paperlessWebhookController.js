/**
 * paperlessWebhookController.js — POST /api/paperless/webhook (Paperless
 * migration H3).
 *
 * Called by a Paperless "Document added" workflow with a webhook action. It
 * has no browser session, so it is public to ensureAuthenticated and exempt
 * from CSRF; it authenticates with the shared secret PAPERLESS_WEBHOOK_SECRET,
 * sent as `Authorization: Bearer <secret>` or `X-Webhook-Secret: <secret>`.
 * With no secret configured the endpoint is off and answers 503.
 *
 * The body must identify the document: `doc_url` (the `{{doc_url}}`
 * placeholder) is enough, or `doc_id`. Repeated deliveries are harmless.
 */

import crypto from 'crypto';
import __documentIngestService from '../services/paperless/documentIngestService.js';
import logger from '../../services/loggerService.js';

function secretsMatch(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string' || !supplied || !expected) return false;
  // Hash both sides so timingSafeEqual gets equal-length buffers.
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function suppliedSecret(req) {
  const auth = req.get?.('authorization') || req.headers?.authorization || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer) return bearer[1].trim();
  return (req.get?.('x-webhook-secret') || req.headers?.['x-webhook-secret'] || '').trim();
}

/** Build the handler. `deps` exists for tests. */
export function makeDocumentAddedHandler(deps = {}) {
  const getSecret = deps.getSecret ?? (() => process.env.PAPERLESS_WEBHOOK_SECRET || '');
  const handle = deps.handleDocumentAdded ?? __documentIngestService.handleDocumentAdded;
  const parseId = deps.parseWebhookDocumentId ?? __documentIngestService.parseWebhookDocumentId;

  return async function documentAdded(req, res) {
    const secret = getSecret();
    if (!secret) {
      return res.status(503).json({ ok: false, error: 'Paperless webhook is not configured.' });
    }
    if (!secretsMatch(suppliedSecret(req), secret)) {
      logger.warn('[paperless-webhook] Rejected a request with a missing or wrong secret.');
      return res.status(401).json({ ok: false, error: 'Unauthorised.' });
    }

    const paperlessId = parseId(req.body) ?? parseId(req.query);
    if (!paperlessId) {
      return res.status(400).json({ ok: false, error: 'No document id in the request body (send doc_url or doc_id).' });
    }

    try {
      const result = await handle(paperlessId);
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      const status = err?.status === 404 ? 404 : 502;
      logger.warn(`[paperless-webhook] Ingest failed for paperlessId=${paperlessId}: ${err.message}`);
      // 502 lets Paperless retry; the reconciliation job is the backstop either way.
      return res.status(status).json({ ok: false, paperlessId, error: status === 404 ? 'Document not found in Paperless.' : 'Ingest failed.' });
    }
  };
}

export const documentAdded = makeDocumentAddedHandler();

export default { documentAdded, makeDocumentAddedHandler };
