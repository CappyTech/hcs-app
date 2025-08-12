const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');
const axios = require('axios');
const bcrypt = require('bcrypt');

exports.renderRegistrationForm = (req, res, next) => {
    res.render(path.join('tailwindcss', 'user', 'register'), {
        title: 'Register',
        siteKey: process.env.TURNSTILE_SITE_KEY,
    });
};

exports.registerUser = async (req, res, next) => {
    try {
  const { username, email, password } = req.body;
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

        const existingUser = await mdb.INTERNAL.user.findOne({
            $or: [{ username }, { email }]
        });

        if (existingUser) {
            logger.error('Username or email already exists');
            req.flash('error', 'Username or email already exists');
            return res.redirect('/user/register');
        }

    // Enforce default role; ignore any client-supplied role attempt
    const DEFAULT_ROLE = 'subcontractor';
    if (req.body.role && req.body.role !== DEFAULT_ROLE) {
      logger.warn(`Registration role override attempt ignored. Requested='${req.body.role}' enforced='${DEFAULT_ROLE}' user='${username}'`);
    }
    const assignedRole = DEFAULT_ROLE;
        const newUser = new mdb.INTERNAL.user({
            username,
            email,
            password,
            role: assignedRole,
        });

        await newUser.save();

        logger.info('New User Created.');
        req.flash('success', 'Account created. You can now log in.');
        return res.redirect('/user/login');

    } catch (error) {
        logger.error('Error registering user: ' + error.message);
        req.flash('error', 'Error registering user: ' + error.message);
        return res.redirect('/user/register');
    }
};

