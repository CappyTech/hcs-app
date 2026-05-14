const logger = require("./loggerService");

// ── Twilio client (lazy-initialised) ─────────────────────────────────
let _client = null;

function getClient() {
  if (_client) return _client;

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    logger.warn(
      "SMS service: TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not configured — SMS will be logged only.",
    );
    return null;
  }

  const twilio = require("twilio");
  _client = twilio(accountSid, authToken);
  return _client;
}

// ── Send an SMS ───────────────────────────────────────────────────────
async function sendSms({ to, body }) {
  const from = process.env.TWILIO_FROM_NUMBER;
  const client = getClient();

  if (!client || !from) {
    logger.info(`[SMS-FALLBACK] To: ${to} | Body: ${body}`);
    return { fallback: true };
  }

  try {
    const message = await client.messages.create({ from, to, body });
    logger.info(`[smsService] SMS sent to ${to} — sid: ${message.sid}`);
    return message;
  } catch (err) {
    logger.error(`[smsService] Failed to send SMS to ${to}: ${err.message}`, { stack: err.stack });
    throw err;
  }
}

// ── Send password reset OTP ───────────────────────────────────────────
async function sendPasswordResetOtp(phoneNumber, otp) {
  const body = `Your Heron CS password reset code is: ${otp}. It expires in 10 minutes. Do not share this code.`;
  return sendSms({ to: phoneNumber, body });
}

module.exports = {
  sendSms,
  sendPasswordResetOtp,
  resetClient() { _client = null; },
};
