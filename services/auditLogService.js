'use strict';

const mdb = require('../mongoose/services/mongooseDatabaseService');
const logger = require('./loggerService');

/**
 * Security audit log — see the securityEvent model for the event catalogue.
 *
 * record() is deliberately fire-and-forget and never throws: a failure to
 * write an audit row must never break a login or account operation. Events
 * also land in the app log at info level for real-time visibility.
 */

function clientIp(req) {
  try {
    const { getClientIp } = require('./ipService');
    return getClientIp(req) || req?.ip || null;
  } catch (_) {
    return req?.ip || null;
  }
}

/**
 * @param {string} type   – one of the securityEvent model's EVENT_TYPES
 * @param {object} req    – Express request (for ip/user-agent/actor), may be null
 * @param {object} [data] – { userId, username, actorId, actorName, meta }
 */
function record(type, req, data = {}) {
  const doc = {
    type,
    userId: data.userId ?? null,
    username: data.username ?? null,
    actorId: data.actorId ?? req?.user?._id ?? null,
    actorName: data.actorName ?? req?.user?.username ?? null,
    ip: clientIp(req),
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

module.exports = { record };
