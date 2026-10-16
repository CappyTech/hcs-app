/**
 * firstRunController — creates the first admin and seeds the Organisation
 * settings, directly in the database.
 *
 * Reached only through firstRunService's gate, i.e. while INTERNAL.user is
 * empty. It runs inside the full app stack (session, CSRF, flash), so the form
 * is CSRF-protected like every other mutation. Nothing here writes a file and
 * nothing restarts: the admin is created with bcrypt, the company keys go
 * through configStoreService, and the next request is an ordinary login.
 *
 *  GET  /setup   → the first-run page
 *  POST /setup   → create admin + seed settings, redirect to /user/login
 */

import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import mdb from '../services/mongooseDatabaseService.js';
import configService from '../../services/configService.js';
import configStore from '../../services/configStoreService.js';
import firstRun from '../../services/firstRunService.js';
import logger from '../../services/loggerService.js';

const ORG_FIELDS = [
  ['companyName', 'COMPANY_NAME'],
  ['companyShortName', 'COMPANY_SHORT_NAME'],
  ['companyAddress', 'COMPANY_ADDRESS'],
  ['supportEmail', 'SUPPORTEMAIL'],
  ['companyWebsite', 'COMPANY_WEBSITE_URL'],
  ['incorporationYear', 'INCORPORATION_YEAR'],
];

/** `https://host` as the browser reached us, for seeding BASE_URL. */
export function requestOrigin(req) {
  const host = req.get('host');
  if (!host) return '';
  return `${req.protocol}://${host}`;
}

function render(req, res, locals = {}) {
  res.render(path.join('tailwindcss', 'setup', 'first-run'), {
    layout: false,
    title: 'Welcome — create the first administrator',
    values: {},
    error: null,
    suggestedBaseUrl: configService.get('BASE_URL', '') || requestOrigin(req),
    ...locals,
  });
}

export const getFirstRun = (req, res) => render(req, res);

export const postFirstRun = async (req, res, next) => {
  const b = req.body || {};
  const username = String(b.adminUsername || '').trim().toLowerCase();
  const email = String(b.adminEmail || '').trim().toLowerCase();
  const password = String(b.adminPassword || '');
  const confirm = String(b.adminPasswordConfirm || '');

  const fail = (error) => render(req, res, { values: { ...b, adminPassword: '', adminPasswordConfirm: '' }, error });

  if (!username || !/^[a-z0-9._-]{3,64}$/.test(username)) {
    return fail('Username is required: 3–64 characters, lowercase letters, digits, dots, dashes or underscores.');
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return fail('A valid email address is required — password resets and notices are sent to it.');
  }
  if (password.length < 12) return fail('Password must be at least 12 characters.');
  if (password !== confirm) return fail('Passwords do not match.');

  try {
    const User = mdb.INTERNAL?.user;
    if (!User) return fail('The database is not ready yet. Try again in a moment.');

    // Someone else may have finished the form first.
    if ((await User.countDocuments({})) > 0) {
      firstRun.markHasUsers();
      req.flash('error', 'An account already exists. Log in instead.');
      return res.redirect('/user/login');
    }

    const rounds = Number(process.env.BCRYPT_ROUNDS) || 10;
    const hashedPassword = await bcrypt.hash(password, rounds);
    await User.create({
      uuid: crypto.randomUUID(),
      username,
      email,
      password: hashedPassword,
      role: 'admin',
      emailVerified: true,
    });
    firstRun.markHasUsers();
    logger.info(`[firstRun] Created first admin user: ${username}`);

    // Organisation settings — only what was filled in, so the registry's own
    // fallbacks keep working for the rest.
    for (const [field, key] of ORG_FIELDS) {
      const v = String(b[field] || '').trim();
      if (!v) continue;
      try { await configStore.set(key, v, username); } catch (err) {
        logger.warn(`[firstRun] could not save ${key}: ${err.message}`);
      }
    }

    // Public base URL: what the form says, else how this browser reached us.
    // CSP's own-origin entries and absolute links in emails derive from it.
    const baseUrl = String(b.baseUrl || '').trim().replace(/\/+$/, '') || requestOrigin(req);
    if (baseUrl && /^https?:\/\//i.test(baseUrl)) {
      try { await configStore.set('BASE_URL', baseUrl, username); } catch (err) {
        logger.warn(`[firstRun] could not save BASE_URL: ${err.message}`);
      }
    }

    req.flash('success', 'Administrator created. Log in to finish setting up under Admin → Configuration.');
    return res.redirect('/user/login');
  } catch (err) {
    if (err && err.code === 11000) return fail('That username or email is already taken.');
    return next(err);
  }
};

export default { getFirstRun, postFirstRun, requestOrigin };
