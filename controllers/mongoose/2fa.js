const express = require('express');
const router = express.Router();
const path = require('path');
const speakeasy = require('speakeasy');
const logger = require('../../services/loggerService');
const mdb = require('../../services/mongoose/mongooseDatabaseService');
const encryptionService = require('../../services/encryptionService');

const render2FAPage = (req, res) => {
    if (!req.session.userPending2FA) {
        return res.redirect('/user/signin');
    }

    res.render(path.join('user', '2fa'), {
        title: 'Two-Factor Authentication',
    });
};

const verify2FA = async (req, res, next) => {
    try {
        const code = req.body.totpToken;

        // 🔒 1. Logged-in user enabling 2FA
        if (req.user && req.user.totpSecret) {
            const decryptedSecret = encryptionService.decrypt(req.user.totpSecret);

            const isValid = speakeasy.totp.verify({
                secret: decryptedSecret,
                encoding: 'base32',
                token: code,
                window: 1
            });

            if (isValid) {
                req.user.totpEnabled = true;
                await req.user.save();
                req.flash('success', 'Two-factor authentication enabled successfully.');
            } else {
                req.flash('error', 'Invalid 2FA code. Please try again.');
            }

            return res.redirect('/user/account');
        }

        // 🔒 2. Login-time 2FA check
        if (!req.session.userPending2FA) {
            req.flash('error', 'Invalid session. Please sign in again.');
            return res.redirect('/user/signin');
        }

        const user = await mdb.user.findOne({ uuid: req.session.userPending2FA.uuid });

        if (!user || !user.totpSecret) {
            req.flash('error', 'User or TOTP secret not found. Please sign in again.');
            return res.redirect('/user/signin');
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

        // ✅ Set authenticated session
        const agent = req.useragent || {};
        const ip = req.ip;

        req.session.user = {
            _id: user._id,
            uuid: user.uuid,
            username: user.username,
            email: user.email,
            role: user.role,
            permissions: user.permissions,
            loginTime: new Date().toISOString(),
            ip: ip,
            userAgent: {
                browser: agent.browser || 'Unknown',
                version: agent.version || 'Unknown',
                os: agent.os || 'Unknown',
                platform: agent.platform || 'Unknown',
            },
        };

        delete req.session.userPending2FA;

        req.session.save((error) => {
            if (error) {
                logger.error('Error saving session: ' + error.message);
                req.flash('error', 'An error occurred while logging in. Please try again.');
                return res.redirect('/user/signin');
            }

            req.flash('success', 'Successfully logged in.');
            return res.redirect('/');
        });

    } catch (error) {
        logger.error('Error during 2FA verification: ' + error.message);
        req.flash('error', 'An error occurred during 2FA verification. Please try again.');
        return res.redirect('/user/2fa');
    }
};

router.get('/2fa', render2FAPage);
router.post('/2fa', verify2FA);

module.exports = router;
