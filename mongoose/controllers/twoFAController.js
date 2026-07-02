const mongoose = require("mongoose");
const path = require("path");
const mdb = require("../services/mongooseDatabaseService");
const logger = require("../../services/loggerService");
const moment = require("moment-timezone");
const encryptionService = require("../../services/encryptionService");

function getSafeNext(raw) {
  const v = String(raw || "").trim();
  if (!v) return null;
  if (v.length > 2000) return null;
  if (v.includes("\n") || v.includes("\r")) return null;
  if (!v.startsWith("/")) return null;
  if (v.startsWith("//")) return null;
  if (v.includes("\\")) return null;
  // Check only the path portion (before ?) for :// so that query params
  // like ?return_to=https://sync.heroncs.co.uk are not rejected.
  const pathPart = v.split("?")[0];
  if (pathPart.includes("://")) return null;
  return v;
}

exports.render2FAPage = (req, res) => {
  if (req.session.user) {
    return res.redirect("/");
  }

  if (!req.session.userPending2FA) {
    req.flash("error", "2FA session expired. Please log in again.");
    return res.redirect("/user/login");
  }

  const pending = req.session.userPending2FA;
  const next = getSafeNext(pending?.next);
  res.render(path.join("tailwindcss", "user", "2fa"), {
    title: "Two-Factor Authentication",
    next,
  });
};

exports.verify2FA = async (req, res) => {
  try {
    const code = req.body.totpToken;
    const pending = req.session.userPending2FA;
    const next = getSafeNext(req.body?.next || pending?.next);

    if (!pending) {
      req.flash("error", "2FA session missing. Please log in again.");
      return res.redirect("/user/login");
    }

    const user = await mdb.INTERNAL.user.findOne({ uuid: pending.uuid });

    if (!user || !user.totpSecret) {
      req.flash("error", "User not found or 2FA not enabled.");
      return res.redirect("/user/login");
    }

    const decryptedSecret = encryptionService.decrypt(user.totpSecret);

    const totpService = require("../../services/totpService");
    let isValid = totpService.verifyTOTP(decryptedSecret, code);

    // Fallback: accept a one-time backup code (consumed on use)
    if (!isValid && Array.isArray(user.totpBackupCodes) && user.totpBackupCodes.length) {
      const result = await totpService.verifyAndConsumeBackupCode(code, user.totpBackupCodes);
      if (result.ok) {
        user.totpBackupCodes = result.remaining;
        await user.save();
        isValid = true;
        logger.warn(`[2fa] Backup code used by ${user.username} — ${result.remaining.length} remaining`);
        require("../../services/auditLogService").record("login_success", req, {
          userId: user._id, username: user.username,
          meta: { twoFactor: true, backupCodeUsed: true, backupCodesRemaining: result.remaining.length },
        });
        req.flash(
          "success",
          `Backup code accepted — ${result.remaining.length} code${result.remaining.length === 1 ? "" : "s"} remaining. Consider regenerating codes from Account Settings.`,
        );
      }
    }

    if (!isValid) {
      req.flash("error", "Invalid 2FA code. Please try again.");
      return res.redirect("/user/2fa");
    }

    const agent = req.useragent || {};
    const ip = req.ip;

    // Regenerate session to mitigate fixation at 2FA completion stage
    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });

    req.session.user = {
      id: user._id.toString(),
      uuid: user.uuid,
      username: user.username,
      email: user.email,
      role: user.role,
      loginTime: new Date().toISOString(),
      ip,
      userAgent: {
        browser: agent.browser || "Unknown",
        version: agent.version || "Unknown",
        os: agent.os || "Unknown",
        platform: agent.platform || "Unknown",
      },
    };

    delete req.session.userPending2FA;

    await new Promise((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });

    req.flash("success", "Successfully logged in.");

    // Denormalize user fields for querying sessions list (best-effort)
    if (mdb.INTERNAL.session) {
      mdb.INTERNAL.session.updateOne(
        { _id: req.sessionID },
        {
          $set: {
            userId: user._id.toString(),
            username: user.username,
            email: user.email,
            role: user.role,
            ip,
            uaBrowser: req.session.user.userAgent.browser,
            uaVersion: req.session.user.userAgent.version,
            uaOS: req.session.user.userAgent.os,
            loginTime: new Date(req.session.user.loginTime),
          },
        },
        { upsert: true },
      ).then((upd) =>
        logger.info(
          `[SESSION DENORM 2FA] matched=${upd.matchedCount} modified=${upd.modifiedCount} upserted=${upd.upsertedCount || 0} sid=${req.sessionID}`,
        ),
      ).catch((err) => logger.warn(`[SESSION DENORM 2FA] failed: ${err.message}`));
    }
    return res.redirect(next || "/");
  } catch (error) {
    logger.error("2FA verification error: " + error.message);
    delete req.session.userPending2FA;
    req.flash("error", "An error occurred during 2FA. Please log in again.");
    return res.redirect("/user/login");
  }
};
