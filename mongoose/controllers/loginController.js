const axios = require('axios');
const bcrypt = require('bcrypt');
const path = require('path');
const jwt = require('jsonwebtoken');
const logger = require('../../services/loggerService');
const mdb = require('../../services/mongoose/mongooseDatabaseService');
const generateToken = require('../../services/generateTokenService');

exports.renderLoginForm = (req, res) => {
  res.render(path.join('mongoose', 'login'), {
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

    const payload = {
      userId: user._id.toString(),
      username: user.username,
      email: user.email,
      role: user.role,
      permissions: user.permissions || {},
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
      const pendingToken = generateToken(payload, '5m');
      res.cookie('pending2FA', pendingToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Strict',
        maxAge: 1000 * 60 * 5
      });
      return res.redirect('/user/2fa');
    }

    const authToken = generateToken(payload, '8h');
    res.cookie('token', authToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Strict',
      maxAge: 1000 * 60 * 60 * 8
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
  res.clearCookie('token');
  res.clearCookie('pending2FA');
  req.flash('success', 'You have been logged out.');
  return res.redirect('/user/login');
};
