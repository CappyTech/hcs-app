'use strict';

/**
 * connectionSettingsController.js
 *
 * Admin settings UI for external service connections:
 *   KashFlow API, SMTP email, Paperless-ngx.
 *
 * Values are persisted to config/app-config.json via configService.save()
 * AND applied immediately to process.env so the running process picks them
 * up without a restart. On the next restart, configService.bootstrap() in
 * app.js re-applies file values for any env key not set by docker-compose.
 *
 * Keys that were set at startup by docker-compose/OS are flagged with
 * `fromEnv: true` — they CAN be overridden via this UI for the current
 * process lifetime but will revert on restart unless the docker-compose
 * env is updated.
 */

const path = require('path');
const configService = require('../../services/configService');
const logger = require('../../services/loggerService');

// ── Helpers ──────────────────────────────────────────────────────────────────

const SECRET_KEYS = new Set([
  'KASHFLOW_API_PASSWORD',
  'KASHFLOW_MEMORABLE',
  'KASHFLOW_SESSION_TOKEN',
  'SMTP_PASS',
  'PAPERLESS_TOKEN',
]);

/**
 * Build a field descriptor for the view.
 * @param {string} key - env var name
 * @param {string} [fallback] - default value to show if not set
 */
function field(key, fallback = '') {
  const raw = configService.get(key, fallback);
  const isSet = raw !== undefined && raw !== '';
  const fromEnv = configService.isFromStartupEnv(key);
  return {
    key,
    fromEnv,
    isSet,
    display: isSet ? (SECRET_KEYS.has(key) ? '••••••••' : raw) : '',
  };
}

/**
 * Apply a POST body to process.env + app-config.json.
 * Only processes keys that are in the provided allowedKeys list.
 * Blank values are skipped (keep existing).
 */
function applySettings(body, allowedKeys) {
  const toSave = {};
  for (const key of allowedKeys) {
    const value = (body[key] || '').trim();
    if (value === '') continue; // blank = keep existing
    toSave[key] = value;
    process.env[key] = value;
  }
  if (Object.keys(toSave).length > 0) {
    configService.save(toSave);
  }
  return Object.keys(toSave).length;
}

// ── Hub ──────────────────────────────────────────────────────────────────────

const MONGO_DISPLAY_KEYS = [
  'MONGO_HOST', 'MONGO_PORT', 'MONGO_USER',
  'MONGO_DBNAME_INTERNAL', 'MONGO_DBNAME_REST', 'MONGO_DBNAME_PAPERLESS',
  'MONGO_AUTH_SOURCE', 'SSH_TUNNEL_ENABLED',
];

exports.getConnectionsHub = (req, res, next) => {
  try {
    const mongo = MONGO_DISPLAY_KEYS.map(key => ({
      key,
      fromEnv: configService.isFromStartupEnv(key),
      display: key === 'MONGO_USER' || key.includes('PASS')
        ? (configService.get(key) ? '••••••••' : '—')
        : (configService.get(key) || '—'),
    }));

    const kashflowOk = !!(configService.get('KASHFLOW_API_USERNAME') || configService.get('KASHFLOW_SESSION_TOKEN'));
    const smtpOk = !!(configService.get('SMTP_HOST') && configService.get('SMTP_USER'));
    const paperlessOk = !!configService.get('PAPERLESS_TOKEN');

    res.render(path.join('tailwindcss', 'settings', 'connections'), {
      title: 'External Connections',
      mongo,
      kashflowOk,
      smtpOk,
      paperlessOk,
    });
  } catch (err) {
    logger.error(`[connectionSettings] hub error: ${err.message}`);
    next(err);
  }
};

// ── KashFlow ─────────────────────────────────────────────────────────────────

