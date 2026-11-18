import mdb from '../mongoose/services/mongooseDatabaseService.js';
import logger from './loggerService.js';
import __ipService from './ipService.js';
import auditContext from '../mongoose/services/auditContextService.js';

/**
 * Security audit log — see the securityEvent model for the event catalogue.
 *
 * record() is deliberately fire-and-forget and never throws: a failure to
 * write an audit row must never break a login or account operation. Events
 * also land in the app log at info level for real-time visibility.
 */

function clientIp(req) {
  try {
    const { getClientIp } = __ipService;
    return getClientIp(req) || req?.ip || null;
  } catch (_) {
    return req?.ip || null;
  }
}

/**
 * @param {string} type   – one of the securityEvent model's EVENT_TYPES
 * @param {object} req    – Express request (for ip/user-agent/actor), may be null.
 *                          With no req (a service deep in a request), the actor
 *                          and ip come from the request context (auditContextService).
 * @param {object} [data] – { userId, username, actorId, actorName, meta }
 */
function record(type, req, data = {}) {
  const ctx = req ? null : auditContext.get();
  const doc = {
    type,
    userId: data.userId ?? null,
    username: data.username ?? null,
    actorId: data.actorId ?? req?.user?._id ?? ctx?.actorId ?? null,
    actorName: data.actorName ?? req?.user?.username ?? (ctx?.actorName || null),
    ip: req ? clientIp(req) : (ctx?.ip || null),
    userAgent: req?.headers?.['user-agent']?.slice(0, 300) ?? null,
    meta: data.meta || {},
  };

  logger.info(`[security] ${type} — user: ${doc.username || doc.userId || '-'}, actor: ${doc.actorName || '-'}, ip: ${doc.ip || '-'}`);

  const SecurityEvent = mdb.INTERNAL?.securityEvent;
  if (!SecurityEvent) return;
  SecurityEvent.create(doc).catch((err) => {
    logger.error('[auditLogService] Failed to write security event: ' + err.message);
  });
}

export default { record };
