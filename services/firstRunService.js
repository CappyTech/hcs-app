/**
 * firstRunService — the user-count gate.
 *
 * A fresh deployment has a database and no users. Until the first admin
 * exists there is nobody to log in as, so every request is sent to /setup,
 * which creates that admin directly in the database (and seeds the
 * Organisation settings) with no file written and no restart.
 *
 * The check is one countDocuments on INTERNAL.user per request while the
 * collection is empty — cheap, and short-lived: once a user exists the result
 * is remembered for the life of the process and the gate costs nothing.
 *
 * If the count itself fails (Mongo flickering) the gate stands aside rather
 * than trapping everyone on the setup page; the maintenance guard further down
 * the stack handles that case.
 */

import logger from './loggerService.js';

let _hasUsers = false;

/** Forget the cached answer (tests, and after a database is swapped). */
export function reset() {
  _hasUsers = false;
}

/** Mark the gate as satisfied without another query — the first admin was just created. */
export function markHasUsers() {
  _hasUsers = true;
}

/**
 * True while the INTERNAL user collection is empty.
 * @param {{ countDocuments(filter: object): Promise<number> }} UserModel
 */
export async function needsFirstRun(UserModel) {
  if (_hasUsers) return false;
  if (!UserModel) return false;
  const count = await UserModel.countDocuments({});
  if (count > 0) {
    _hasUsers = true;
    return false;
  }
  return true;
}

export const SETUP_PATH = '/setup';

function isSetupPath(p) {
  return p === SETUP_PATH || p.startsWith(SETUP_PATH + '/');
}

/**
 * Express middleware. `getUserModel` is a function so the model is looked up
 * per request — mdb.INTERNAL is populated after the middleware is built.
 *
 * @param {() => object} getUserModel  returns the INTERNAL.user model
 * @param {import('express').Router} setupRouter  serves GET/POST /setup
 */
export function firstRunGate(getUserModel, setupRouter) {
  return async function firstRun(req, res, next) {
    let pending;
    try {
      pending = await needsFirstRun(getUserModel());
    } catch (err) {
      logger.warn('[firstRun] user count failed, letting the request through: ' + err.message);
      return next();
    }
    if (!pending) return next();
    if (isSetupPath(req.path)) return setupRouter(req, res, next);
    return res.redirect(SETUP_PATH);
  };
}

let _baseUrlSeeded = false;

/**
 * Express middleware, mounted after the auth guard: when BASE_URL has no value
 * anywhere (store, env, legacy file), the first authenticated request's origin
 * becomes it, persisted through the managed store. CSP's own-origin entries
 * and absolute links in emails read it. Runs its query at most once per
 * process; an admin can change the value at /admin/config afterwards.
 */
export function seedBaseUrl(configStore, { configService: cfg } = {}) {
  return async function seedBaseUrlFromRequest(req, _res, next) {
    if (_baseUrlSeeded || !req.user) return next();
    try {
      const svc = cfg || (await import('./configService.js')).default;
      if (svc.get('BASE_URL', '')) {
        _baseUrlSeeded = true;
        return next();
      }
      const host = req.get('host');
      if (!host) return next();
      _baseUrlSeeded = true;
      const origin = `${req.protocol}://${host}`;
      await configStore.set('BASE_URL', origin, req.user.username || 'system');
      logger.info(`[firstRun] BASE_URL was unset — seeded from the first signed-in request: ${origin}`);
    } catch (err) {
      logger.warn('[firstRun] could not seed BASE_URL: ' + err.message);
    }
    return next();
  };
}

/** Tests only. */
export function resetBaseUrlSeed() {
  _baseUrlSeeded = false;
}

export default { reset, markHasUsers, needsFirstRun, firstRunGate, seedBaseUrl, resetBaseUrlSeed, SETUP_PATH };
