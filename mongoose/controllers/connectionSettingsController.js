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

import path from 'path';
import configService from '../../services/configService.js';
import logger from '../../services/loggerService.js';
import nodemailer from 'nodemailer';
import kashflowSessionService from '../../services/kashflowSessionService.js';
import smsService from '../../services/smsService.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const SECRET_KEYS = new Set([
  'KASHFLOW_API_PASSWORD',
  'KASHFLOW_MEMORABLE',
  'KASHFLOW_SESSION_TOKEN',
  'SMTP_PASS',
  'PAPERLESS_TOKEN',
  'TWILIO_AUTH_TOKEN',
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

export const getConnectionsHub = (req, res, next) => {
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
    const smsOk = !!(configService.get('TWILIO_ACCOUNT_SID') && configService.get('TWILIO_AUTH_TOKEN') && configService.get('TWILIO_FROM_NUMBER'));

    res.render(path.join('tailwindcss', 'admin', 'connections'), {
      title: 'External Connections',
      mongo,
      kashflowOk,
      smtpOk,
      paperlessOk,
      smsOk,
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

export const getKashflowSettings = (req, res, next) => {
  try {
    const fields = Object.fromEntries(KASHFLOW_KEYS.map(k => [k, field(k)]));
    res.render(path.join('tailwindcss', 'admin', 'kashflow'), {
      title: 'KashFlow API Settings',
      fields,
    });
  } catch (err) {
    logger.error(`[connectionSettings] kashflow GET error: ${err.message}`);
    next(err);
  }
};

export const postKashflowSettings = (req, res, next) => {
  try {
    const saved = applySettings(req.body, KASHFLOW_KEYS);
    logger.info(`[connectionSettings] KashFlow settings updated: ${saved} key(s) changed`);
    req.flash('success', saved
      ? `KashFlow settings saved (${saved} value${saved !== 1 ? 's' : ''} updated).`
      : 'No changes — all fields were left blank.');
    res.redirect('/admin/connections/kashflow');
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

export const getSmtpSettings = (req, res, next) => {
  try {
    const fields = Object.fromEntries(SMTP_KEYS.map(k => [k, field(k)]));
    res.render(path.join('tailwindcss', 'admin', 'smtp'), {
      title: 'Email (SMTP) Settings',
      fields,
    });
  } catch (err) {
    logger.error(`[connectionSettings] smtp GET error: ${err.message}`);
    next(err);
  }
};

export const postSmtpSettings = (req, res, next) => {
  try {
    const saved = applySettings(req.body, SMTP_KEYS);
    logger.info(`[connectionSettings] SMTP settings updated: ${saved} key(s) changed`);
    req.flash('success', saved
      ? `Email settings saved (${saved} value${saved !== 1 ? 's' : ''} updated).`
      : 'No changes — all fields were left blank.');
    res.redirect('/admin/connections/smtp');
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
  'PAPERLESS_TIMEOUT_MS',
  'PAPERLESS_PAGE_SIZE',
  'PAPERLESS_CONCURRENCY',
  'PAPERLESS_SSH_TUNNEL_ENABLED',
  'PEOPLES_PENSION_API_KEY',
];

export const getPaperlessSettings = (req, res, next) => {
  try {
    const fields = Object.fromEntries(PAPERLESS_KEYS.map(k => [k, field(k)]));
    res.render(path.join('tailwindcss', 'admin', 'paperless'), {
      title: 'Paperless-ngx & Other Connections',
      fields,
    });
  } catch (err) {
    logger.error(`[connectionSettings] paperless GET error: ${err.message}`);
    next(err);
  }
};

export const postPaperlessSettings = (req, res, next) => {
  try {
    const saved = applySettings(req.body, PAPERLESS_KEYS);
    logger.info(`[connectionSettings] Paperless settings updated: ${saved} key(s) changed`);
    req.flash('success', saved
      ? `Settings saved (${saved} value${saved !== 1 ? 's' : ''} updated).`
      : 'No changes — all fields were left blank.');
    res.redirect('/admin/connections/paperless');
  } catch (err) {
    logger.error(`[connectionSettings] paperless POST error: ${err.message}`);
    next(err);
  }
};

// ── SMS (Twilio) ──────────────────────────────────────────────────────────────

const TWILIO_KEYS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_NUMBER',
];

export const getSmsSettings = (req, res, next) => {
  try {
    const fields = Object.fromEntries(TWILIO_KEYS.map(k => [k, field(k)]));
    res.render(path.join('tailwindcss', 'admin', 'sms'), {
      title: 'SMS (Twilio) Settings',
      fields,
    });
  } catch (err) {
    logger.error(`[connectionSettings] sms GET error: ${err.message}`);
    next(err);
  }
};

// ── Live connection tests ────────────────────────────────────────────────────

const TESTS = {
  smtp: async () => {
    const host = configService.get('SMTP_HOST');
    const user = configService.get('SMTP_USER');
    const pass = configService.get('SMTP_PASS');
    if (!host || !user || !pass) throw new Error('SMTP host/user/password not configured.');
    // Fresh transporter (not the cached one) so the test reflects current settings
    const transporter = nodemailer.createTransport({
      host,
      port: Number(configService.get('SMTP_PORT')) || 587,
      secure: (Number(configService.get('SMTP_PORT')) || 587) === 465,
      auth: { user, pass },
      connectionTimeout: 10_000,
    });
    await transporter.verify();
    return `SMTP connection to ${host} verified (login accepted).`;
  },

  paperless: async () => {
    const base = (configService.get('PAPERLESS_BASE_URL') || '').replace(/\/+$/, '');
    const token = configService.get('PAPERLESS_TOKEN');
    if (!base || !token) throw new Error('Paperless base URL or token not configured.');
    const resp = await fetch(`${base}/documents/?page_size=1`, {
      headers: {
        Authorization: `Token ${token}`,
        Accept: configService.get('PAPERLESS_ACCEPT', 'application/json'),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`Paperless responded ${resp.status} ${resp.statusText}.`);
    const data = await resp.json();
    return `Paperless reachable — ${data.count ?? '?'} document(s) visible to this token.`;
  },

  kashflow: async () => {
    const token = await kashflowSessionService.ensureSessionToken();
    if (!token) throw new Error('Could not obtain a KashFlow session token.');
    return 'KashFlow authentication succeeded — session token obtained.';
  },

  sms: async () => {
    const sid = configService.get('TWILIO_ACCOUNT_SID');
    const authToken = configService.get('TWILIO_AUTH_TOKEN');
    if (!sid || !authToken) throw new Error('Twilio SID or auth token not configured.');
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${authToken}`).toString('base64') },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`Twilio responded ${resp.status} — check SID/auth token.`);
    const data = await resp.json();
    return `Twilio account "${data.friendly_name || sid}" verified (status: ${data.status}).`;
  },
};

/** POST /admin/connections/test/:service — live credential check, result via flash */
export const testConnection = async (req, res) => {
  const service = req.params.service;
  const test = TESTS[service];
  const back = req.get('referer') || '/admin/connections';
  if (!test) {
    req.flash('error', `Unknown service: ${service}`);
    return res.redirect(back);
  }
  try {
    const message = await test();
    logger.info(`[connectionSettings] test ${service}: OK — ${message}`);
    req.flash('success', message);
  } catch (err) {
    logger.warn(`[connectionSettings] test ${service}: FAILED — ${err.message}`);
    req.flash('error', `${service} test failed: ${err.message}`);
  }
  res.redirect(back);
};

export const postSmsSettings = (req, res, next) => {
  try {
    const saved = applySettings(req.body, TWILIO_KEYS);
    // Reset the cached Twilio client so it picks up the new credentials
    if (typeof smsService.resetClient === 'function') smsService.resetClient();
    logger.info(`[connectionSettings] SMS settings updated: ${saved} key(s) changed`);
    req.flash('success', saved
      ? `SMS settings saved (${saved} value${saved !== 1 ? 's' : ''} updated).`
      : 'No changes — all fields were left blank.');
    res.redirect('/admin/connections/sms');
  } catch (err) {
    logger.error(`[connectionSettings] sms POST error: ${err.message}`);
    next(err);
  }
};

export default { getConnectionsHub, getKashflowSettings, postKashflowSettings, getSmtpSettings, postSmtpSettings, getPaperlessSettings, postPaperlessSettings, getSmsSettings, testConnection, postSmsSettings };
