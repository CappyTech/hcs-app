const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');
const axios = require('axios');
const bcrypt = require('bcrypt');

exports.renderRegistrationForm = (req, res, next) => {
    res.render(path.join('tailwindcss', 'user', 'register'), {
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

        const existingUser = await mdb.user.findOne({
            $or: [{ username }, { email }]
        });

        if (existingUser) {
            logger.error('Username or email already exists');
            req.flash('error', 'Username or email already exists');
            return res.redirect('/user/register');
        }

        const assignedRole = role || 'subcontractor';
        const newUser = new mdb.user({
            username,
            email,
            password,
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

    if (!token) {
      req.flash('error', 'CAPTCHA token missing.');
      return res.redirect('/user/login');
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
      req.flash('error', 'CAPTCHA verification failed.');
      return res.redirect('/user/login');
    }

    if (!usernameOrEmail || !password) {
      req.flash('error', 'Username and password are required.');
      return res.redirect('/user/login');
    }

    const user = await mdb.user.findOne({
      $or: [{ username: usernameOrEmail }, { email: usernameOrEmail }]
    });

    if (!user || !(await bcrypt.compare(password, user.password))) {
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
      return res.redirect('/user/2fa');
    }

    // Prevent session fixation: regenerate before setting authenticated identity
    await new Promise((resolve, reject) => {
      req.session.regenerate(err => (err ? reject(err) : resolve()));
    });
    req.session.user = sessionData;
    await new Promise((resolve, reject) => {
      req.session.save(err => (err ? reject(err) : resolve()));
    });

    // Persist denormalized user fields on session document for efficient lookup (no need to parse/ decrypt session blob)
    try {
      if (mdb.session) {
        const update = await mdb.session.updateOne(
          { _id: req.sessionID },
          { $set: {
              userId: sessionData.id,
              username: sessionData.username,
              email: sessionData.email,
              role: sessionData.role,
              ip: sessionData.ip,
              uaBrowser: sessionData.userAgent.browser,
              uaVersion: sessionData.userAgent.version,
              uaOS: sessionData.userAgent.os,
              loginTime: new Date(sessionData.loginTime)
            }
          },
          { upsert: true }
        );
        logger.info(`[SESSION DENORM LOGIN] matched=${update.matchedCount} modified=${update.modifiedCount} upserted=${update.upsertedCount||0} sid=${req.sessionID}`);
      }
    } catch (_) { /* non-fatal */ }

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
    res.clearCookie('hms.sid');
    req.flash('success', 'You have been logged out.');
    return res.redirect('/user/login');
  });
};