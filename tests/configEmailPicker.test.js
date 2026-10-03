import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Settings of type 'email' (the document notification recipients): a
 * dropdown of every user's email plus "Other…" for a typed address, and only
 * a valid email address is ever saved.
 */

const saved = [];
mock.module('../services/configStoreService.js', {
  defaultExport: {
    set: async (key, value) => { saved.push([key, value]); },
    has: () => false,
    pendingEnvKeys: () => [],
    shadowedEnvKeys: () => [],
  },
});

const USERS = [
  { username: 'john.oldfield', email: 'john.oldfield@heroncs.co.uk' },
  { username: 'bev', email: 'bev.oldfield@heroncs.co.uk' },
  { username: 'dupe', email: 'BEV.oldfield@heroncs.co.uk' },
  { username: 'broken', email: 'not-an-email' },
];
mock.module('../mongoose/services/mongooseDatabaseService.js', {
  defaultExport: {
    INTERNAL: {
      user: {
        find: () => ({ select: () => ({ sort: () => ({ lean: async () => USERS }) }) }),
      },
    },
  },
});

const registry = (await import('../services/configRegistry.js')).default;
const { getGroup, postGroup, EMAIL_RE } = await import('../mongoose/controllers/appConfigController.js');
const ejs = createRequire(import.meta.url)('ejs');

const req = (body, flashes = []) => ({
  params: { group: 'document-notifications' },
  body,
  session: { user: { username: 'jack' } },
  flash: (type, msg) => flashes.push([type, msg]),
});

describe('email settings', () => {
  it('all three recipients are email pickers', () => {
    for (const k of ['NOTIFY_INVOICE_EMAIL', 'NOTIFY_STATEMENT_EMAIL', 'NOTIFY_CREDIT_NOTE_EMAIL']) {
      assert.equal(registry.findKey(k).type, 'email', k);
    }
  });

  it('lists each user email once, skips invalid ones, and offers Other…', async () => {
    let rendered;
    const res = { render: (view, locals) => { rendered = locals; } };
    await getGroup(req({}), res, (e) => { throw e; });
    assert.deepEqual(rendered.userEmails, [
      { value: 'john.oldfield@heroncs.co.uk', label: 'john.oldfield (john.oldfield@heroncs.co.uk)' },
      { value: 'bev.oldfield@heroncs.co.uk', label: 'bev (bev.oldfield@heroncs.co.uk)' },
    ]);

    const html = await ejs.renderFile(path.resolve('mongoose/views/tailwindcss/admin/configGroup.ejs'), {
      ...rendered,
      group: { ...rendered.group, fields: rendered.group.fields.map((f) => ({ ...f, display: f.key === 'NOTIFY_INVOICE_EMAIL' ? 'john.oldfield@heroncs.co.uk' : f.display })) },
      csrfToken: 't',
    });
    const block = html.match(/<select id="field-NOTIFY_INVOICE_EMAIL"[\s\S]*?<\/select>/)[0];
    assert.match(block, /No change \(currently john\.oldfield@heroncs\.co\.uk\)/);
    assert.match(block, /<option value="bev\.oldfield@heroncs\.co\.uk">bev \(bev\.oldfield@heroncs\.co\.uk\)<\/option>/);
    assert.match(block, /<option value="__other__">Other…<\/option>/);
    assert.match(html, /<input id="field-NOTIFY_INVOICE_EMAIL-other" name="NOTIFY_INVOICE_EMAIL__other" type="email"/);
    assert.match(html, /x-data="emailPicker"/);
  });

  it('saves a chosen user email, or a valid typed "Other" address', async () => {
    saved.length = 0;
    await postGroup(req({ NOTIFY_INVOICE_EMAIL: 'john.oldfield@heroncs.co.uk' }), { redirect() {} });
    await postGroup(req({ NOTIFY_CREDIT_NOTE_EMAIL: '__other__', NOTIFY_CREDIT_NOTE_EMAIL__other: ' accounts@example.com ' }), { redirect() {} });
    assert.deepEqual(saved, [['NOTIFY_INVOICE_EMAIL', 'john.oldfield@heroncs.co.uk'], ['NOTIFY_CREDIT_NOTE_EMAIL', 'accounts@example.com']]);
  });

  it('refuses an invalid or empty "Other" address, and anything that is not an email', async () => {
    saved.length = 0;
    const flashes = [];
    const res = { redirect() {} };
    await postGroup(req({ NOTIFY_STATEMENT_EMAIL: '__other__', NOTIFY_STATEMENT_EMAIL__other: 'bev at heroncs' }, flashes), res);
    await postGroup(req({ NOTIFY_STATEMENT_EMAIL: '__other__', NOTIFY_STATEMENT_EMAIL__other: '' }, flashes), res);
    await postGroup(req({ NOTIFY_INVOICE_EMAIL: 'a@b.com, c@d.com' }, flashes), res);
    await postGroup(req({ NOTIFY_INVOICE_EMAIL: '__other__' }, flashes), res);
    assert.deepEqual(saved, []);
    assert.ok(flashes.some(([t, m]) => t === 'error' && /"bev at heroncs" isn't a valid email address/.test(m)));
    assert.ok(flashes.some(([t, m]) => t === 'error' && /"Other" was chosen but no address was typed/.test(m)));
  });

  it('EMAIL_RE accepts ordinary addresses only', () => {
    for (const ok of ['a@b.co', 'first.last+tag@heroncs.co.uk']) assert.ok(EMAIL_RE.test(ok), ok);
    for (const bad of ['', 'a@b', 'a b@c.com', 'a@b.com;c@d.com', '<a@b.com>', '@b.com']) assert.ok(!EMAIL_RE.test(bad), bad);
  });
});
