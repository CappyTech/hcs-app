const nodemailer = require("nodemailer");
const logger = require("./loggerService");

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
async function sendMail({ to, subject, html, text }) {
  const from =
    process.env.SMTP_FROM || process.env.SMTP_USER || "noreply@heroncs.co.uk";
  const transporter = getTransporter();

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

// ── Send verification email ──────────────────────────────────────────
async function sendVerificationEmail(email, token) {
  const baseUrl =
    process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const verifyUrl = `${baseUrl}/user/verify-email?token=${encodeURIComponent(token)}`;

  const subject = "Verify your email — Heron CS";
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #15803d;">Verify Your Email</h2>
      <p>Thank you for registering. Please click the button below to verify your email address:</p>
      <p style="text-align: center; margin: 30px 0;">
        <a href="${verifyUrl}"
           style="background-color: #15803d; color: #fff; padding: 12px 32px; text-decoration: none; border-radius: 6px; font-size: 16px;">
          Verify Email
        </a>
      </p>
      <p style="color: #666; font-size: 13px;">
        Or copy this link into your browser:<br>
        <a href="${verifyUrl}">${verifyUrl}</a>
      </p>
      <p style="color: #999; font-size: 12px;">This link expires in 24 hours.</p>
    </div>
  `;
  const text = `Verify your email by visiting: ${verifyUrl}\n\nThis link expires in 24 hours.`;

  return sendMail({ to: email, subject, html, text });
}

// ── Send password reset email ────────────────────────────────────────
async function sendPasswordResetEmail(email, token) {
  const baseUrl =
    process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const resetUrl = `${baseUrl}/user/reset-password?token=${encodeURIComponent(token)}`;

  const subject = "Reset your password — Heron CS";
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #15803d;">Reset Your Password</h2>
      <p>We received a request to reset the password for your account. Click the button below to choose a new password:</p>
      <p style="text-align: center; margin: 30px 0;">
        <a href="${resetUrl}"
           style="background-color: #15803d; color: #fff; padding: 12px 32px; text-decoration: none; border-radius: 6px; font-size: 16px;">
          Reset Password
        </a>
      </p>
      <p style="color: #666; font-size: 13px;">
        Or copy this link into your browser:<br>
        <a href="${resetUrl}">${resetUrl}</a>
      </p>
      <p style="color: #999; font-size: 12px;">This link expires in 1 hour. If you did not request a password reset, you can safely ignore this email.</p>
    </div>
  `;
  const text = `Reset your password by visiting: ${resetUrl}\n\nThis link expires in 1 hour. If you did not request a password reset, you can safely ignore this email.`;

  return sendMail({ to: email, subject, html, text });
}

module.exports = {
  sendMail,
  sendVerificationEmail,
  sendPasswordResetEmail,
};
