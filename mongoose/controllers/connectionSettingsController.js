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
import axios from 'axios';
import kashflowSessionService from '../../services/kashflowSessionService.js';
import smsService from '../../services/smsService.js';
import emailService from '../../services/emailService.js';

// ── Live connection tests ────────────────────────────────────────────────────

const TESTS = {
  smtp: async () => {
    const host = configService.get('SMTP_HOST');
    const user = configService.get('SMTP_USER');
    const pass = configService.get('SMTP_PASS');
    if (!host || !user || !pass) throw new Error('SMTP host/user/password not configured.');
    // Fresh transporter (not the cached one) so the test reflects current settings.
    // Mirror emailService's secure logic so the test matches how mail is actually sent:
    // honour SMTP_SECURE when set, otherwise implicit TLS only on 465.
    const port = Number(configService.get('SMTP_PORT')) || 587;
    const secureRaw = configService.get('SMTP_SECURE');
    const secure =
      secureRaw !== undefined && secureRaw !== ''
        ? String(secureRaw).toLowerCase() === 'true'
        : port === 465;
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
      connectionTimeout: 10_000,
    });
    await transporter.verify();
    return `SMTP connection to ${host} verified (login accepted).`;
  },

  graph: async () => {
    // Acquire an app-only token to prove tenant/client/secret are valid. Mail.Send
    // and the Application Access Policy are only exercised on a real send.
    await emailService.verifyGraphAuth();
    const sender = configService.get('GRAPH_MAIL_SENDER') || configService.get('SMTP_FROM') || '(sender not set)';
    return `Microsoft Graph authentication succeeded (token acquired). Sends will be attempted as ${sender}; Mail.Send permission and the Application Access Policy are verified at send time.`;
  },

  'microsoft-sso': async () => {
    const tenant = configService.get('MS_SSO_TENANT_ID');
    const clientId = configService.get('MS_SSO_CLIENT_ID');
    const secret = configService.get('MS_SSO_CLIENT_SECRET');
    if (!tenant || !clientId || !secret) throw new Error('Microsoft SSO tenant / client ID / client secret not configured.');
    // Reachability + validity of the tenant's OpenID metadata. Proves the tenant
    // exists and is usable; the full sign-in (redirect URI, consent) is verified
    // by an actual login.
    const url = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/v2.0/.well-known/openid-configuration`;
    const { data } = await axios.get(url, { timeout: 10000 });
    if (!data || !data.authorization_endpoint) throw new Error('Could not read the tenant OpenID configuration.');
    return `Tenant reachable — sign-in will use ${data.authorization_endpoint}. Ensure the app registration's Redirect URI matches this app's /auth/microsoft/callback.`;
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
