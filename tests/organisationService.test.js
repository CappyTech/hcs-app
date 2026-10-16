import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import org from '../services/organisationService.js';
import registry from '../services/configRegistry.js';

const KEYS = ['COMPANY_NAME', 'COMPANY_SHORT_NAME', 'COMPANY_ADDRESS', 'SUPPORTEMAIL', 'COMPANY_WEBSITE_URL', 'NOTIFY_SENDER_NAME',
  'NOTIFY_INVOICE_RECIPIENT_NAME', 'NOTIFY_INVOICE_EMAIL', 'NOTIFY_STATEMENT_RECIPIENT_NAME', 'NOTIFY_STATEMENT_EMAIL', 'NOTIFY_CREDIT_NOTE_RECIPIENT_NAME', 'NOTIFY_CREDIT_NOTE_EMAIL'];
let saved;
beforeEach(() => { saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); for (const k of KEYS) delete process.env[k]; });
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

describe('organisationService', () => {
  it('every company value is a registered configuration key, so an admin can set it', () => {
    for (const key of ['COMPANY_NAME', 'COMPANY_SHORT_NAME', 'COMPANY_ADDRESS', 'SUPPORTEMAIL', 'COMPANY_WEBSITE_URL', 'ONEDRIVE_URL', 'ICO_NUMBER', 'INCORPORATION_YEAR']) {
      assert.equal(registry.findKey(key)?.group, 'organisation', key);
    }
    for (const key of ['NOTIFY_SENDER_NAME', 'NOTIFY_INVOICE_RECIPIENT_NAME', 'NOTIFY_STATEMENT_RECIPIENT_NAME', 'NOTIFY_CREDIT_NOTE_RECIPIENT_NAME']) {
      assert.equal(registry.findKey(key)?.group, 'document-notifications', key);
    }
  });

  it('falls back neutrally when nothing is set', () => {
    assert.equal(org.companyName(), 'This company');
    assert.equal(org.companyShortName(), 'This company');
    assert.equal(org.companyAddress(), '');
    assert.equal(org.supportEmail(), '');
    assert.equal(org.websiteUrl(), '');
    assert.equal(org.websiteHost(), 'the public website');
    assert.equal(org.documentsSenderName(), 'This company | Documents');
    assert.equal(org.notifyRecipientName('invoice'), 'recipient');
    assert.equal(org.notifyRecipientName('nonsense'), 'recipient');
    assert.deepEqual(org.viewLocals(), { companyName: '', companyShortName: 'This company', companyAddress: '', contactEmail: '', websiteUrl: '', websiteHost: 'the public website' });
  });

  it('reads the configured values; the short name defaults to the full name', () => {
    Object.assign(process.env, { COMPANY_NAME: 'Acme Builders LTD', COMPANY_ADDRESS: '1 Example St', SUPPORTEMAIL: 'help@acme.test', COMPANY_WEBSITE_URL: 'www.acme.test/' });
    assert.equal(org.companyShortName(), 'Acme Builders LTD');
    process.env.COMPANY_SHORT_NAME = 'Acme';
    assert.equal(org.companyShortName(), 'Acme');
    assert.equal(org.documentsSenderName(), 'Acme | Documents');
    assert.equal(org.websiteUrl(), 'https://www.acme.test', 'scheme added, trailing slash dropped');
    assert.equal(org.websiteHost(), 'www.acme.test');
    assert.equal(org.viewLocals().contactEmail, 'help@acme.test');
    process.env.NOTIFY_SENDER_NAME = 'Acme Docs';
    assert.equal(org.documentsSenderName(), 'Acme Docs');
  });

  it('recipient names: configured name, else the address', () => {
    process.env.NOTIFY_STATEMENT_EMAIL = 'bev@acme.test';
    assert.equal(org.notifyRecipientName('statement'), 'bev@acme.test');
    process.env.NOTIFY_STATEMENT_RECIPIENT_NAME = 'Bev';
    assert.equal(org.notifyRecipientName('statement'), 'Bev');
    process.env.NOTIFY_CREDIT_NOTE_RECIPIENT_NAME = 'Accounts';
    assert.equal(org.notifyRecipientName('credit_note'), 'Accounts');
  });

  it('no view, service or controller names the company, its people or its domains', () => {
    const roots = ['mongoose/views/tailwindcss', 'mongoose/controllers', 'mongoose/services', 'mongoose/config', 'services'];
    const offending = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(p); continue; }
        if (!/\.(ejs|js)$/.test(entry.name)) continue;
        const src = fs.readFileSync(p, 'utf8')
          // Comments may explain history; what renders or is sent may not name anyone.
          .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/<%#[\s\S]*?%>/g, '');
        // Compare with forward slashes so the allowlist below also matches on Windows.
        if (/\bHeron\b|heroncs\.co\.uk|HeronCS|\bBev\b|\bJack\b/.test(src)) offending.push(p.split(path.sep).join('/'));
      }
    };
    roots.forEach(walk);
    // Known, deliberate exceptions: security allowlists and SSO defaults that
    // deployment configuration overrides (HCS_SSO_RETURN_HOSTS, HCS_SYNC_BASE_URL).
    const allowed = new Set(['services/securityService.js', 'mongoose/controllers/ssoController.js', 'mongoose/services/hcsSyncService.js']);
    assert.deepEqual(offending.filter((p) => !allowed.has(p)), []);
  });
});
