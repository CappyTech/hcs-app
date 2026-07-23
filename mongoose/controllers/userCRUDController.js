import path from 'path';
import mdb from '../services/mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';
import axios from 'axios';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import encryptionService from '../../services/encryptionService.js';
import { getClientIp } from '../../services/ipService.js';
import emailService from '../../services/emailService.js';
import smsService from '../../services/smsService.js';
import auditLog from '../../services/auditLogService.js';
import hibpService from '../../services/hibpService.js';
import totpService from '../../services/totpService.js';

function hasCookie(req, cookieName) {
  try {
    const header = String((req.headers && req.headers.cookie) || "");
    if (!header) return false;
    return header
      .split(";")
      .some((part) => part.trim().startsWith(`${cookieName}=`));
  } catch (_) {
    return false;
  }
}

function maskId(value) {
  try {
    const v = String(value || "");
    if (!v) return "-";
    if (v.length <= 10) return `${v.slice(0, 2)}…${v.slice(-2)}`;
    return `${v.slice(0, 6)}…${v.slice(-4)}`;
  } catch (_) {
    return "-";
  }
}

function maskIdentifier(value) {
  try {
    const v = String(value || "").trim();
    if (!v) return "-";
    if (v.length <= 3) return `${v[0]}…`;
    return `${v.slice(0, 2)}…${v.slice(-1)}`;
  } catch (_) {
    return "-";
  }
}

function getSafeNext(raw) {
  const v = String(raw || "").trim();
  if (!v) return null;
  if (v.length > 2000) return null;
  if (v.includes("\n") || v.includes("\r")) return null;

  // Only allow internal relative paths to prevent open redirects.
  // Disallow protocol-relative (//evil.com) and backslashes.
  if (!v.startsWith("/")) return null;
  if (v.startsWith("//")) return null;
  if (v.includes("\\")) return null;
  // Check only the path portion (before ?) for :// so that query params
  // like ?return_to=https://sync.heroncs.co.uk are not rejected.
  const pathPart = v.split("?")[0];
  if (pathPart.includes("://")) return null;
  return v;
}

export const renderRegistrationForm = (req, res, next) => {
  res.render(path.join("mongoose", "user", "register"), {
    title: "Register",
    siteKey: process.env.TURNSTILE_SITE_KEY,
  });
};

export const registerUser = async (req, res, next) => {
  try {
    const { username, email, password } = req.body;
    const token = req.body["cf-turnstile-response"];
    const ip = req.ip;

    if (!token) {
      logger.error("CAPTCHA verification failed (token missing).");
      req.flash("error", "CAPTCHA verification failed (token missing).");
      return res.redirect("/user/register");
    }

    const verifyResponse = await axios.post(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      new URLSearchParams({
        secret: process.env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: ip,
      }),
    );

    if (!verifyResponse.data.success) {
      logger.error("CAPTCHA verification failed.");
      req.flash("error", "CAPTCHA verification failed.");
      return res.redirect("/user/register");
    }

    const existingUser = await mdb.INTERNAL.user.findOne({
      $or: [{ username }, { email }],
    });

    if (existingUser) {
      logger.error("Username or email already exists");
      req.flash("error", "Username or email already exists");
      return res.redirect("/user/register");
    }

    // Role is always the safe default — only admins can change roles via user CRUD update
    const assignedRole = "none";
    const UserModel = mdb.INTERNAL?.user;
    if (!UserModel) {
      logger.error("User model not loaded (INTERNAL.user missing)");
      req.flash("error", "User model unavailable. Please try again later.");
      return res.redirect("/user/register");
    }
    // Reject passwords found in known data breaches (fails open on API outage)
    const breach = await hibpService.isPasswordPwned(password);
    if (breach.pwned) {
      req.flash("error", hibpService.PWNED_MESSAGE);
      return res.redirect("/user/register");
    }

    // Hash password before storing (was previously stored in plaintext)
    const saltRounds = Number(process.env.BCRYPT_ROUNDS) || 12;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Generate email verification token (URL-safe, 48 bytes → 64 chars hex)
    const verificationToken = crypto.randomBytes(48).toString("hex");
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    const newUser = new UserModel({
      username,
      email,
      password: hashedPassword,
      role: assignedRole,
      emailVerified: false,
      emailVerificationToken: verificationToken,
      emailVerificationExpires: verificationExpires,
    });

    await newUser.save();

    // Send verification email (non-blocking — don't fail registration if email fails)
    try {
      await emailService.sendVerificationEmail(email, verificationToken);
    } catch (emailErr) {
      logger.error(
        `Failed to send verification email to ${email}: ${emailErr.message}`,
      );
    }

    logger.info("New User Created.");
    req.flash(
      "success",
      "Account created! Please check your email to verify your account before logging in.",
    );
    return res.redirect("/user/login");
  } catch (error) {
    logger.error(`[userCRUD] Error registering user: ${error.message}`, { stack: error.stack });
    req.flash("error", "Registration failed. Please try again.");
    return res.redirect("/user/register");
  }
};

