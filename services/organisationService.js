/**
 * organisationService — the company's own wording, read from configuration.
 *
 * hcs-app is deployed per company, so nothing user-facing may carry one
 * company's name, address, contact email or website in code. Every place that
 * used to say "Heron CS" reads one of these instead. The keys live in the
 * Organisation group of the configuration registry, so an admin sets them on
 * Admin → Configuration → Organisation, and the setup wizard seeds the first
 * ones.
 *
 * Each getter has a neutral fallback so a fresh install renders something
 * sensible rather than a blank, and so templates never print "undefined".
 */

import configService from './configService.js';

const str = (key) => String(configService.get(key, '') ?? '').trim();

/** Full legal name, e.g. "Example Construction LTD". */
export function companyName() {
  return str('COMPANY_NAME') || 'This company';
}

/** Short everyday name for subjects, SMS and sender names. Falls back to the full name. */
export function companyShortName() {
  return str('COMPANY_SHORT_NAME') || companyName();
}

/** Postal address on one line, for print footers and legal notices. Empty when unset. */
export function companyAddress() {
  return str('COMPANY_ADDRESS');
}

/** The contact address shown to users and on documents. Empty when unset. */
export function supportEmail() {
  return str('SUPPORTEMAIL');
}

/** The company's public website, with scheme. Empty when unset. */
export function websiteUrl() {
  const raw = str('COMPANY_WEBSITE_URL');
  if (!raw) return '';
  const base = raw.replace(/\/+$/, '');
  return /^https?:\/\//i.test(base) ? base : `https://${base}`;
}

/** Hostname of the public website, for prose such as "published at example.com/blog". */
export function websiteHost() {
  const url = websiteUrl();
  if (!url) return 'the public website';
  try { return new URL(url).host; } catch { return url.replace(/^https?:\/\//i, ''); }
}

/** Display name for the document emails and Discord posts, e.g. "Example | Documents". */
export function documentsSenderName() {
  return str('NOTIFY_SENDER_NAME') || `${companyShortName()} | Documents`;
}

/**
 * Who a document notification is described as going to, for the Discord
 * wording "Emailed invoice to …". Falls back to the configured address, then
 * to a neutral word, so the post never names nobody.
 */
export function notifyRecipientName(kind) {
  const keys = {
    invoice: ['NOTIFY_INVOICE_RECIPIENT_NAME', 'NOTIFY_INVOICE_EMAIL'],
    statement: ['NOTIFY_STATEMENT_RECIPIENT_NAME', 'NOTIFY_STATEMENT_EMAIL'],
    credit_note: ['NOTIFY_CREDIT_NOTE_RECIPIENT_NAME', 'NOTIFY_CREDIT_NOTE_EMAIL'],
  }[kind];
  if (!keys) return 'recipient';
  return str(keys[0]) || str(keys[1]) || 'recipient';
}

/** The values views need, set on res.locals by app.js for every request. */
export function viewLocals() {
  return {
    companyName: str('COMPANY_NAME'),
    companyShortName: companyShortName(),
    companyAddress: companyAddress(),
    contactEmail: supportEmail(),
    websiteUrl: websiteUrl(),
    websiteHost: websiteHost(),
  };
}

export default {
  companyName, companyShortName, companyAddress, supportEmail, websiteUrl, websiteHost,
  documentsSenderName, notifyRecipientName, viewLocals,
};
