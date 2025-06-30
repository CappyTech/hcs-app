const mongoose = require('mongoose');
const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../services/loggerService');
const moment = require('moment-timezone');
const axios = require('axios');
const bcrypt = require('bcrypt');

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
