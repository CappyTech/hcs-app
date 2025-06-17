const path = require('path');
const speakeasy = require('speakeasy');
const jwt = require('jsonwebtoken');
const logger = require('../../services/loggerService');
const mdb = require('../../services/mongoose/mongooseDatabaseService');
const encryptionService = require('../../services/encryptionService');
const generateToken = require('../../services/generateTokenService');

exports.render2FAPage = (req, res) => {
  const pendingToken = req.cookies.pending2FA;

  if (!pendingToken) {
    req.flash('error', '2FA session expired. Please log in again.');
    return res.redirect('/user/login');
  }

  try {
    const decoded = jwt.verify(pendingToken, process.env.JWT_SECRET);
    res.render(path.join('user', '2fa'), { title: 'Two-Factor Authentication' });
  } catch (err) {
    res.clearCookie('pending2FA');
    req.flash('error', '2FA token invalid or expired.');
    return res.redirect('/user/login');
  }
};

exports.verify2FA = async (req, res) => {
  try {
    const code = req.body.totpToken;
    const pendingToken = req.cookies.pending2FA;

    if (!pendingToken) {
      req.flash('error', '2FA session missing. Please log in again.');
      return res.redirect('/user/login');
    }

    const decoded = jwt.verify(pendingToken, process.env.JWT_SECRET);
    const user = await mdb.user.findOne({ uuid: decoded.uuid });

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

    const authToken = generateToken({
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
    }, '8h');

    res.clearCookie('pending2FA');

    res.cookie('token', authToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Strict',
      maxAge: 1000 * 60 * 60 * 8
    });

    req.flash('success', 'Successfully logged in.');
    return res.redirect('/');
  } catch (error) {
    logger.error('2FA verification error: ' + error.message);
    res.clearCookie('pending2FA');
    req.flash('error', 'An error occurred during 2FA. Please log in again.');
    return res.redirect('/user/login');
  }
};