const KASHFLOW_KEYS = [
  'KASHFLOW_API_BASE_URL',
  'KASHFLOW_API_USERNAME',
  'KASHFLOW_API_PASSWORD',
  'KASHFLOW_MEMORABLE',
  'KASHFLOW_SESSION_TOKEN',
  'KASHFLOW_DEBUG_SESSION',
  'KASHFLOW_DEFER_DEFAULTS',
];

exports.getKashflowSettings = (req, res, next) => {
  try {
    const fields = Object.fromEntries(KASHFLOW_KEYS.map(k => [k, field(k)]));
    res.render(path.join('tailwindcss', 'settings', 'kashflow'), {
      title: 'KashFlow API Settings',
      fields,
    });
  } catch (err) {
    logger.error(`[connectionSettings] kashflow GET error: ${err.message}`);
    next(err);
  }
};

exports.postKashflowSettings = (req, res, next) => {
  try {
    const saved = applySettings(req.body, KASHFLOW_KEYS);
    logger.info(`[connectionSettings] KashFlow settings updated: ${saved} key(s) changed`);
    req.flash('success', saved
      ? `KashFlow settings saved (${saved} value${saved !== 1 ? 's' : ''} updated).`
      : 'No changes — all fields were left blank.');
    res.redirect('/settings/connections/kashflow');
  } catch (err) {
    logger.error(`[connectionSettings] kashflow POST error: ${err.message}`);
    next(err);
  }
};

// ── SMTP ─────────────────────────────────────────────────────────────────────

const SMTP_KEYS = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'BASE_URL',
];

exports.getSmtpSettings = (req, res, next) => {
  try {
    const fields = Object.fromEntries(SMTP_KEYS.map(k => [k, field(k)]));
    res.render(path.join('tailwindcss', 'settings', 'smtp'), {
      title: 'Email (SMTP) Settings',
      fields,
    });
  } catch (err) {
    logger.error(`[connectionSettings] smtp GET error: ${err.message}`);
    next(err);
  }
};

exports.postSmtpSettings = (req, res, next) => {
  try {
    const saved = applySettings(req.body, SMTP_KEYS);
    logger.info(`[connectionSettings] SMTP settings updated: ${saved} key(s) changed`);
    req.flash('success', saved
      ? `Email settings saved (${saved} value${saved !== 1 ? 's' : ''} updated).`
      : 'No changes — all fields were left blank.');
    res.redirect('/settings/connections/smtp');
  } catch (err) {
    logger.error(`[connectionSettings] smtp POST error: ${err.message}`);
    next(err);
  }
};

// ── Paperless-ngx ────────────────────────────────────────────────────────────

const PAPERLESS_KEYS = [
  'PAPERLESS_BASE_URL',
  'PAPERLESS_TOKEN',
  'PAPERLESS_PORT',
  'PAPERLESS_ACCEPT',
  'PAPERLESS_PAGE_SIZE',
  'PAPERLESS_CONCURRENCY',
  'PAPERLESS_SSH_TUNNEL_ENABLED',
  'PEOPLES_PENSION_API_KEY',
];

exports.getPaperlessSettings = (req, res, next) => {
  try {
    const fields = Object.fromEntries(PAPERLESS_KEYS.map(k => [k, field(k)]));
    res.render(path.join('tailwindcss', 'settings', 'paperless'), {
      title: 'Paperless-ngx & Other Connections',
      fields,
    });
  } catch (err) {
    logger.error(`[connectionSettings] paperless GET error: ${err.message}`);
    next(err);
  }
};

exports.postPaperlessSettings = (req, res, next) => {
  try {
    const saved = applySettings(req.body, PAPERLESS_KEYS);
    logger.info(`[connectionSettings] Paperless settings updated: ${saved} key(s) changed`);
    req.flash('success', saved
      ? `Settings saved (${saved} value${saved !== 1 ? 's' : ''} updated).`
      : 'No changes — all fields were left blank.');
    res.redirect('/settings/connections/paperless');
  } catch (err) {
    logger.error(`[connectionSettings] paperless POST error: ${err.message}`);
    next(err);
  }
};
