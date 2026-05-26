'use strict';

/**
 * kashflowApiLogService.js
 *
 * Write-only service for persisting KashFlow API request/response/error
 * entries to the `kashflowApiLog` INTERNAL MongoDB collection.
 *
 * Failures are silently swallowed so a logging issue never breaks an API call.
 */

const logger = require('./loggerService');

let _model = null;

function safeSerializedLength(value) {
  try {
    return JSON.stringify(value).length;
  } catch (_) {
    return null;
  }
}

function summarizePayload(payload) {
  if (payload === null || typeof payload === 'undefined') return null;

  if (Array.isArray(payload)) {
    return {
      redacted: true,
      kind: 'array',
      itemCount: payload.length,
      serializedLength: safeSerializedLength(payload),
    };
  }

  if (typeof payload === 'object') {
    const keys = Object.keys(payload);
    return {
      redacted: true,
      kind: 'object',
      keyCount: keys.length,
      sampleKeys: keys.slice(0, 20),
      serializedLength: safeSerializedLength(payload),
    };
  }

  return {
    redacted: true,
    kind: typeof payload,
    serializedLength: safeSerializedLength(payload),
  };
}

/**
 * Called once mongooseDatabaseService has connected.
 * Lazily resolved on first write if not pre-set.
 */
function setModel(model) {
  _model = model;
}

function getModel() {
  if (_model) return _model;
  try {
    const mdb = require('../mongoose/services/mongooseDatabaseService');
    _model = mdb.INTERNAL?.kashflowApiLog || null;
  } catch (_) {}
  return _model;
}

async function write(entry) {
  try {
    const model = getModel();
    if (!model) return; // DB not ready yet — skip silently
    await model.create(entry);
  } catch (err) {
    logger.warn(`[kashflowApiLog] Failed to write log entry: ${err.message}`);
  }
}

/**
 * Log an outgoing KashFlow API request.
 * Authorization headers are stripped before storage.
 */
function logRequest({ method, url, data }) {
  return write({
    direction: 'request',
    method: (method || 'GET').toUpperCase(),
    url,
    requestBody: summarizePayload(data),
  });
}

/**
 * Log a successful KashFlow API response.
 */
function logResponse({ method, url, status, data, durationMs }) {
  return write({
    direction: 'response',
    method: (method || 'GET').toUpperCase(),
    url,
    status,
    responseBody: summarizePayload(data),
    durationMs,
  });
}

/**
 * Log a KashFlow API error.
 */
function logError({ method, url, status, message, durationMs }) {
  return write({
    direction: 'error',
    method: (method || 'GET').toUpperCase(),
    url,
    status: status || null,
    errorMessage: message,
    durationMs,
  });
}

module.exports = { setModel, logRequest, logResponse, logError };
