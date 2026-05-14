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
    requestBody: data || null,
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
    responseBody: data || null,
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
