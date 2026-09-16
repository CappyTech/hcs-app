import nodemailer from 'nodemailer';
import axios from 'axios';
import logger from './loggerService.js';
import emailLayout from './emailLayout.js';
import configService from './configService.js';

// ── Transporter (lazy-initialised) ───────────────────────────────────
let _transporter = null;

// Cached Microsoft Graph app-only token (client-credentials flow).
let _graphToken = { value: null, expiresAt: 0 };

/**
 * Drop cached mail clients so the next send rebuilds from current config.
 * Called by the config after-save hook (appConfigController) when any SMTP or
 * Graph key changes, so a settings edit takes effect without a restart.
 */
function resetTransporter() {
  _transporter = null;
  _graphToken = { value: null, expiresAt: 0 };
}

/**
 * Which transport to use for outbound mail.
 * - When the "Use Microsoft Graph" toggle (USE_GRAPH) is on AND Graph is fully
 *   configured, send via Graph (app-only, no password/SMTP AUTH).
 * - Otherwise fall back to SMTP when it is configured.
 * - Otherwise null → log-only fallback.
 * If Graph is toggled on but not fully configured, we warn and fall back to SMTP
 * rather than dropping mail silently.
 * @returns {'graph'|'smtp'|null}
 */
function selectTransport() {
  const graphOn = String(configService.get("USE_GRAPH") || "").toLowerCase() === "true";
  const graphReady = !!(
    configService.get("GRAPH_TENANT_ID") &&
    configService.get("GRAPH_CLIENT_ID") &&
    configService.get("GRAPH_CLIENT_SECRET") &&
    (configService.get("GRAPH_MAIL_SENDER") || configService.get("SMTP_FROM"))
  );
  const smtpReady = !!(
    configService.get("SMTP_HOST") &&
    configService.get("SMTP_USER") &&
    configService.get("SMTP_PASS")
  );

  if (graphOn) {
    if (graphReady) return "graph";
    logger.warn(
      "Email service: USE_GRAPH is on but GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET / sender are not all set — falling back to SMTP.",
    );
  }
  if (smtpReady) return "smtp";
  return null;
}

/**
 * Acquire (and cache) a Microsoft Graph app-only access token via the
 * client-credentials flow. Returns null when Graph is not configured.
 */
async function getGraphToken() {
  const tenant = configService.get("GRAPH_TENANT_ID");
  const clientId = configService.get("GRAPH_CLIENT_ID");
  const clientSecret = configService.get("GRAPH_CLIENT_SECRET");
  if (!tenant || !clientId || !clientSecret) return null;

  // Reuse the cached token until a minute before it expires.
  if (_graphToken.value && Date.now() < _graphToken.expiresAt - 60_000) {
    return _graphToken.value;
  }

  const url = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  try {
    const { data } = await axios.post(url, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
    });
    _graphToken = {
      value: data.access_token,
      expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    };
    return _graphToken.value;
  } catch (err) {
    const detail = err.response?.data?.error_description || err.response?.data?.error || err.message;
    throw new Error(`Microsoft Graph token request failed: ${detail}`);
  }
}

/**
 * Verify Graph credentials by acquiring a token. Used by the connection-test
 * button. Does not send anything — Mail.Send and the Application Access Policy
 * are exercised at real send time.
 */
async function verifyGraphAuth() {
  const token = await getGraphToken();
  if (!token) throw new Error("Microsoft Graph is not configured (tenant / client ID / client secret).");
  return true;
}

/**
 * Send one message via Microsoft Graph app-only (POST /users/{sender}/sendMail).
 * The sending mailbox is the sender in the URL; the app must hold Mail.Send
 * scoped to it via an Application Access Policy.
 */
