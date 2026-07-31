import nodemailer from 'nodemailer';
import logger from './loggerService.js';
import emailLayout from './emailLayout.js';

// ── Transporter (lazy-initialised) ───────────────────────────────────
let _transporter = null;

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

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    logger.warn(
      "Email service: SMTP_HOST, SMTP_USER or SMTP_PASS not configured — emails will be logged only.",
    );
    return null;
  }

  // `secure: true` means implicit TLS (port 465). For 587/25 use STARTTLS
  // (`secure: false`). Allow an explicit override for hosts that don't follow
  // the port convention.
  const secure =
    process.env.SMTP_SECURE !== undefined
      ? String(process.env.SMTP_SECURE).toLowerCase() === "true"
      : port === 465;

  logger.info(`[emailService] Creating SMTP transporter — host: ${host}, port: ${port}, secure: ${secure}`);

  _transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    // Fail fast with a clear error instead of hanging when the SMTP host is
    // unreachable or the port is wrong.
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS) || 15000,
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS) || 10000,
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS) || 20000,
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
    process.env.SMTP_FROM || process.env.SMTP_USER || "noreply@heroncs.co.uk";
  const transporter = getTransporter();

  if (html != null && !emailLayout.isDocument(html)) {
    html = emailLayout.renderDocument({
      contentHtml: html,
      title: subject,
      preheader,
    });
  }

  if (!transporter) {
    // In fallback mode, avoid logging full email bodies which may contain sensitive tokens.
    logger.info(
      `[EMAIL-FALLBACK] To: ${maskEmail(to)} | Subject: ${subject} | bodyLength=${getBodyLength(text, html)}`,
    );
    return { accepted: [to], fallback: true };
  }

  try {
    const info = await transporter.sendMail({ from, to, subject, html, text });
    logger.info(`[emailService] Email sent to ${to} — messageId: ${info.messageId}`);
    return info;
  } catch (err) {
    logger.error(`[emailService] Failed to send email to ${to} via ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587}: ${err.message}`, { stack: err.stack });
    throw err;
  }
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
};

export { sendMail, sendVerificationEmail, sendPasswordResetEmail, buildActionEmail };