export const renderLoginForm = (req, res) => {
  // Render TailwindCSS version of login template
  const next = getSafeNext(req.query?.next);
  res.render(path.join("tailwindcss", "user", "login"), {
    title: "Log In",
    siteKey: process.env.TURNSTILE_SITE_KEY,
    skipTurnstile: process.env.SKIP_TURNSTILE === "true",
    next,
  });
};

export const loginUser = async (req, res) => {
  try {
    const next = getSafeNext(req.body?.next || req.query?.next);
    const { usernameOrEmail, password } = req.body;
    const token = req.body["cf-turnstile-response"];
    const ip = getClientIp(req);
    const agent = req.useragent || {};
    const skipCaptcha = process.env.SKIP_TURNSTILE === "true";

    logger.info(
      `[login attempt] ident=${maskIdentifier(usernameOrEmail)} isEmail=${String(usernameOrEmail || "").includes("@") ? "Y" : "N"} ` +
        `ip=${ip} sidCookie=${hasCookie(req, "hms.sid") ? "Y" : "N"} sess=${maskId(req.sessionID)} ` +
        `secure=${req.secure ? "Y" : "N"} proto=${req.protocol} ua=${agent.browser || "Unknown"}/${agent.os || "Unknown"}`,
    );

    if (!skipCaptcha && !token) {
      logger.info("Login rejected: CAPTCHA token missing");
      req.flash("error", "CAPTCHA token missing.");
      return res.redirect(
        "/user/login" + (next ? "?next=" + encodeURIComponent(next) : ""),
      );
    }

    if (!skipCaptcha) {
      const verifyResponse = await axios.post(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        new URLSearchParams({
          secret: process.env.TURNSTILE_SECRET_KEY,
          response: token,
          remoteip: ip,
        }),
      );
      if (!verifyResponse.data.success) {
        logger.info("Login rejected: CAPTCHA verification failed");
        req.flash("error", "CAPTCHA verification failed.");
        return res.redirect(
          "/user/login" + (next ? "?next=" + encodeURIComponent(next) : ""),
        );
      }
    } else {
      logger.info("Login CAPTCHA bypass active (SKIP_TURNSTILE=true)");
    }

    if (!usernameOrEmail || !password) {
      logger.info("Login rejected: missing credentials");
      req.flash("error", "Username and password are required.");
      return res.redirect(
        "/user/login" + (next ? "?next=" + encodeURIComponent(next) : ""),
      );
    }

    const user = await mdb.INTERNAL.user.findOne({
      $or: [{ username: usernameOrEmail }, { email: usernameOrEmail }],
    });

    // Account lockout check
    const MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS) || 5;
    const LOCKOUT_MS  = Number(process.env.LOGIN_LOCKOUT_MS)  || 15 * 60 * 1000; // 15 min

    if (user && user.lockedUntil && user.lockedUntil > new Date()) {
      const remaining = Math.ceil((user.lockedUntil - Date.now()) / 60000);
      logger.warn(`[login] account locked user=${user.username} ip=${ip} remaining=${remaining}min`);
      req.flash('error', `Account temporarily locked. Try again in ${remaining} minute${remaining !== 1 ? 's' : ''}.`);
      return res.redirect('/user/login' + (next ? '?next=' + encodeURIComponent(next) : ''));
    }

    let authOk = false;
    if (!user) {
      logger.info(
        `Login rejected: user not found for identifier "${usernameOrEmail}"`,
      );
      authOk = false;
    } else {
      const stored = user.password;
      const looksHashed = typeof stored === "string" && stored.startsWith("$2");
      if (looksHashed) {
        authOk = await bcrypt.compare(password, stored);
        if (!authOk)
          logger.info(
            `Login rejected: bcrypt mismatch for user ${user.username}`,
          );
      } else {
        // Legacy plaintext fallback: direct compare then upgrade to hashed
        if (password === stored) {
          try {
            const saltRounds = Number(process.env.BCRYPT_ROUNDS) || 12;
            user.password = await bcrypt.hash(stored, saltRounds);
            await user.save();
            authOk = true;
            logger.info(
              `Upgraded legacy plaintext password for user ${user.username}`,
            );
          } catch (e) {
            logger.error(
              `Failed upgrading plaintext password for ${user.username}: ${e.message}`,
            );
            authOk = false;
          }
        } else {
          logger.info(
            `Login rejected: plaintext mismatch for user ${user.username}`,
          );
          authOk = false;
        }
      }
    }
    if (!authOk) {
      // Increment failed attempt counter (only when the account exists, to avoid
      // leaking whether a username is valid via a DB write side-channel).
      if (user) {
        user.loginAttempts = (user.loginAttempts || 0) + 1;
        if (user.loginAttempts >= MAX_ATTEMPTS) {
          user.lockedUntil = new Date(Date.now() + LOCKOUT_MS);
          user.loginAttempts = 0;
          logger.warn(`[login] account locked after ${MAX_ATTEMPTS} failures user=${user.username} ip=${ip}`);
          auditLog.record("account_locked", req, {
            userId: user._id, username: user.username,
            meta: { maxAttempts: MAX_ATTEMPTS, lockedUntil: user.lockedUntil },
          });
        }
        await user.save();
      }
      auditLog.record("login_failed", req, {
        userId: user?._id ?? null,
        username: user?.username ?? String(usernameOrEmail).slice(0, 100),
        meta: { knownUser: !!user },
      });
      req.flash("error", "Invalid username or password.");
      return res.redirect(
        "/user/login" + (next ? "?next=" + encodeURIComponent(next) : ""),
      );
    }

    // Reset lockout state on successful auth
    if (user && (user.loginAttempts || user.lockedUntil)) {
      user.loginAttempts = 0;
      user.lockedUntil = null;
      await user.save();
    }
    auditLog.record("login_success", req, {
      userId: user._id, username: user.username,
      meta: { twoFactor: !!user.totpEnabled },
    });

    const sessionData = {
      id: user._id.toString(),
      uuid: user.uuid,
      username: user.username,
      email: user.email,
      role: user.role,
      loginTime: new Date().toISOString(),
      ip,
      next,
      userAgent: {
        browser: agent.browser || "Unknown",
        version: agent.version || "Unknown",
        os: agent.os || "Unknown",
        platform: agent.platform || "Unknown",
      },
    };

    // If TOTP is enabled, try the inline code first; fall back to /user/2fa
    if (user.totpEnabled) {
      const inlineTotp = String(req.body.totp || "").trim();
      if (inlineTotp) {
        const decryptedSecret = encryptionService.decrypt(user.totpSecret);
        let totpValid = totpService.verifyTOTP(decryptedSecret, inlineTotp);

        if (!totpValid && Array.isArray(user.totpBackupCodes) && user.totpBackupCodes.length) {
          const result = await totpService.verifyAndConsumeBackupCode(inlineTotp, user.totpBackupCodes);
          if (result.ok) {
            user.totpBackupCodes = result.remaining;
            await user.save();
            totpValid = true;
            logger.warn(`[login] Backup code used by ${user.username} — ${result.remaining.length} remaining`);
            auditLog.record("login_success", req, {
              userId: user._id, username: user.username,
              meta: { twoFactor: true, backupCodeUsed: true, backupCodesRemaining: result.remaining.length },
            });
            req.flash(
              "success",
              `Backup code accepted — ${result.remaining.length} code${result.remaining.length === 1 ? "" : "s"} remaining. Consider regenerating codes from Account Settings.`,
            );
          }
        }

        if (!totpValid) {
          req.flash("error", "Invalid 2FA code. Please try again.");
          return res.redirect("/user/login" + (next ? "?next=" + encodeURIComponent(next) : ""));
        }

        // Inline TOTP verified — fall through to full session creation below
      } else {
        // No inline code provided — redirect to dedicated 2FA page
        req.session.userPending2FA = sessionData;
        await new Promise((resolve, reject) => {
          req.session.save((err) => (err ? reject(err) : resolve()));
        });
        logger.info(`Login staged for 2FA: ${user.username}`);
        return res.redirect("/user/2fa");
      }
    }

    // Regenerate session to prevent session fixation and ensure the Set-Cookie
    // header is sent on the login response (mirrors twoFAController behaviour).
    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });

    req.session.user = sessionData;

    await new Promise((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });

    // Denormalize user fields onto the session document for efficient querying
    try {
      if (mdb.INTERNAL.session) {
        await mdb.INTERNAL.session.updateOne(
          { _id: req.sessionID },
          {
            $set: {
              userId: user._id.toString(),
              username: user.username,
              email: user.email,
              role: user.role,
              ip,
              uaBrowser: sessionData.userAgent.browser,
              uaVersion: sessionData.userAgent.version,
              uaOS: sessionData.userAgent.os,
              loginTime: new Date(sessionData.loginTime),
            },
          },
          { upsert: true },
        );
      }
    } catch (e) {
      logger.warn(`Session denorm (login) failed: ${e.message}`);
    }

    logger.info(
      `${user.username} successfully logged in. ` +
        `sess=${maskId(req.sessionID)} sidCookieWas=${hasCookie(req, "hms.sid") ? "Y" : "N"} sessionUser=${req.session?.user ? "Y" : "N"}`,
    );
    req.flash("success", `${user.username}, you're logged in.`);
    return res.redirect(next || "/");
  } catch (error) {
    logger.error("Login error: " + error.message);
    req.flash("error", "Login failed. Please try again.");
    const next = getSafeNext(req.body?.next || req.query?.next);
    return res.redirect(
      "/user/login" + (next ? "?next=" + encodeURIComponent(next) : ""),
    );
  }
};

