const express = require('express');
const router = express.Router();
const axios = require('axios');

const path = require('path');
const logger = require('../../services/loggerService');
const mdb = require('../../services/mongoose/mongooseDatabaseService');

const renderRegistrationForm = (req, res) => {
    res.render(path.join('user', 'register'), {
        title: 'Register',
        siteKey: process.env.TURNSTILE_SITE_KEY,
    });
};

const registerUser = async (req, res) => {
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

        const newUser = new mdb.user({
            username,
            email,
            password,
            role: role || 'subcontractor'
        });

        await newUser.save();

        logger.info('New User Created.');
        req.flash('success', 'Account created. You can now sign in.');
        return res.redirect('/user/signin');

    } catch (error) {
        logger.error('Error registering user: ' + error.message);
        req.flash('error', 'Error registering user: ' + error.message);
        return res.redirect('/user/register');
    }
};

router.get('/register', renderRegistrationForm);
router.post('/register', registerUser);

module.exports = router;
