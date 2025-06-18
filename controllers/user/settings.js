const express = require('express');
const router = express.Router();
const logger = require('../../services/loggerService');
const path = require('path');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const db = require('../../services/sequelizeDatabaseService');
const authService = require('../../services/authService');
const encryptionService = require('../../services/encryptionService');
const totpService = require('../../services/totpService');
const { validationResult, body } = require('express-validator');
const moment = require('moment');
const bcrypt = require('bcrypt');

const sessionStore = new MySQLStore({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    clearExpired: true,
    checkExpirationInterval: 300000,
    expiration: 28800000,
    createDatabaseTable: true,
    endConnectionOnClose: true,
    disableTouch: false,
    charset: 'utf8mb4_bin',
    schema: {
        tableName: 'sessions',
        columnNames: {
            session_id: 'session_id',
            expires: 'expires',
            data: 'data',
        },
    },
});

const getProfilePage = async (req,res) => {
    try {
        const user = await db.Users.findOne({ where: { id: req.session.user.id } });
        const employee = await db.Employees.findOne({ where: { id: user.employeeId } });
        const subcontractor = await db.Subcontractors.findOne({ where: { id: user.subcontractorId } });
        const client = await db.Clients.findOne({ where: { id: user.clientId } });

        res.render(path.join('user', 'profile'), {
            title: 'Profile',
            user,
            employee: employee || null,
            subcontractor: subcontractor || null,
            client: client || null,
        });
    } catch (error) {
        
    }
}

// Display the account page
const getAccountPage = async (req, res, next) => {
    try {
        const user = await db.Users.findOne({ where: { id: req.session.user.id } });
        if (!user) {
            req.flash('error', 'User not found');
            next(error); // Pass the error to the error handler
        }

        // Retrieve or generate TOTP secret
        let secret;
        
        if (!user.totpSecret) {
            secret = await totpService.generateTOTPSecret(user);
        } else {
            secret = encryptionService.decrypt(user.totpSecret);
            logger.info(`Using existing decrypted TOTP Secret for user ${user.id}`);
        }

        // Generate QR Code
        const qrCodeUrl = await totpService.generateQRCode(secret, user);

        // Query sessions related to the current user
        const sessions = await db.Session.findAll({
            where: {
                data: {
                    [db.Sequelize.Op.like]: `%${req.session.user.id}%`,
                },
            },
        });

        const activeSessions = sessions.map((session) => {
            try {
                const sessionData = JSON.parse(session.data);
        
                return {
                    sessionId: session.session_id,
                    username: sessionData.user?.username || 'Unknown',
                    email: sessionData.user?.email || 'Unknown',
                    role: sessionData.user?.role || 'Unknown',
                    ip: sessionData.user?.ip || 'N/A',
                    browser: sessionData.user?.userAgent?.browser || 'Unknown',
                    version: sessionData.user?.userAgent?.version || 'Unknown',
                    platform: sessionData.user?.userAgent?.os || 'Unknown OS',
                    mobile: sessionData.user?.userAgent?.mobile || 'No',
                    loginTime: sessionData.user?.loginTime || 'Unknown',
                    expires: moment(session.expires * 1000),
                    timeUntilExpiry: moment(session.expires * 1000).fromNow(),
                };
            } catch (error) {
                logger.error(`Error parsing session data for session ID ${session.session_id}: ${error.message}`);
                return null;
            }
        }).filter(Boolean);
        

        // Render the account page
        res.render(path.join('user', 'account'), {
            title: 'Set up Two-Factor Authentication',
            qrCodeUrl,
            secret, // For manual input
            user,
            sessions: activeSessions,
        });
    } catch (error) {
        logger.error(`Error setting up TOTP for user ${req.session.user.id}: ${error.message}`);
        req.flash('error', 'An error occurred during TOTP setup.');
        next(error); // Pass the error to the error handler
    }
};

// Update the account settings
const updateAccountSettings = async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        req.flash('error', errors.array().map(error => error.msg).join('. '));
        return res.redirect('/user/account');
    }

    try {
        const user = await db.Users.findOne({ where: { id: req.session.user.id } });

        if (!user) {
            req.flash('error', 'User not found');
            return res.redirect('/user/account');
        }

        // Update basic account details
        user.username = req.body.newUsername;
        user.email = req.body.newEmail;

        await user.save();

        logger.info('Account settings updated successfully');
        req.flash('success', 'Account settings updated successfully');
        res.redirect('/user/account');
    } catch (error) {
        logger.error(`Error updating account settings: ${error.message}`);
        req.flash('error', 'Failed to update account settings');
        res.redirect('/user/account');
    }
};

// Logout a specific session
const logoutSession = async (req, res, next) => {
    try {
        const { sessionId } = req.body;

        if (!sessionId) {
            req.flash('error', 'Session ID is required.');
            return res.redirect('/user/account/');
        }

        // Remove the specific session from the store
        sessionStore.destroy(sessionId, (error) => {
            if (error) {
                logger.error(`Error destroying session: ${error.message}`);
                req.flash('error', 'Failed to log out session.');
                return res.redirect('/user/account/');
            }

            logger.info(`Session ${sessionId} logged out successfully`);
            req.flash('success', 'Session logged out successfully.');
            res.redirect('/user/account/');
        });
    } catch (error) {
        logger.error(`Error logging out session: ${error.message}`);
        req.flash('error', 'Error logging out session.');
        res.redirect('/user/account/');
    }
};

// Validation middleware
const validateAccountSettings = [
    body('newUsername').notEmpty().withMessage('Username is required.'),
    body('newEmail').isEmail().withMessage('Invalid email address.'),
];

// Route for change password
router.post(
    '/user/account/change-password',
    [
      body('currentPassword').notEmpty().withMessage('Current password is required'),
      body('newPassword')
        .isLength({ min: 8 })
        .withMessage('New password must be at least 8 characters long'),
      body('confirmNewPassword')
        .custom((value, { req }) => value === req.body.newPassword)
        .withMessage('Passwords do not match'),
    ],
    
    async (req, res, next) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        req.flash('error', errors.array().map(error => error.msg).join('. '));
        return res.redirect('/user/account/change-password');
      }
  
      try {
        const { currentPassword, newPassword } = req.body;
        const userId = req.session.user.id;
  
        // Fetch the user from the database
        const user = await db.Users.findOne({ where: { id: userId } });
        if (!user) {
          req.flash('error', 'User not found');
          return res.redirect('/user/account/change-password');
        }
  
        // Check if the current password matches
        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) {
          req.flash('error', 'Current password is incorrect');
          return res.redirect('/user/account/change-password');
        }
  
        // Hash the new password
        const hashedPassword = await bcrypt.hash(newPassword, 10);
  
        // Update the password in the database
        user.password = hashedPassword;
        await user.save();
  
        logger.info(`Password changed for user ID ${userId}`);
        req.flash('success', 'Password updated successfully');
        res.redirect('/user/account');
      } catch (error) {
        logger.error('Error changing password: ' + error.message);
        req.flash('error', 'An error occurred while updating the password');
        res.redirect('/user/account/change-password');
      }
    }
  );

// Define routes
router.get('/profile',  getProfilePage);
router.get('/account',  getAccountPage);
router.post('/account/settings',  validateAccountSettings, updateAccountSettings);
router.post('/account/logout-session',  logoutSession);

module.exports = router;