export const logoutUser = (req, res) => {
  auditLog.record("logout", req, {
    userId: req.user?._id ?? null,
    username: req.user?.username ?? req.session?.user?.username ?? null,
  });
  req.session.destroy((err) => {
    if (err) {
      logger.error("Error logging out: " + err.message);
      req.flash("error", "An error occurred while logging out.");
      return res.redirect("/");
    }
    res.clearCookie("hms.sid");
    req.flash("success", "You have been logged out.");
    return res.redirect("/user/login");
  });
};

// ── Email verification ───────────────────────────────────────────────
export const verifyEmail = async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) {
      req.flash("error", "Invalid verification link.");
      return res.redirect("/user/login");
    }

    const user = await mdb.INTERNAL.user.findOne({
      emailVerificationToken: token,
      emailVerificationExpires: { $gt: new Date() },
    });

    if (!user) {
      req.flash("error", "Verification link is invalid or has expired.");
      return res.redirect("/user/login");
    }

    user.emailVerified = true;
    user.emailVerificationToken = null;
    user.emailVerificationExpires = null;
    await user.save();

    logger.info(`Email verified for user: ${user.username}`);
    req.flash("success", "Email verified successfully! You can now log in.");
    return res.redirect("/user/login");
  } catch (err) {
    logger.error(`Email verification error: ${err.message}`);
    req.flash("error", "Verification failed. Please try again.");
    return res.redirect("/user/login");
  }
};

