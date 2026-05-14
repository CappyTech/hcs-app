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
    requestBody: data || null,
  });
}

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
