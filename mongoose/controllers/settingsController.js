const mongoose = require('mongoose');
const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');
const moment = require('moment-timezone');
const encryptionService = require('../../services/encryptionService');
const totpService = require('../../services/totpService');
const { validationResult, body } = require('express-validator');

exports.getProfilePage = async (req, res, next) => {
  try {
    const user = await mdb.user.findById(req.session.user.id);
    const employee = user.employeeId ? await mdb.employee.findById(user.employeeId) : null;
    const subcontractor = user.subcontractorId ? await mdb.subcontractor.findById(user.subcontractorId) : null;
    const client = user.clientId ? await mdb.client.findById(user.clientId) : null;

    res.render(path.join('tailwindcss', 'user', 'profile'), {
      title: 'Profile',
      user,
      employee,
      subcontractor,
      client,
    });
  } catch (error) {
    logger.error(`Error loading profile: ${error.message}`);
    req.flash('error', 'Failed to load profile.');
    res.redirect('/');
  }
};

exports.getAccountPage = async (req, res, next) => {
  try {
    const user = await mdb.user.findById(req.session.user.id);
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
      const backfill = await mdb.session.updateOne({ _id: req.sessionID, userId: { $exists: false } }, { $set: { userId: req.session.user.id } });
      if (backfill.modifiedCount) {
        logger.info(`[SESSION DEBUG] Backfilled userId on current session sid=${req.sessionID}`);
      }
    } catch (e) {
      logger.warn('[SESSION DEBUG] Backfill error: ' + e.message);
    }

    // Query sessions belonging to this user (via denormalized userId)
    let rawSessions = await mdb.session.find({ userId: req.session.user.id }).lean();
    logger.info(`[SESSION DEBUG] primary query returned ${rawSessions.length} sessions for userId`);
    // Fallback: legacy sessions without userId (parse JSON and filter)
    if (rawSessions.length === 0) {
      const legacyCandidates = await mdb.session.find({ userId: { $exists: false } }).lean();
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
        await mdb.session.deleteOne({ _id: doc._id });
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
        secure: true, // session cookies configured secure in production; omit per-doc flag
        isCurrent,
      });
    }

    res.render(path.join('tailwindcss', 'user', 'account'), {
      title: 'Set up Two-Factor Authentication',
      qrCodeUrl,
      secret,
      user,
      sessions: activeSessions,
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
    const user = await mdb.user.findById(req.session.user.id);
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

    await mdb.session.deleteOne({ _id: sessionId });

    logger.info(`Session ${sessionId} logged out successfully`);
    req.flash('success', 'Session logged out successfully.');
    res.redirect('/user/account/');
  } catch (error) {
    logger.error(`Error logging out session: ${error.message}`);
    req.flash('error', 'Error logging out session.');
    res.redirect('/user/account/');
  }
};

exports.validateAccountSettings = [
  body('newUsername').notEmpty().withMessage('Username is required.'),
  body('newEmail').isEmail().withMessage('Invalid email address.'),
];