// ── Render verification-pending page ─────────────────────────────────
export const renderVerifyPending = (req, res) => {
  res.render(path.join("tailwindcss", "user", "verify-pending"), {
    title: "Email Verification Required",
    email: req.user?.email || req.session?.user?.email || "",
  });
};

// ── Resend verification email ────────────────────────────────────────
export const resendVerification = async (req, res) => {
  try {
    const userId = req.user?._id || req.session?.user?.id;
    if (!userId) {
      req.flash("error", "Please log in first.");
      return res.redirect("/user/login");
    }

    const user = await mdb.INTERNAL.user.findById(userId);
    if (!user) {
      req.flash("error", "User not found.");
      return res.redirect("/user/login");
    }

    if (user.emailVerified) {
      req.flash("success", "Your email is already verified.");
      return res.redirect("/");
    }

    // Rate limit: only allow resend if token expired or > 2 min since last
    if (
      user.emailVerificationExpires &&
      user.emailVerificationExpires > new Date()
    ) {
      const tokenAge =
        Date.now() -
        (user.emailVerificationExpires.getTime() - 24 * 60 * 60 * 1000);
      if (tokenAge < 2 * 60 * 1000) {
        req.flash(
          "error",
          "Please wait a couple of minutes before requesting another email.",
        );
        return res.redirect("/user/verify-pending");
      }
    }

    // Generate new token
    const verificationToken = crypto.randomBytes(48).toString("hex");
    user.emailVerificationToken = verificationToken;
    user.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await user.save();

    await emailService.sendVerificationEmail(user.email, verificationToken);

    logger.info(`Verification email resent to ${user.email}`);
    req.flash("success", "Verification email sent! Check your inbox.");
    return res.redirect("/user/verify-pending");
  } catch (err) {
    logger.error(`Resend verification error: ${err.message}`);
    req.flash("error", "Failed to resend verification email.");
    return res.redirect("/user/verify-pending");
  }
};

