const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');
const axios = require('axios');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { getClientIp } = require('../../services/ipService');
const emailService = require('../../services/emailService');

function hasCookie(req, cookieName) {
  try {
    const header = String((req.headers && req.headers.cookie) || '');
    if (!header) return false;
    return header.split(';').some(part => part.trim().startsWith(`${cookieName}=`));
  } catch (_) {
    return false;
  }
}

function maskId(value) {
  try {
    const v = String(value || '');
    if (!v) return '-';
    if (v.length <= 10) return `${v.slice(0, 2)}…${v.slice(-2)}`;
    return `${v.slice(0, 6)}…${v.slice(-4)}`;
  } catch (_) {
    return '-';
  }
}

function maskIdentifier(value) {
  try {
    const v = String(value || '').trim();
    if (!v) return '-';
    if (v.length <= 3) return `${v[0]}…`;
    return `${v.slice(0, 2)}…${v.slice(-1)}`;
  } catch (_) {
    return '-';
  }
}

function getSafeNext(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  if (v.length > 2000) return null;
  if (v.includes('\n') || v.includes('\r')) return null;

  // Only allow internal relative paths to prevent open redirects.
  // Disallow protocol-relative (//evil.com) and backslashes.
  if (!v.startsWith('/')) return null;
  if (v.startsWith('//')) return null;
  if (v.includes('\\')) return null;
  // Check only the path portion (before ?) for :// so that query params
  // like ?return_to=https://sync.heroncs.co.uk are not rejected.
  const pathPart = v.split('?')[0];
  if (pathPart.includes('://')) return null;
  return v;
}

exports.renderRegistrationForm = (req, res, next) => {
    res.render(path.join('mongoose', 'user', 'register'), {
        title: 'Register',
        siteKey: process.env.TURNSTILE_SITE_KEY,
    });
};

exports.registerUser = async (req, res, next) => {
    try {
        const { username, email, password } = req.body;
        const token = req.body['cf-turnstile-response'];
        const ip = req.ip;

        if (!token) {
            logger.error('CAPTCHA verification failed (token missing).');
            req.flash('error', 'CAPTCHA verification failed (token missing).');
            return res.redirect('/user/register');
        }

        const verifyResponse = await axios.post(
            'https://challenges.cloudflare.com/turnstile/v0/siteverify',
            new URLSearchParams({
                secret: process.env.TURNSTILE_SECRET_KEY,
                response: token,
                remoteip: ip
            })
        );

        if (!verifyResponse.data.success) {
            logger.error('CAPTCHA verification failed.');
            req.flash('error', 'CAPTCHA verification failed.');
            return res.redirect('/user/register');
        }

        const existingUser = await mdb.INTERNAL.user.findOne({
            $or: [{ username }, { email }]
        });

        if (existingUser) {
            logger.error('Username or email already exists');
            req.flash('error', 'Username or email already exists');
            return res.redirect('/user/register');
        }

    // Role is always the safe default — only admins can change roles via user CRUD update
    const assignedRole = 'none';
    const UserModel = mdb.INTERNAL?.user;
    if(!UserModel){
      logger.error('User model not loaded (INTERNAL.user missing)');
      req.flash('error', 'User model unavailable. Please try again later.');
      return res.redirect('/user/register');
    }
    // Hash password before storing (was previously stored in plaintext)
    const saltRounds = Number(process.env.BCRYPT_ROUNDS) || 12;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Generate email verification token (URL-safe, 48 bytes → 64 chars hex)
    const verificationToken = crypto.randomBytes(48).toString('hex');
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
          logger.error(`Failed to send verification email to ${email}: ${emailErr.message}`);
        }

        logger.info('New User Created.');
        req.flash('success', 'Account created! Please check your email to verify your account before logging in.');
        return res.redirect('/user/login');

    } catch (error) {
        logger.error('Error registering user: ' + error.message);
        req.flash('error', 'Error registering user: ' + error.message);
        return res.redirect('/user/register');
    }
};

