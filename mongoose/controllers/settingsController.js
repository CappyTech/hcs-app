const mongoose = require('mongoose');
const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');
const moment = require('moment-timezone');
const bcrypt = require('bcrypt');
const encryptionService = require('../../services/encryptionService');
const speakeasy = require('speakeasy');
const totpService = require('../../services/totpService');
const rbac = require('../config/rolePermissionsConfig');
const { validationResult, body } = require('express-validator');

exports.getProfilePage = async (req, res, next) => {
  try {
    const user = await mdb.INTERNAL.user.findById(req.session.user.id);
    const employee = user.employeeId ? await mdb.INTERNAL.employee.findById(user.employeeId) : null;
    const subcontractor = user.subcontractorId ? await mdb.REST.supplier.findById(user.subcontractorId) : null;
    const client = user.clientId ? await mdb.REST.customer.findById(user.clientId) : null;

    // Build permissions summary for the user's role
    const role = user.role || 'none';
    const departments = rbac.getDepartmentsForRole(role);
    const modelAccess = rbac.roleModelAccess[role] || {};

    // Build a structured permissions object for the template
    const permissions = {
      role,
      departments,
      models: Object.entries(modelAccess).map(([model, perms]) => {
        const ops = perms.split(',').map(e => e.trim());
        return {
          model: model.charAt(0).toUpperCase() + model.slice(1),
          operations: ops.map(op => {
            const [code, scope] = op.split(':');
            const labels = { c: 'Create', r: 'Read', u: 'Update', d: 'Delete', l: 'List' };
            return { label: labels[code] || code, ownOnly: scope === 'own' };
          }),
        };
      }),
      customRoutes: Object.entries(rbac.routeAccess)
        .filter(([, roles]) => roles === '*' || (Array.isArray(roles) && roles.includes(role)))
        .map(([route]) => route),
    };

    // Fetch last login time from the most recent session
    let lastLoginTime = null;
    try {
      const lastSession = await mdb.INTERNAL.session.findOne({ userId: user._id.toString() }).sort({ loginTime: -1 }).lean();
      if (lastSession && lastSession.loginTime) {
        lastLoginTime = lastSession.loginTime;
      }
    } catch (e) {
      logger.warn(`Could not fetch last login time: ${e.message}`);
    }

    res.render(path.join('tailwindcss', 'user', 'profile'), {
      title: 'Profile',
      user,
      employee,
      subcontractor,
      client,
      permissions,
      lastLoginTime,
    });
  } catch (error) {
    logger.error(`Error loading profile: ${error.message}`);
    req.flash('error', 'Failed to load profile.');
    res.redirect('/');
  }
};

exports.getAccountPage = async (req, res, next) => {
  try {
    const user = await mdb.INTERNAL.user.findById(req.session.user.id);
    if (!user) {
      req.flash('error', 'User not found');
      return next();
    }

    const secret = user.totpSecret
      ? encryptionService.decrypt(user.totpSecret)
      : await totpService.generateTOTPSecret(user);

    const qrCodeUrl = await totpService.generateQRCode(secret, user);

    logger.info(`[SESSION DEBUG] getAccountPage userId=${req.session.user.id} attempting session backfill for sid=${req.sessionID}`);
    try {
      const backfill = await mdb.INTERNAL.session.updateOne({ _id: req.sessionID, userId: { $exists: false } }, { $set: { userId: req.session.user.id } });
      if (backfill.modifiedCount) {
        logger.info(`[SESSION DEBUG] Backfilled userId on current session sid=${req.sessionID}`);
      }
    } catch (e) {
      logger.warn('[SESSION DEBUG] Backfill error: ' + e.message);
    }

    // Query sessions belonging to this user (via denormalized userId)
    let rawSessions = await mdb.INTERNAL.session.find({ userId: req.session.user.id }).lean();
    logger.info(`[SESSION DEBUG] primary query returned ${rawSessions.length} sessions for userId`);
    // Fallback: legacy sessions without userId (parse JSON and filter)
    if (rawSessions.length === 0) {
      const legacyCandidates = await mdb.INTERNAL.session.find({ userId: { $exists: false } }).lean();
      rawSessions = legacyCandidates.filter(doc => {
        let payload = doc.session;
        if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = {}; } }
        return payload?.user?.id === req.session.user.id;
      });
      logger.info(`[SESSION DEBUG] legacy fallback yielded ${rawSessions.length} sessions (candidates scanned=${legacyCandidates.length})`);
    }

    const activeSessions = [];
    const currentSid = req.sessionID;
    for (const doc of rawSessions) {
      const expiresMoment = moment(doc.expires);
      // Purge if expired
      if (expiresMoment.isBefore(moment())) {
        await mdb.INTERNAL.session.deleteOne({ _id: doc._id });
        continue;
      }
      const isCurrent = doc._id === currentSid;
      activeSessions.push({
        sessionId: doc._id,
        username: doc.username || '—',
        email: doc.email || '—',
        role: doc.role || '—',
        ip: doc.ip || '—',
        browser: doc.uaBrowser || 'Unknown',
        version: doc.uaVersion || 'Unknown',
        platform: doc.uaOS || 'Unknown OS',
        loginTime: doc.loginTime || null,
        lastActivity: doc.lastActivity || doc.loginTime || null,
        idleFor: doc.lastActivity ? moment(doc.lastActivity).fromNow() : '—',
        expires: expiresMoment,
        timeUntilExpiry: expiresMoment.fromNow(),
        secure: true,
        isCurrent,
      });
    }

    res.render(path.join('tailwindcss', 'user', 'account'), {
      title: 'Account Settings',
      qrCodeUrl,
      secret,
      user,
      sessions: activeSessions,
      currentSessionId: currentSid,
    });

  } catch (error) {
    logger.error(`Error setting up TOTP for user ${req.session.user.id}: ${error.message}`);
    req.flash('error', 'An error occurred during TOTP setup.');
    next(error);
  }
};

