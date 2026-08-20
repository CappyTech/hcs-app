/**
 * connectionSettingsController.js
 *
 * Live connection tests for the external services hcs-app talks to:
 * KashFlow, SMTP, Paperless-ngx and Twilio.
 *
 * The settings pages themselves moved to appConfigController, which renders
 * every group from configRegistry and stores values in Mongo. This file kept
 * only the tester: it reads whatever configuration is currently in effect and
 * proves it works, which is the one thing a settings page cannot do by
 * inspecting itself.
 */

import configService from '../../services/configService.js';
import logger from '../../services/loggerService.js';
import nodemailer from 'nodemailer';
import kashflowSessionService from '../../services/kashflowSessionService.js';
import smsService from '../../services/smsService.js';

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
  const back = req.get('referer') || '/admin/config';
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

export default { testConnection };
