const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');
const axios = require('axios');
const bcrypt = require('bcrypt');
const { getClientIp } = require('../../services/ipService');

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
    const assignedRole = 'subcontractor';
    const UserModel = mdb.INTERNAL?.user;
    if(!UserModel){
      logger.error('User model not loaded (INTERNAL.user missing)');
      req.flash('error', 'User model unavailable. Please try again later.');
      return res.redirect('/user/register');
    }
    // Hash password before storing (was previously stored in plaintext)
    const saltRounds = Number(process.env.BCRYPT_ROUNDS) || 12;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    const newUser = new UserModel({
      username,
      email,
      password: hashedPassword,
      role: assignedRole,
    });

        await newUser.save();

        logger.info('New User Created.');
        req.flash('success', 'Account created. You can now log in.');
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