const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');
const axios = require('axios');
const bcrypt = require('bcrypt');

exports.renderRegistrationForm = (req, res, next) => {
    res.render(path.join('mongoose', 'user', 'register'), {
        title: 'Register',
        siteKey: process.env.TURNSTILE_SITE_KEY,
    });
};

exports.registerUser = async (req, res, next) => {
    try {
        const { username, email, password, role } = req.body;
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

    const assignedRole = role || 'subcontractor';
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
  res.render(path.join('tailwindcss', 'user', 'login'), {
    title: 'Log In',
    siteKey: process.env.TURNSTILE_SITE_KEY,
  });
};

exports.loginUser = async (req, res) => {
  try {
    const { usernameOrEmail, password } = req.body;
    const token = req.body['cf-turnstile-response'];
    const ip = req.ip;
    const agent = req.useragent || {};
    const skipCaptcha = process.env.SKIP_TURNSTILE === 'true';

    if (!skipCaptcha && !token) {
      logger.info('Login rejected: CAPTCHA token missing');
      req.flash('error', 'CAPTCHA token missing.');
      return res.redirect('/user/login');
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
        return res.redirect('/user/login');
      }
    } else {
      logger.info('Login CAPTCHA bypass active (SKIP_TURNSTILE=true)');
    }

    if (!usernameOrEmail || !password) {
      logger.info('Login rejected: missing credentials');
      req.flash('error', 'Username and password are required.');
      return res.redirect('/user/login');
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
      return res.redirect('/user/login');
    }

    const sessionData = {
      id: user._id.toString(),
      uuid: user.uuid,
      username: user.username,
      email: user.email,
      role: user.role,
      loginTime: new Date().toISOString(),
      ip,
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

    logger.info(`${user.username} successfully logged in.`);
    req.flash('success', `${user.username}, you're logged in.`);
    return res.redirect('/');

  } catch (error) {
    logger.error('Login error: ' + error.message);
    req.flash('error', 'Login failed. Please try again.');
    return res.redirect('/user/login');
  }
};

exports.logoutUser = (req, res) => {
  req.session.destroy(err => {
    if (err) {
      logger.error('Error logging out: ' + err.message);
      req.flash('error', 'An error occurred while logging out.');
      return res.redirect('/');
    }
    res.clearCookie('connect.sid');
    req.flash('success', 'You have been logged out.');
    return res.redirect('/user/login');
  });
};