// ── Mask a phone number for display (show last 4 digits only) ────────
function maskPhone(phone) {
  if (!phone || phone.length < 4) return "***";
  return "*".repeat(phone.length - 4) + phone.slice(-4);
}

// ── Forgot password — render form ────────────────────────────────────
export const renderForgotPasswordForm = (req, res) => {
  res.render(path.join("tailwindcss", "user", "forgot-password"), {
    title: "Forgot Password",
  });
};

// ── Forgot password — look up user, route to choice or send email ────
export const sendPasswordReset = async (req, res) => {
  const identifier = (req.body.usernameOrEmail || "").trim();
  const genericMsg =
    "If that account is registered, you will receive reset instructions shortly.";

  try {
    if (!identifier) {
      req.flash("error", "Please enter your username or email address.");
      return res.redirect("/user/forgot-password");
    }

    const user = await mdb.INTERNAL.user.findOne({
      $or: [{ username: identifier }, { email: identifier.toLowerCase() }],
    });

    if (user && user.phoneNumber) {
      // Store pending reset in session and redirect to method-choice page
      req.session.passwordResetPending = {
        userId: user._id.toString(),
        maskedPhone: maskPhone(user.phoneNumber),
        hasTOTP: !!(user.totpEnabled && user.totpSecret),
      };
      await new Promise((resolve, reject) =>
        req.session.save((err) => (err ? reject(err) : resolve())),
      );
      return res.redirect("/user/forgot-password/choose");
    }

    // No phone but has TOTP — still offer the choice
    if (user && user.totpEnabled && user.totpSecret) {
      req.session.passwordResetPending = {
        userId: user._id.toString(),
        maskedPhone: null,
        hasTOTP: true,
      };
      await new Promise((resolve, reject) =>
        req.session.save((err) => (err ? reject(err) : resolve())),
      );
      return res.redirect("/user/forgot-password/choose");
    }

    // No phone (or user not found) — send email silently
    if (user) {
      const resetToken = crypto.randomBytes(48).toString("hex");
      user.passwordResetToken = resetToken;
      user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000);
      await user.save();
      try {
        await emailService.sendPasswordResetEmail(user.email, resetToken);
      } catch (emailErr) {
        logger.error(
          `Failed to send password reset email to ${user.email}: ${emailErr.message}`,
        );
      }
      logger.info(`Password reset email issued for ${user.email}`);
      auditLog.record("password_reset_requested", req, {
        userId: user._id, username: user.username, meta: { channel: "email" },
      });
    } else {
      logger.info(
        `Password reset requested for unknown identifier: ${maskIdentifier(identifier)}`,
      );
    }

    req.flash("success", genericMsg);
    return res.redirect("/user/forgot-password");
  } catch (err) {
    logger.error(`Forgot password error: ${err.message}`);
    req.flash("success", genericMsg);
    return res.redirect("/user/forgot-password");
  }
};