exports.renderLoginForm = (req, res) => {
  // Render TailwindCSS version of login template
  const next = getSafeNext(req.query?.next);
  res.render(path.join('tailwindcss', 'user', 'login'), {
    title: 'Log In',
    siteKey: process.env.TURNSTILE_SITE_KEY,
    next,
  });
};

exports.loginUser = async (req, res) => {
  try {
    const next = getSafeNext(req.body?.next || req.query?.next);
    const { usernameOrEmail, password } = req.body;
    const token = req.body['cf-turnstile-response'];
    const ip = getClientIp(req);
    const agent = req.useragent || {};
    const skipCaptcha = process.env.SKIP_TURNSTILE === 'true';

    logger.info(
      `[login attempt] ident=${maskIdentifier(usernameOrEmail)} isEmail=${String(usernameOrEmail || '').includes('@') ? 'Y' : 'N'} ` +
      `ip=${ip} sidCookie=${hasCookie(req, 'hms.sid') ? 'Y' : 'N'} sess=${maskId(req.sessionID)} ` +
      `secure=${req.secure ? 'Y' : 'N'} proto=${req.protocol} ua=${agent.browser || 'Unknown'}/${agent.os || 'Unknown'}`
    );

    if (!skipCaptcha && !token) {
      logger.info('Login rejected: CAPTCHA token missing');
      req.flash('error', 'CAPTCHA token missing.');
      return res.redirect('/user/login' + (next ? ('?next=' + encodeURIComponent(next)) : ''));
    }

    if (!skipCaptcha) {
      const verifyResponse = await axios.post(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        new URLSearchParams({
          secret: process.env.TURNSTILE_SECRET_KEY,
          response: token,
          remoteip: ip
        })
      );
      if (!verifyResponse.data.success) {
        logger.info('Login rejected: CAPTCHA verification failed');
        req.flash('error', 'CAPTCHA verification failed.');
        return res.redirect('/user/login' + (next ? ('?next=' + encodeURIComponent(next)) : ''));
      }
    } else {
      logger.info('Login CAPTCHA bypass active (SKIP_TURNSTILE=true)');
    }

    if (!usernameOrEmail || !password) {
      logger.info('Login rejected: missing credentials');
      req.flash('error', 'Username and password are required.');
      return res.redirect('/user/login' + (next ? ('?next=' + encodeURIComponent(next)) : ''));
    }

    const user = await mdb.INTERNAL.user.findOne({
      $or: [{ username: usernameOrEmail }, { email: usernameOrEmail }]
    });

    let authOk = false;
    if (!user) {
      logger.info(`Login rejected: user not found for identifier "${usernameOrEmail}"`);
      authOk = false;
    } else {
      const stored = user.password;
      const looksHashed = typeof stored === 'string' && stored.startsWith('$2');
      if (looksHashed) {
        authOk = await bcrypt.compare(password, stored);
        if (!authOk) logger.info(`Login rejected: bcrypt mismatch for user ${user.username}`);
      } else {
        // Legacy plaintext fallback: direct compare then upgrade to hashed
        if (password === stored) {
          try {
            const saltRounds = Number(process.env.BCRYPT_ROUNDS) || 12;
            user.password = await bcrypt.hash(stored, saltRounds);
            await user.save();
            authOk = true;
            logger.info(`Upgraded legacy plaintext password for user ${user.username}`);
          } catch (e) {
            logger.error(`Failed upgrading plaintext password for ${user.username}: ${e.message}`);
            authOk = false;
          }
        } else {
          logger.info(`Login rejected: plaintext mismatch for user ${user.username}`);
          authOk = false;
        }
      }
    }
    if (!authOk) {
      req.flash('error', 'Invalid username or password.');
      return res.redirect('/user/login' + (next ? ('?next=' + encodeURIComponent(next)) : ''));
    }

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
        browser: agent.browser || 'Unknown',
        version: agent.version || 'Unknown',
        os: agent.os || 'Unknown',
        platform: agent.platform || 'Unknown',
      },
    };

    // If TOTP is enabled, stage login for /user/2fa
    if (user.totpEnabled) {
      req.session.userPending2FA = sessionData;
      logger.info(`Login staged for 2FA: ${user.username}`);
      return res.redirect('/user/2fa');
    }

    req.session.user = sessionData;

    await new Promise((resolve, reject) => {
      req.session.save(err => (err ? reject(err) : resolve()));
    });

    logger.info(
      `${user.username} successfully logged in. ` +
      `sess=${maskId(req.sessionID)} sidCookieWas=${hasCookie(req, 'hms.sid') ? 'Y' : 'N'} sessionUser=${req.session?.user ? 'Y' : 'N'}`
    );
    req.flash('success', `${user.username}, you're logged in.`);
    return res.redirect(next || '/');

  } catch (error) {
    logger.error('Login error: ' + error.message);
    req.flash('error', 'Login failed. Please try again.');
    const next = getSafeNext(req.body?.next || req.query?.next);
    return res.redirect('/user/login' + (next ? ('?next=' + encodeURIComponent(next)) : ''));
  }
};

