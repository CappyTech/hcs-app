const path = require('path');
const speakeasy = require('speakeasy');
const logger = require('../../services/loggerService');
const mdb = require('../../services/mongoose/mongooseDatabaseService');
const encryptionService = require('../../services/encryptionService');

exports.render2FAPage = (req, res) => {
  if (!req.session.userPending2FA) {
    req.flash('error', '2FA session expired. Please log in again.');
    return res.redirect('/user/login');
  }

  res.render(path.join('user', '2fa'), { title: 'Two-Factor Authentication' });
};

exports.verify2FA = async (req, res) => {
  try {
    const code = req.body.totpToken;
    const pending = req.session.userPending2FA;

    if (!pending) {
      req.flash('error', '2FA session missing. Please log in again.');
      return res.redirect('/user/login');
    }

    const user = await mdb.user.findOne({ uuid: pending.uuid });

    if (!user || !user.totpSecret) {
      req.flash('error', 'User not found or 2FA not enabled.');
      return res.redirect('/user/login');
    }

    const decryptedSecret = encryptionService.decrypt(user.totpSecret);

    const isValid = speakeasy.totp.verify({
      secret: decryptedSecret,
      encoding: 'base32',
      token: code,
      window: 1
    });

    if (!isValid) {
      req.flash('error', 'Invalid 2FA code. Please try again.');
      return res.redirect('/user/2fa');
    }

    const agent = req.useragent || {};
    const ip = req.ip;

    req.session.user = {
      id: user._id.toString(),
      uuid: user.uuid,
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

    delete req.session.userPending2FA;

    await new Promise((resolve, reject) => {
      req.session.save(err => (err ? reject(err) : resolve()));
    });

    req.flash('success', 'Successfully logged in.');
    return res.redirect('/');
  } catch (error) {
    logger.error('2FA verification error: ' + error.message);
    delete req.session.userPending2FA;
    req.flash('error', 'An error occurred during 2FA. Please log in again.');
    return res.redirect('/user/login');
  }
};