// ── Forgot password — render method-choice page ───────────────────────
export const renderChooseResetMethod = (req, res) => {
  const pending = req.session.passwordResetPending;
  if (!pending) {
    req.flash("error", "Session expired. Please try again.");
    return res.redirect("/user/forgot-password");
  }
  res.render(path.join("tailwindcss", "user", "forgot-password-choose"), {
    title: "Reset Password",
    maskedPhone: pending.maskedPhone,
    hasTOTP: pending.hasTOTP || false,
  });
};

// ── Forgot password — dispatch chosen method ──────────────────────────
export const dispatchResetMethod = async (req, res) => {
  const pending = req.session.passwordResetPending;
  if (!pending) {
    req.flash("error", "Session expired. Please try again.");
    return res.redirect("/user/forgot-password");
  }

  const method = req.body.method;
  const genericMsg =
    "If that account is registered, you will receive reset instructions shortly.";

  try {
    const user = await mdb.INTERNAL.user.findById(pending.userId);

    if (!user) {
      delete req.session.passwordResetPending;
      req.flash("success", genericMsg);
      return res.redirect("/user/forgot-password");
    }

    if (method === "totp") {
      // No token to issue — just redirect to the TOTP verify form
      logger.info(
        `TOTP reset path selected for user ID ${pending.userId}`,
      );
      return res.redirect("/user/verify-totp-reset");
    }

    if (method === "sms") {
      // Generate 6-digit OTP
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      user.smsResetOtp = otp;
      user.smsResetExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
      await user.save();

      try {
        await smsService.sendPasswordResetOtp(user.phoneNumber, otp);
      } catch (smsErr) {
        logger.error(
          `Failed to send SMS OTP to ${maskPhone(user.phoneNumber)}: ${smsErr.message}`,
        );
      }

      logger.info(
        `SMS OTP issued for user ${user.username} → ${maskPhone(user.phoneNumber)}`,
      );
      return res.redirect("/user/verify-sms-otp");
    }

    // Default: email
    const resetToken = crypto.randomBytes(48).toString("hex");
    user.passwordResetToken = resetToken;
    user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000);
    await user.save();

    try {
      await emailService.sendPasswordResetEmail(user.email, resetToken);
    } catch (emailErr) {
      logger.error(
        `Failed to send password reset email to ${user.email}: ${emailErr.message}`,
      );
    }

    logger.info(`Password reset email issued for ${user.email}`);
    delete req.session.passwordResetPending;
    req.flash("success", genericMsg);
    return res.redirect("/user/forgot-password");
  } catch (err) {
    logger.error(`Dispatch reset method error: ${err.message}`);
    req.flash("success", genericMsg);
    return res.redirect("/user/forgot-password");
  }
};

