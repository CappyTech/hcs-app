import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Settings of type 'select' (e.g. NOTIFY_MODE): rendered as a dropdown of the
 * registry's options, and a value that isn't one of them is never saved.
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

const registry = (await import('../services/configRegistry.js')).default;
const { postGroup } = await import('../mongoose/controllers/appConfigController.js');
const ejs = createRequire(import.meta.url)('ejs');

describe('select settings', () => {
  const entry = registry.findKey('NOTIFY_MODE');

  it('NOTIFY_MODE offers exactly shadow and live', () => {
    assert.equal(entry.type, 'select');
    assert.deepEqual(entry.options.map((o) => o.value), ['shadow', 'live']);
  });

  it('renders as a dropdown showing the current choice by its label', async () => {
    const group = registry.findGroup('document-notifications');
    const fields = group.keys.map((k) => ({ ...k, source: 'store', isSet: k.key === 'NOTIFY_MODE', display: k.key === 'NOTIFY_MODE' ? 'live' : '', stored: false, shadowsEnv: false, adoptable: false }));
    const html = await ejs.renderFile(path.resolve('mongoose/views/tailwindcss/admin/configGroup.ejs'), {
      group: { ...group, fields, counts: { store: 1, env: 0, unset: 0, adoptable: 0 } }, title: group.label, csrfToken: 't',
    });
    const select = html.match(/<select id="field-NOTIFY_MODE"[\s\S]*?<\/select>/)?.[0];
    assert.ok(select, 'NOTIFY_MODE is a <select>');
    assert.match(select, /<option value="">No change \(currently Live: send emails and Discord posts\)<\/option>/);
    assert.match(select, /<option value="shadow">Shadow: record only, send nothing<\/option>/);
    assert.match(select, /<option value="live">Live: send emails and Discord posts<\/option>/);
    assert.ok(!/<input id="field-NOTIFY_MODE"/.test(html), 'no free-text box');
  });

  it('saves a listed value and refuses anything else', async () => {
    const flashes = [];
    const req = (body) => ({
      params: { group: 'document-notifications' },
      body,
      session: { user: { username: 'jack' } },
      flash: (type, msg) => flashes.push([type, msg]),
    });
    const res = { redirect: () => {} };

    saved.length = 0;
    await postGroup(req({ NOTIFY_MODE: 'live' }), res);
    assert.deepEqual(saved, [['NOTIFY_MODE', 'live']]);

    saved.length = 0;
    flashes.length = 0;
    await postGroup(req({ NOTIFY_MODE: 'Live ' }), res);
    await postGroup(req({ NOTIFY_MODE: 'lve' }), res);
    assert.deepEqual(saved, [], 'nothing saved');
    assert.ok(flashes.some(([t, m]) => t === 'error' && /"lve" isn't one of the choices/.test(m)));
  });
});
