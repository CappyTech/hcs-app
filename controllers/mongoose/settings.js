const express = require('express');
const router = express.Router();
const logger = require('../../services/loggerService');
const path = require('path');
const mdb = require('../../services/mongoose/mongooseDatabaseService');
const authService = require('../../services/authService');
const encryptionService = require('../../services/encryptionService');
const totpService = require('../../services/totpService');
const { validationResult, body } = require('express-validator');
const moment = require('moment');
const bcrypt = require('bcrypt');

// GET /user/profile
const getProfilePage = async (req, res) => {
  try {
    const user = await mdb.user.findById(req.session.user.id);
    const employee = user.employeeId ? await mdb.employee.findById(user.employeeId) : null;
    const subcontractor = user.subcontractorId ? await mdb.subcontractor.findById(user.subcontractorId) : null;
    const client = user.clientId ? await mdb.client.findById(user.clientId) : null;

    res.render(path.join('user', 'profile'), {
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

// GET /user/account
const getAccountPage = async (req, res, next) => {
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

    const sessions = await mdb.session.find({
      'session.user.id': req.session.user.id
    });

    const activeSessions = sessions.map(session => {
      const sessionData = session.session.user || {};
      return {
        sessionId: session.sid,
        username: sessionData.username,
        email: sessionData.email,
        role: sessionData.role,
        ip: sessionData.ip,
        browser: sessionData.userAgent?.browser || 'Unknown',
        version: sessionData.userAgent?.version || 'Unknown',
        platform: sessionData.userAgent?.os || 'Unknown OS',
        loginTime: sessionData.loginTime || 'Unknown',
        expires: moment(session.expires),
        timeUntilExpiry: moment(session.expires).fromNow(),
      };
    });

    res.render(path.join('user', 'account'), {
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

// POST /user/account/settings
const updateAccountSettings = async (req, res) => {
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

// POST /user/account/logout-session
const logoutSession = async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      req.flash('error', 'Session ID is required.');
      return res.redirect('/user/account/');
    }

    await mdb.session.deleteOne({ sid: sessionId });

    logger.info(`Session ${sessionId} logged out successfully`);
    req.flash('success', 'Session logged out successfully.');
    res.redirect('/user/account/');
  } catch (error) {
    logger.error(`Error logging out session: ${error.message}`);
    req.flash('error', 'Error logging out session.');
    res.redirect('/user/account/');
  }
};

// POST /user/account/change-password
router.post(
  '/user/account/change-password',
  [
    body('currentPassword').notEmpty().withMessage('Current password is required'),
    body('newPassword').isLength({ min: 8 }).withMessage('New password must be at least 8 characters'),
    body('confirmNewPassword').custom((value, { req }) => value === req.body.newPassword).withMessage('Passwords do not match')
  ],
  authService.ensureAuthenticated,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array().map(error => error.msg).join('. '));
      return res.redirect('/user/account/change-password');
    }

    try {
      const user = await mdb.user.findById(req.session.user.id);
      if (!user) {
        req.flash('error', 'User not found');
        return res.redirect('/user/account/change-password');
      }

      const isMatch = await bcrypt.compare(req.body.currentPassword, user.password);
      if (!isMatch) {
        req.flash('error', 'Current password is incorrect');
        return res.redirect('/user/account/change-password');
      }

      user.password = await bcrypt.hash(req.body.newPassword, 10);
      await user.save();

      logger.info(`Password changed for user ID ${user.id}`);
      req.flash('success', 'Password updated successfully');
      res.redirect('/user/account');
    } catch (error) {
      logger.error('Error changing password: ' + error.message);
      req.flash('error', 'An error occurred while updating the password');
      res.redirect('/user/account/change-password');
    }
  }
);

// Validation middleware
const validateAccountSettings = [
    body('newUsername').notEmpty().withMessage('Username is required.'),
    body('newEmail').isEmail().withMessage('Invalid email address.'),
];

// Routes
router.get('/profile', authService.ensureAuthenticated, getProfilePage);
router.get('/account', authService.ensureAuthenticated, getAccountPage);
router.post('/account/settings', authService.ensureAuthenticated, validateAccountSettings, updateAccountSettings);
router.post('/account/logout-session', authService.ensureAuthenticated, logoutSession);

module.exports = router;