// ── Reset password — render form ─────────────────────────────────────
export const renderResetPasswordForm = async (req, res) => {
  const { token } = req.query;

  if (!token) {
    req.flash("error", "Invalid or missing reset link.");
    return res.redirect("/user/login");
  }

  const user = await mdb.INTERNAL.user.findOne({
    passwordResetToken: token,
    passwordResetExpires: { $gt: new Date() },
  });

  if (!user) {
    req.flash("error", "Password reset link is invalid or has expired.");
    return res.redirect("/user/forgot-password");
  }

  res.render(path.join("tailwindcss", "user", "reset-password"), {
    title: "Reset Password",
    token,
  });
};

// ── Reset password — update password ─────────────────────────────────
export const resetPassword = async (req, res) => {
  const { token, password, confirmPassword } = req.body;

  if (!token) {
    req.flash("error", "Invalid or missing reset link.");
    return res.redirect("/user/login");
  }

  if (!password || password.length < 6) {
    req.flash("error", "Password must be at least 6 characters.");
    return res.redirect(
      `/user/reset-password?token=${encodeURIComponent(token)}`,
    );
  }

  if (password !== confirmPassword) {
    req.flash("error", "Passwords do not match.");
    return res.redirect(
      `/user/reset-password?token=${encodeURIComponent(token)}`,
    );
  }

  try {
    const user = await mdb.INTERNAL.user.findOne({
      passwordResetToken: token,
      passwordResetExpires: { $gt: new Date() },
    });

    if (!user) {
      req.flash("error", "Password reset link is invalid or has expired.");
      return res.redirect("/user/forgot-password");
    }

    const breach = await hibpService.isPasswordPwned(password);
    if (breach.pwned) {
      req.flash("error", hibpService.PWNED_MESSAGE);
      return res.redirect(
        `/user/reset-password?token=${encodeURIComponent(token)}`,
      );
    }

    const saltRounds = Number(process.env.BCRYPT_ROUNDS) || 12;
    user.password = await bcrypt.hash(password, saltRounds);
    user.passwordResetToken = null;
    user.passwordResetExpires = null;
    await user.save();

    logger.info(`Password reset successfully for ${user.email}`);
    auditLog.record("password_reset_completed", req, {
      userId: user._id, username: user.username,
    });
    req.flash(
      "success",
      "Your password has been reset. You can now log in with your new password.",
    );
    return res.redirect("/user/login");
  } catch (err) {
    logger.error(`Reset password error: ${err.message}`);
    req.flash("error", "Failed to reset password. Please try again.");
    return res.redirect("/user/forgot-password");
  }
};

// ── SMS OTP — render verification form ───────────────────────────────
export const renderVerifySmsOtp = (req, res) => {
  if (!req.session.passwordResetPending) {
    req.flash("error", "Session expired. Please try again.");
    return res.redirect("/user/forgot-password");
  }
  res.render(path.join("tailwindcss", "user", "verify-sms-otp"), {
    title: "Enter Verification Code",
    maskedPhone: req.session.passwordResetPending.maskedPhone,
  });
};

// ── SMS OTP — verify code and reset password ──────────────────────────
export const verifySmsOtp = async (req, res) => {
  const pending = req.session.passwordResetPending;
  if (!pending) {
    req.flash("error", "Session expired. Please try again.");
    return res.redirect("/user/forgot-password");
  }

  const { otp, password, confirmPassword } = req.body;

  if (!otp || otp.trim().length !== 6 || !/^\d{6}$/.test(otp.trim())) {
    req.flash("error", "Please enter the 6-digit code sent to your phone.");
    return res.redirect("/user/verify-sms-otp");
  }

  if (!password || password.length < 6) {
    req.flash("error", "Password must be at least 6 characters.");
    return res.redirect("/user/verify-sms-otp");
  }

  if (password !== confirmPassword) {
    req.flash("error", "Passwords do not match.");
    return res.redirect("/user/verify-sms-otp");
  }

  try {
    const user = await mdb.INTERNAL.user.findOne({
      _id: pending.userId,
      smsResetOtp: otp.trim(),
      smsResetExpires: { $gt: new Date() },
    });

    if (!user) {
      req.flash("error", "Invalid or expired verification code.");
      return res.redirect("/user/verify-sms-otp");
    }

    const breach = await hibpService.isPasswordPwned(password);
    if (breach.pwned) {
      req.flash("error", hibpService.PWNED_MESSAGE);
      return res.redirect("/user/verify-sms-otp");
    }

    const saltRounds = Number(process.env.BCRYPT_ROUNDS) || 12;
    user.password = await bcrypt.hash(password, saltRounds);
    user.smsResetOtp = null;
    user.smsResetExpires = null;
    await user.save();

    delete req.session.passwordResetPending;

    logger.info(`Password reset via SMS OTP for ${user.username}`);
    req.flash(
      "success",
      "Your password has been reset. You can now log in with your new password.",
    );
    return res.redirect("/user/login");
  } catch (err) {
    logger.error(`SMS OTP verify error: ${err.message}`);
    req.flash("error", "Failed to reset password. Please try again.");
    return res.redirect("/user/forgot-password");
  }
};