exports.updateAccountSettings = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    req.flash('error', errors.array().map(error => error.msg).join('. '));
    return res.redirect('/user/account');
  }

  try {
    const user = await mdb.INTERNAL.user.findById(req.session.user.id);
    if (!user) {
      req.flash('error', 'User not found');
      return res.redirect('/user/account');
    }

    user.username = req.body.newUsername;
    user.email = req.body.newEmail;

    await user.save();

    req.flash('success', 'Account settings updated successfully');
    res.redirect('/user/account');
  } catch (error) {
    logger.error(`Error updating account settings: ${error.message}`);
    req.flash('error', 'Failed to update account settings');
    res.redirect('/user/account');
  }
};

exports.logoutSession = async (req, res, next) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      req.flash('error', 'Session ID is required.');
      return res.redirect('/user/account/');
    }

    // Verify the session belongs to the requesting user
    const session = await mdb.INTERNAL.session.findOne({ _id: sessionId }).lean();
    if (!session) {
      req.flash('error', 'Session not found.');
      return res.redirect('/user/account/');
    }

    // Check ownership via denormalized userId or parsed session payload
    let ownsSession = false;
    if (session.userId) {
      ownsSession = session.userId === req.session.user.id;
    } else if (session.session) {
      let payload = session.session;
      if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = {}; } }
      ownsSession = payload?.user?.id === req.session.user.id;
    }

    if (!ownsSession) {
      req.flash('error', 'You can only log out your own sessions.');
      return res.redirect('/user/account/');
    }

    await mdb.INTERNAL.session.deleteOne({ _id: sessionId });

    logger.info(`Session ${sessionId} logged out successfully by user ${req.session.user.id}`);
    req.flash('success', 'Session logged out successfully.');
    res.redirect('/user/account/');
  } catch (error) {
    logger.error(`Error logging out session: ${error.message}`);
    req.flash('error', 'Error logging out session.');
    res.redirect('/user/account/');
  }
};

exports.changePassword = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    req.flash('error', errors.array().map(error => error.msg).join('. '));
    return res.redirect('/user/account');
  }

  try {
    const user = await mdb.INTERNAL.user.findById(req.session.user.id);
    if (!user) {
      req.flash('error', 'User not found');
      return res.redirect('/user/account');
    }

    // Verify current password
    const isMatch = await bcrypt.compare(req.body.currentPassword, user.password);
    if (!isMatch) {
      req.flash('error', 'Current password is incorrect.');
      return res.redirect('/user/account');
    }

    // Check new passwords match
    if (req.body.newPassword !== req.body.confirmNewPassword) {
      req.flash('error', 'New passwords do not match.');
      return res.redirect('/user/account');
    }

    // Set new password (pre-save hook will hash it)
    user.password = req.body.newPassword;
    await user.save();

    logger.info(`Password changed successfully for user ${req.session.user.id}`);
    req.flash('success', 'Password changed successfully.');
    res.redirect('/user/account');
  } catch (error) {
    logger.error(`Error changing password: ${error.message}`);
    req.flash('error', 'Failed to change password.');
    res.redirect('/user/account');
  }
};

exports.verifyAndEnableTotp = async (req, res) => {
  try {
    const { totpToken } = req.body;
    if (!totpToken || totpToken.length !== 6) {
      req.flash('error', 'Please enter a valid 6-digit authentication code.');
      return res.redirect('/user/account');
    }

    const user = await mdb.INTERNAL.user.findById(req.session.user.id);
    if (!user || !user.totpSecret) {
      req.flash('error', 'User not found or TOTP not configured.');
      return res.redirect('/user/account');
    }

    const decryptedSecret = encryptionService.decrypt(user.totpSecret);

    const isValid = speakeasy.totp.verify({
      secret: decryptedSecret,
      encoding: 'base32',
      token: totpToken,
      window: 1,
    });

    if (!isValid) {
      req.flash('error', 'Invalid authentication code. Please try again.');
      return res.redirect('/user/account');
    }

    user.totpEnabled = true;
    await user.save();

    logger.info(`TOTP enabled for user ${req.session.user.id}`);
    req.flash('success', 'Two-Factor Authentication has been enabled successfully.');
    res.redirect('/user/account');
  } catch (error) {
    logger.error(`Error enabling TOTP: ${error.message}`);
    req.flash('error', 'Failed to enable Two-Factor Authentication.');
    res.redirect('/user/account');
  }
};

exports.disableTotp = async (req, res) => {
  try {
    const user = await mdb.INTERNAL.user.findById(req.session.user.id);
    if (!user) {
      req.flash('error', 'User not found');
      return res.redirect('/user/account');
    }

    user.totpEnabled = false;
    user.totpSecret = undefined;
    await user.save();

    logger.info(`TOTP disabled for user ${req.session.user.id}`);
    req.flash('success', 'Two-Factor Authentication has been disabled.');
    res.redirect('/user/account');
  } catch (error) {
    logger.error(`Error disabling TOTP: ${error.message}`);
    req.flash('error', 'Failed to disable Two-Factor Authentication.');
    res.redirect('/user/account');
  }
};

exports.validateAccountSettings = [
  body('newUsername').notEmpty().withMessage('Username is required.'),
  body('newEmail').isEmail().withMessage('Invalid email address.'),
];

exports.validateChangePassword = [
  body('currentPassword').notEmpty().withMessage('Current password is required.'),
  body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters.'),
  body('confirmNewPassword').notEmpty().withMessage('Password confirmation is required.'),
];