exports.renderLoginForm = (req, res) => {
  res.render(path.join('tailwindcss', 'user', 'login'), {
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

    const reqId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const safeId = (v) => (v ? Buffer.from(v).toString('base64').slice(0, 8) : 'null');

    logger.info(`[LOGIN ${reqId}] start ua.browser='${agent.browser||'Unknown'}' ip='${ip}' supplied='${usernameOrEmail||''}' len.pw='${password?password.length:0}'`);

    if (!token) {
      logger.warn(`[LOGIN ${reqId}] missing CAPTCHA token`);
      req.flash('error', 'CAPTCHA token missing.');
      return res.redirect('/user/login');
    }

    let verifyResponse;
    try {
      verifyResponse = await axios.post(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip })
      );
    } catch (e) {
      logger.error(`[LOGIN ${reqId}] CAPTCHA verify network error: ${e.message}`);
      req.flash('error', 'CAPTCHA verification failed.');
      return res.redirect('/user/login');
    }

    if (!verifyResponse.data.success) {
      logger.warn(`[LOGIN ${reqId}] CAPTCHA failed codes=${JSON.stringify(verifyResponse.data['error-codes']||[])} `);
      req.flash('error', 'CAPTCHA verification failed.');
      return res.redirect('/user/login');
    }
    logger.info(`[LOGIN ${reqId}] CAPTCHA ok`);

    if (!usernameOrEmail || !password) {
      logger.warn(`[LOGIN ${reqId}] missing credentials user='${usernameOrEmail}'`);
      req.flash('error', 'Username and password are required.');
      return res.redirect('/user/login');
    }

    const rawInput = usernameOrEmail;
    const trimmedInput = (rawInput || '').trim();
    const normalizedEmailCandidate = trimmedInput.toLowerCase();

    // Primary exact lookup
    let user = await mdb.INTERNAL.user.findOne({
      $or: [{ username: trimmedInput }, { email: normalizedEmailCandidate }]
    });

    if (!user) {
      // Diagnostics: char codes, counts, case-insensitive search
      const charCodes = trimmedInput.split('').map(c => c.charCodeAt(0));
      const userCount = await mdb.INTERNAL.user.countDocuments();
      const ciUser = await mdb.INTERNAL.user.findOne({ username: new RegExp(`^${trimmedInput}$`, 'i') });
      const ciEmail = await mdb.INTERNAL.user.findOne({ email: new RegExp(`^${normalizedEmailCandidate}$`, 'i') });
      logger.warn(`[` + `LOGIN ${reqId}` + `] user not found supplied='${trimmedInput}' codes=${JSON.stringify(charCodes)} totalUsers=${userCount} ciUsernameMatch=${!!ciUser} ciEmailMatch=${!!ciEmail} collection='${mdb.INTERNAL.user.collection.name}'`);

      // Fallback: adopt case-insensitive match if unique
      if (ciUser && !ciEmail) {
        user = ciUser;
        logger.warn(`[LOGIN ${reqId}] proceeding with case-insensitive username match '${ciUser.username}'`);
      } else if (!ciUser && ciEmail) {
        user = ciEmail;
        logger.warn(`[LOGIN ${reqId}] proceeding with case-insensitive email match '${ciEmail.email}'`);
      } else if (ciUser && ciEmail && ciUser.id === ciEmail.id) {
        user = ciUser;
        logger.warn(`[LOGIN ${reqId}] proceeding with unified case-insensitive match user='${ciUser.username}'`);
      }
    }

    if (!user) {
      req.flash('error', 'Invalid username or password.');
      return res.redirect('/user/login');
    }
    logger.info(`[LOGIN ${reqId}] user record located uuid=${user.uuid}`);

    let passwordOk = false;
    try {
      passwordOk = await bcrypt.compare(password, user.password);
    } catch (e) {
      logger.error(`[LOGIN ${reqId}] bcrypt compare failed: ${e.message}`);
    }
    if (!passwordOk) {
      logger.warn(`[LOGIN ${reqId}] password mismatch user='${user.username}'`);
      req.flash('error', 'Invalid username or password.');
      return res.redirect('/user/login');
    }
    logger.info(`[LOGIN ${reqId}] password ok totpEnabled=${!!user.totpEnabled}`);

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

    if (user.totpEnabled) {
      logger.info(`[LOGIN ${reqId}] staging 2FA user='${user.username}'`);
      req.session.userPending2FA = sessionData;
      return res.redirect('/user/2fa');
    }

    try {
      await new Promise((resolve, reject) => {
        req.session.regenerate(err => (err ? reject(err) : resolve()));
      });
      logger.info(`[LOGIN ${reqId}] session regenerated oldSID preserved? newSID=${req.sessionID}`);
    } catch (e) {
      logger.error(`[LOGIN ${reqId}] session regenerate failed: ${e.message}`);
      req.flash('error', 'Session error. Try again.');
      return res.redirect('/user/login');
    }

    req.session.user = sessionData;
    try {
      await new Promise((resolve, reject) => {
        req.session.save(err => (err ? reject(err) : resolve()));
      });
      logger.info(`[LOGIN ${reqId}] session saved sid=${req.sessionID}`);
    } catch (e) {
      logger.error(`[LOGIN ${reqId}] session save failed: ${e.message}`);
      req.flash('error', 'Session persistence error.');
      return res.redirect('/user/login');
    }

    try {
      if (mdb.INTERNAL.session) {
        const update = await mdb.INTERNAL.session.updateOne(
          { _id: req.sessionID },
          { $set: {
              userId: sessionData.id,
              username: sessionData.username,
              email: sessionData.email,
              role: sessionData.role,
              ip: sessionData.ip,
              uaBrowser: sessionData.userAgent.browser,
              uaVersion: sessionData.userAgent.version,
              uaOS: sessionData.userAgent.os,
              loginTime: new Date(sessionData.loginTime)
            }
          },
          { upsert: true }
        );
        logger.info(`[LOGIN ${reqId}] session denorm matched=${update.matchedCount} modified=${update.modifiedCount} upserted=${update.upsertedCount||0}`);
      }
    } catch (e) {
      logger.warn(`[LOGIN ${reqId}] session denorm skipped error=${e.message}`);
    }

    logger.info(`[LOGIN ${reqId}] success username='${user.username}' redirect=/`);
    req.flash('success', `${user.username}, you're logged in.`);
    return res.redirect('/');

  } catch (error) {
    logger.error(`[LOGIN FATAL] unexpected error=${error.message}`);
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
    res.clearCookie('hms.sid');
    req.flash('success', 'You have been logged out.');
    return res.redirect('/user/login');
  });
};