// ── TOTP reset — render form ────────────────────────────────────
export const renderVerifyTotpReset = (req, res) => {
  if (!req.session.passwordResetPending) {
    req.flash("error", "Session expired. Please try again.");
    return res.redirect("/user/forgot-password");
  }
  res.render(path.join("tailwindcss", "user", "verify-totp-reset"), {
    title: "Authenticator Verification",
  });
};

// ── TOTP reset — verify code and reset password ──────────────────────
export const verifyTotpReset = async (req, res) => {
  const pending = req.session.passwordResetPending;
  if (!pending) {
    req.flash("error", "Session expired. Please try again.");
    return res.redirect("/user/forgot-password");
  }

  const { totpToken, password, confirmPassword } = req.body;

  if (!totpToken || !/^\d{6}$/.test(totpToken.trim())) {
    req.flash("error", "Please enter the 6-digit code from your authenticator app.");
    return res.redirect("/user/verify-totp-reset");
  }

  if (!password || password.length < 6) {
    req.flash("error", "Password must be at least 6 characters.");
    return res.redirect("/user/verify-totp-reset");
  }

  if (password !== confirmPassword) {
    req.flash("error", "Passwords do not match.");
    return res.redirect("/user/verify-totp-reset");
  }

  try {
    const user = await mdb.INTERNAL.user.findById(pending.userId);

    if (!user || !user.totpEnabled || !user.totpSecret) {
      req.flash("error", "Authenticator verification unavailable.");
      return res.redirect("/user/forgot-password");
    }

    // totpSecret getter auto-decrypts, but we need the raw decrypted value for verification
    const decryptedSecret = encryptionService.decrypt(user.totpSecret);

    const isValid = totpService.verifyTOTP(decryptedSecret, totpToken);

    if (!isValid) {
      req.flash("error", "Invalid authenticator code. Please try again.");
      return res.redirect("/user/verify-totp-reset");
    }

    const breach = await hibpService.isPasswordPwned(password);
    if (breach.pwned) {
      req.flash("error", hibpService.PWNED_MESSAGE);
      return res.redirect("/user/verify-totp-reset");
    }

    const saltRounds = Number(process.env.BCRYPT_ROUNDS) || 12;
    user.password = await bcrypt.hash(password, saltRounds);
    await user.save();

    delete req.session.passwordResetPending;

    logger.info(`Password reset via TOTP for ${user.username}`);
    req.flash(
      "success",
      "Your password has been reset. You can now log in with your new password.",
    );
    return res.redirect("/user/login");
  } catch (err) {
    logger.error(`TOTP reset verify error: ${err.message}`);
    req.flash("error", "Failed to reset password. Please try again.");
    return res.redirect("/user/forgot-password");
  }
};

export default { renderRegistrationForm, registerUser, renderLoginForm, loginUser, logoutUser, verifyEmail, renderVerifyPending, resendVerification, renderForgotPasswordForm, sendPasswordReset, renderChooseResetMethod, dispatchResetMethod, renderResetPasswordForm, resetPassword, renderVerifySmsOtp, verifySmsOtp, renderVerifyTotpReset, verifyTotpReset };