exports.logoutUser = (req, res) => {
  req.session.destroy(err => {
    if (err) {
      logger.error('Error logging out: ' + err.message);
      req.flash('error', 'An error occurred while logging out.');
      return res.redirect('/');
    }
    res.clearCookie('hms.sid');
    req.flash('success', 'You have been logged out.');
    return res.redirect('/user/login');
  });
};

// ── Email verification ───────────────────────────────────────────────
exports.verifyEmail = async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) {
      req.flash('error', 'Invalid verification link.');
      return res.redirect('/user/login');
    }

    const user = await mdb.INTERNAL.user.findOne({
      emailVerificationToken: token,
      emailVerificationExpires: { $gt: new Date() },
    });

    if (!user) {
      req.flash('error', 'Verification link is invalid or has expired.');
      return res.redirect('/user/login');
    }

    user.emailVerified = true;
    user.emailVerificationToken = null;
    user.emailVerificationExpires = null;
    await user.save();

    logger.info(`Email verified for user: ${user.username}`);
    req.flash('success', 'Email verified successfully! You can now log in.');
    return res.redirect('/user/login');
  } catch (err) {
    logger.error(`Email verification error: ${err.message}`);
    req.flash('error', 'Verification failed. Please try again.');
    return res.redirect('/user/login');
  }
};

// ── Render verification-pending page ─────────────────────────────────
exports.renderVerifyPending = (req, res) => {
  res.render(path.join('tailwindcss', 'user', 'verify-pending'), {
    title: 'Email Verification Required',
    email: req.user?.email || req.session?.user?.email || '',
  });
};

// ── Resend verification email ────────────────────────────────────────
exports.resendVerification = async (req, res) => {
  try {
    const userId = req.user?._id || req.session?.user?.id;
    if (!userId) {
      req.flash('error', 'Please log in first.');
      return res.redirect('/user/login');
    }

    const user = await mdb.INTERNAL.user.findById(userId);
    if (!user) {
      req.flash('error', 'User not found.');
      return res.redirect('/user/login');
    }

    if (user.emailVerified) {
      req.flash('success', 'Your email is already verified.');
      return res.redirect('/');
    }

    // Rate limit: only allow resend if token expired or > 2 min since last
    if (user.emailVerificationExpires && user.emailVerificationExpires > new Date()) {
      const tokenAge = Date.now() - (user.emailVerificationExpires.getTime() - 24 * 60 * 60 * 1000);
      if (tokenAge < 2 * 60 * 1000) {
        req.flash('error', 'Please wait a couple of minutes before requesting another email.');
        return res.redirect('/user/verify-pending');
      }
    }

    // Generate new token
    const verificationToken = crypto.randomBytes(48).toString('hex');
    user.emailVerificationToken = verificationToken;
    user.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await user.save();

    await emailService.sendVerificationEmail(user.email, verificationToken);

    logger.info(`Verification email resent to ${user.email}`);
    req.flash('success', 'Verification email sent! Check your inbox.');
    return res.redirect('/user/verify-pending');
  } catch (err) {
    logger.error(`Resend verification error: ${err.message}`);
    req.flash('error', 'Failed to resend verification email.');
    return res.redirect('/user/verify-pending');
  }
};