async function sendViaGraph({ from, to, subject, html, text }) {
  const token = await getGraphToken();
  if (!token) throw new Error("Microsoft Graph is not configured.");
  const sender = configService.get("GRAPH_MAIL_SENDER") || from;
  const recipients = String(to)
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));

  const body =
    html != null
      ? { contentType: "HTML", content: html }
      : { contentType: "Text", content: text || "" };

  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`;
  try {
    await axios.post(
      url,
      { message: { subject, body, toRecipients: recipients }, saveToSentItems: false },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, timeout: 20000 },
    );
    logger.info(`[emailService] Email sent to ${to} via Microsoft Graph (as ${sender})`);
    return { accepted: recipients.map((r) => r.emailAddress.address), graph: true };
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    throw new Error(`Microsoft Graph sendMail failed: ${detail}`);
  }
}

function maskEmail(email) {
  const value = String(email || "").trim();
  const at = value.indexOf("@");
  if (at <= 0) return value ? "***" : "-";
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const localMasked = `${local.slice(0, 2)}***`;
  return `${localMasked}@${domain}`;
}

function getBodyLength(text, html) {
  const body = text || html || "";
  return String(body).length;
}

function getTransporter() {
  if (_transporter) return _transporter;

  // Read through configService so the admin config page (managed store) is
  // authoritative and can override compose.env without a redeploy — the same
  // precedence every other setting uses. process.env still applies as the
  // fallback for anything not set in the store.
  const host = configService.get("SMTP_HOST");
  const port = Number(configService.get("SMTP_PORT")) || 587;
  const user = configService.get("SMTP_USER");
  const pass = configService.get("SMTP_PASS");

  if (!host || !user || !pass) {
    logger.warn(
      "Email service: SMTP_HOST, SMTP_USER or SMTP_PASS not configured — emails will be logged only.",
    );
    return null;
  }

  // `secure: true` means implicit TLS (port 465). For 587/25 use STARTTLS
  // (`secure: false`). Allow an explicit override for hosts that don't follow
  // the port convention.
  const secureRaw = configService.get("SMTP_SECURE");
  const secure =
    secureRaw !== undefined && secureRaw !== ""
      ? String(secureRaw).toLowerCase() === "true"
      : port === 465;

  logger.info(`[emailService] Creating SMTP transporter — host: ${host}, port: ${port}, secure: ${secure}`);

  _transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    // Fail fast with a clear error instead of hanging when the SMTP host is
    // unreachable or the port is wrong.
    connectionTimeout: Number(configService.get("SMTP_CONNECTION_TIMEOUT_MS")) || 15000,
    greetingTimeout: Number(configService.get("SMTP_GREETING_TIMEOUT_MS")) || 10000,
    socketTimeout: Number(configService.get("SMTP_SOCKET_TIMEOUT_MS")) || 20000,
  });

  return _transporter;
}

// ── Send an email ────────────────────────────────────────────────────
/**
 * Every outgoing email passes through here, so this is where the responsive
 * document wrapper is guaranteed. Callers hand over a content fragment and it
 * gets a `<head>` with the viewport meta and media queries; anything that is
 * already a full document is left alone, so a caller that needs full control
 * (or a message replayed out of the outbox after being wrapped once) is not
 * double-wrapped.
 */
async function sendMail({ to, subject, html, text, preheader }) {
  const from =
    configService.get("GRAPH_MAIL_SENDER") ||
    configService.get("SMTP_FROM") ||
    configService.get("SMTP_USER") ||
    "noreply@heroncs.co.uk";

  if (html != null && !emailLayout.isDocument(html)) {
    html = emailLayout.renderDocument({
      contentHtml: html,
      title: subject,
      preheader,
    });
  }

  const transport = selectTransport();

  if (transport === "graph") {
    try {
      return await sendViaGraph({ from, to, subject, html, text });
    } catch (err) {
      logger.error(`[emailService] Failed to send email to ${to} via Microsoft Graph: ${err.message}`, { stack: err.stack });
      throw err;
    }
  }

  if (transport === "smtp") {
    const transporter = getTransporter();
    if (transporter) {
      try {
        const info = await transporter.sendMail({ from, to, subject, html, text });
        logger.info(`[emailService] Email sent to ${to} — messageId: ${info.messageId}`);
        return info;
      } catch (err) {
        logger.error(`[emailService] Failed to send email to ${to} via ${configService.get("SMTP_HOST")}:${configService.get("SMTP_PORT") || 587}: ${err.message}`, { stack: err.stack });
        throw err;
      }
    }
  }

  // No transport configured — log-only fallback. Avoid logging full email bodies
  // which may contain sensitive tokens.
  logger.info(
    `[EMAIL-FALLBACK] To: ${maskEmail(to)} | Subject: ${subject} | bodyLength=${getBodyLength(text, html)}`,
  );
  return { accepted: [to], fallback: true };
}

/**
 * Content block for the two transactional emails below: heading, one line of
 * copy, a button, and the raw URL for anyone whose client swallows the button.
 * `sendMail` wraps the result in the responsive document.
 */
function buildActionEmail({ heading, intro, actionText, actionUrl, expiry }) {
  const { escapeHtml, safeUrl, button, BRAND, MUTED } = emailLayout;
  const safeLink = escapeHtml(safeUrl(actionUrl));
  return `<h1 class="email-heading" style="margin:0 0 16px;font-size:24px;line-height:31px;font-weight:700;color:${BRAND};">${escapeHtml(heading)}</h1>
            <p style="margin:0 0 8px;">${escapeHtml(intro)}</p>
            <div style="text-align:center;margin:28px 0 4px;">${button(actionText, actionUrl)}</div>
            <p class="email-muted" style="margin:20px 0 0;font-size:13px;line-height:20px;color:${MUTED};">
              Or copy this link into your browser:<br>
              <a class="email-link" href="${safeLink}" style="color:${BRAND};word-break:break-all;">${safeLink}</a>
            </p>
            <p class="email-muted" style="margin:14px 0 0;font-size:12px;line-height:18px;color:${MUTED};">${escapeHtml(expiry)}</p>`;
}

// ── Send verification email ──────────────────────────────────────────
async function sendVerificationEmail(email, token) {
  const baseUrl =
    process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const verifyUrl = `${baseUrl}/user/verify-email?token=${encodeURIComponent(token)}`;

  const subject = "Verify your email — Heron CS";
  const html = buildActionEmail({
    heading: "Verify Your Email",
    intro: "Thank you for registering. Please use the button below to verify your email address:",
    actionText: "Verify Email",
    actionUrl: verifyUrl,
    expiry: "This link expires in 24 hours.",
  });
  const text = `Verify your email by visiting: ${verifyUrl}\n\nThis link expires in 24 hours.`;

  return sendMail({
    to: email,
    subject,
    html,
    text,
    preheader: "Confirm your email address to finish setting up your Heron CS account.",
  });
}

// ── Send password reset email ────────────────────────────────────────
async function sendPasswordResetEmail(email, token) {
  const baseUrl =
    process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const resetUrl = `${baseUrl}/user/reset-password?token=${encodeURIComponent(token)}`;

  const subject = "Reset your password — Heron CS";
  const html = buildActionEmail({
    heading: "Reset Your Password",
    intro: "We received a request to reset the password for your account. Use the button below to choose a new password:",
    actionText: "Reset Password",
    actionUrl: resetUrl,
    expiry: "This link expires in 1 hour. If you did not request a password reset, you can safely ignore this email.",
  });
  const text = `Reset your password by visiting: ${resetUrl}\n\nThis link expires in 1 hour. If you did not request a password reset, you can safely ignore this email.`;

  return sendMail({
    to: email,
    subject,
    html,
    text,
    preheader: "Use the link inside to choose a new password. It expires in 1 hour.",
  });
}

export default {
  sendMail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  buildActionEmail,
  resetTransporter,
  verifyGraphAuth,
};

export { sendMail, sendVerificationEmail, sendPasswordResetEmail, buildActionEmail, resetTransporter, verifyGraphAuth };
