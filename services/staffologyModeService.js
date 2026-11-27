/**
 * staffologyModeService — is payroll run in Staffology, for this app's purposes?
 *
 * Staffology mode is on when a Staffology API key is saved (Settings →
 * Connections → Staffology) AND the connection test last passed for exactly that
 * key and employer ID. The test button records a fingerprint of the two
 * (connectionSettingsController); changing either switches the mode off until
 * the test passes again, so a half-entered key never flips the payroll pages.
 *
 * In Staffology mode the in-house pay-run engine is hidden: its pages redirect
 * (gate below, mounted in app.js before route access), its models and links
 * disappear (rolePermissionsConfig, overviews), and the pages that remain
 * (/payroll/dashboard, /payroll/runs, /payroll/employee/:uuid) show Staffology
 * data. Nothing is deleted; switching the mode off brings everything back.
 *
 * Imported by rolePermissionsConfig, so — like moduleService — it must not
 * import anything that imports that file back. The fingerprint is persisted by
 * whoever calls load()/setVerified() with a store ({ get, record } —
 * jobStateService), so this file stays free of database imports.
 */
import crypto from 'node:crypto';
import configService from './configService.js';

export const STATE_NAME = 'staffology-verified';

let verifiedFingerprint = null;

const key = () => String(configService.get('STAFFOLOGY_API_KEY', '') || '').trim();
const employer = () => String(configService.get('STAFFOLOGY_EMPLOYER_ID', '') || '').trim();

/** A short one-way fingerprint of the key + employer ID (never the key itself). */
export function fingerprint(apiKey = key(), employerId = employer()) {
  if (!apiKey) return null;
  return crypto.createHash('sha256').update(`${apiKey}\n${employerId}`).digest('hex').slice(0, 32);
}

/** Synchronous: key saved and the last test passed for this key + employer. */
export function isStaffologyMode() {
  const fp = fingerprint();
  return Boolean(fp && verifiedFingerprint && fp === verifiedFingerprint);
}

/** Read the stored fingerprint into memory (at startup). */
export async function load(store) {
  try {
    const state = await store?.get?.(STATE_NAME);
    verifiedFingerprint = state?.lastOutcome === 'ok' ? state?.lastResult?.fingerprint || null : null;
  } catch {
    verifiedFingerprint = null;
  }
  return verifiedFingerprint;
}

/** Record a test result: ok → the current fingerprint; failure → cleared. */
export async function setVerified(ok, store) {
  verifiedFingerprint = ok ? fingerprint() : null;
  try {
    await store?.record?.(STATE_NAME, {
      outcome: ok ? 'ok' : 'error',
      result: ok ? { fingerprint: verifiedFingerprint } : null,
    });
  } catch {
    // Best effort: the in-memory value still applies until restart.
  }
  return verifiedFingerprint;
}

/** For tests. */
export function _setFingerprintForTest(fp) {
  verifiedFingerprint = fp;
}

// ── What the mode hides ──────────────────────────────────────────────────────

/** Engine-only models: their generic CRUD/list/overview pages go. */
export const HIDDEN_MODELS = ['payrollRun', 'payrollEntry', 'payrollSubmission', 'payrollConfig', 'payrollTaxRates'];

/**
 * Engine-only paths and where each goes instead. Longest prefix first.
 * GET requests are redirected to `to`; anything else is answered with a flash
 * and a redirect to the dashboard (or 409 for JSON callers).
 */
export const HIDDEN_PATHS = [
  { prefix: '/payroll/runs/create', to: '/payroll/runs' },
  { prefix: '/payroll/run', to: '/payroll/runs' },
  { prefix: '/payroll/submissions', to: '/payroll/dashboard' },
  { prefix: '/payroll/hmrc', to: '/payroll/dashboard' },
  { prefix: '/settings/payroll', to: '/admin/config/staffology' },
  ...HIDDEN_MODELS.flatMap((m) => {
    const lower = m.toLowerCase();
    return [
      { prefix: `/overview/${lower}`, to: '/overview/payroll' },
      { prefix: `/${lower}s`, to: '/payroll/dashboard' },
      { prefix: `/${lower}`, to: '/payroll/dashboard' },
    ];
  }),
];

const norm = (p) => {
  let s = String(p || '').split(/[?#]/)[0].toLowerCase();
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
};

/** The hidden-path rule for a path, or null. Only meaningful in Staffology mode. */
export function hiddenRule(path) {
  const p = norm(path);
  return HIDDEN_PATHS.find(({ prefix }) => p === prefix || p.startsWith(`${prefix}/`)) || null;
}

/** Pages that only exist in Staffology mode (My pay). */
export const STAFFOLOGY_ONLY_PATHS = ['/my-pay'];

const staffologyOnly = (path) => {
  const p = norm(path);
  return STAFFOLOGY_ONLY_PATHS.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
};

/**
 * Does the current payroll mode hide this path? In Staffology mode the engine
 * pages are hidden; outside it, the Staffology-only pages are.
 */
export function hidesPath(path) {
  if (isStaffologyMode()) return Boolean(hiddenRule(path));
  return staffologyOnly(path);
}

/** Does Staffology mode hide this model right now? */
export function hidesModel(model) {
  if (!model || !isStaffologyMode()) return false;
  const lower = String(model).toLowerCase();
  return HIDDEN_MODELS.some((m) => m.toLowerCase() === lower);
}

/**
 * Express middleware (app.js, after the module gate, before route access):
 * in Staffology mode, engine-only pages redirect to their Staffology
 * counterpart instead of serving or answering 403.
 */
export function gate(req, res, next) {
  if (!isStaffologyMode()) {
    // Staffology-only pages (My pay) don't exist outside Staffology mode.
    return staffologyOnly(req.path) ? next({ statusCode: 404, name: 'NotFoundError', message: 'Page not found.' }) : next();
  }
  const rule = hiddenRule(req.path);
  if (!rule) return next();
  const message = 'Payroll is run in Staffology, so this hcs-app payroll tool is switched off.';
  if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(rule.to);
  const wantsJson = req.xhr || /json/i.test(req.get?.('accept') || '') || /json/i.test(req.get?.('content-type') || '');
  if (wantsJson) return res.status(409).json({ error: message });
  req.flash?.('error', message);
  return res.redirect('/payroll/dashboard');
}

export default {
  STATE_NAME,
  HIDDEN_MODELS,
  HIDDEN_PATHS,
  STAFFOLOGY_ONLY_PATHS,
  fingerprint,
  isStaffologyMode,
  load,
  setVerified,
  hiddenRule,
  hidesPath,
  hidesModel,
  gate,
};
