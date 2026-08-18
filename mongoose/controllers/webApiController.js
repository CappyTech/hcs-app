/**
 * The read-only content API that hcs-web pulls from.
 *
 * hcs-web keeps a durable mirror of what this returns and serves heroncs.co.uk
 * from that copy, so this endpoint being unreachable slows publishing down —
 * it never takes the public site off the air. Nothing here should acquire a
 * behaviour that assumes the consumer is live at the moment of a change.
 *
 * There is no write surface at all, by design. Publishing happens in the editor
 * at /website, behind a session and an audit trail; if a POST ever appears here
 * it needs CSRF handling that this router deliberately does not have.
 */
import crypto from 'crypto';
import mdb from '../services/mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';
import { buildPayload, payloadEtag } from '../../services/webContentService.js';

/** Timing-safe compare over hashes, so lengths never leak. */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Bearer-token guard.
 *
 * The content behind it is public by definition — it is the company website.
 * The token is not confidentiality, it is a throttle: without it this endpoint
 * is an open invitation to scrape a residential connection through the frp
 * tunnel, and the media route serves image bytes.
 *
 * Fails **closed** when WEB_API_TOKEN is unset. An unconfigured deployment
 * answering 503 is a problem someone notices; one that answers 200 to the whole
 * internet is not.
 */
export function requireWebApiToken(req, res, next) {
  const expected = String(process.env.WEB_API_TOKEN || '').trim();
  if (!expected) {
    logger.error('[webApi] WEB_API_TOKEN not configured — the content API is disabled');
    return res.status(503).json({ error: 'Content API not configured' });
  }
  const header = String(req.headers.authorization || '');
  const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!provided || !safeEqual(expected, provided)) {
    logger.warn('[webApi] rejected request with missing or invalid token', { path: req.path });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

/**
 * GET /api/web/content — every published record, in one document.
 *
 * The ETag is a hash of the content itself (see payloadEtag), so a poll that
 * finds nothing changed costs a 304 with no body. `no-cache` rather than
 * `no-store`: the consumer is expected to keep this and revalidate, which is
 * the whole point of the mirror.
 */
export const getContent = async (req, res, next) => {
  try {
    const payload = await buildPayload();
    const etag = payloadEtag(payload);

    res.set('ETag', etag);
    res.set('Cache-Control', 'no-cache');

    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
    return res.json(payload);
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /api/web/media/:uuid — the bytes of one published image.
 *
 * Immutable caching is safe because the editor never rewrites an image in
 * place: a re-upload creates a new record with a new uuid. The ETag is the
 * content hash the manifest already published, so the consumer can tell whether
 * it needs the body before asking for it.
 */
export const getMedia = async (req, res, next) => {
  try {
    const doc = await mdb.WEB.webMedia.findOne({ uuid: String(req.params.uuid), status: 'published' }).lean();
    if (!doc || !doc.bytes) {
      return res.status(404).json({ error: 'Not found' });
    }

    const etag = `"${doc.hash}"`;
    res.set('ETag', etag);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Content-Type', doc.mime);
    // Stops a browser sniffing these bytes into something executable.
    res.set('X-Content-Type-Options', 'nosniff');

    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
    return res.send(Buffer.from(doc.bytes.buffer || doc.bytes));
  } catch (err) {
    return next(err);
  }
};

export default { requireWebApiToken, getContent, getMedia };
