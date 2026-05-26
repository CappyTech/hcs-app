'use strict';

/**
 * paperlessApiLogService.js
 *
 * Write-only service for persisting Paperless-ngx API request/response/error
 * entries to the `paperlessApiLog` INTERNAL MongoDB collection.
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

function setModel(model) {
  _model = model;
}

function getModel() {
  if (_model) return _model;
  try {
    const mdb = require('../mongoose/services/mongooseDatabaseService');
    _model = mdb.INTERNAL?.paperlessApiLog || null;
  } catch (_) {}
  return _model;
}

async function write(entry) {
  try {
    const model = getModel();
    if (!model) return;
    await model.create(entry);
  } catch (err) {
    logger.warn(`[paperlessApiLog] Failed to write log entry: ${err.message}`);
  }
}

function logRequest({ method, url, data }) {
  return write({
    direction: 'request',
    method: (method || 'GET').toUpperCase(),
    url,
    requestBody: summarizePayload(data),
  });
}

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
