import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import features from '../mongoose/config/publicFeaturesConfig.js';
import departmentsConfig from '../mongoose/config/departmentsConfig.js';
import { GROUPS } from '../services/configRegistry.js';
import { IDS, hiddenIds, visibleGroups } from '../services/publicFeaturesService.js';

/**
 * The signed-out home page once listed six modules while the app had well over
 * a dozen, because the list lived in the template and nothing tied it to the
 * departments. These tests are that tie.
 */

const KNOWN_CONDITIONS = ['website', 'microsoftSso'];
const items = features.flatMap((g) => g.items);
const all = () => true;

describe('public home feature list', () => {
  it('names every department', () => {
    const named = new Set(items.flatMap((i) => i.departments));
    const missing = Object.keys(departmentsConfig).filter((slug) => !named.has(slug));
    assert.deepEqual(missing, [], `add these departments to publicFeaturesConfig: ${missing.join(', ')}`);
  });

  it('names only departments that exist', () => {
    const unknown = items.flatMap((i) => i.departments).filter((slug) => !departmentsConfig[slug]);
    assert.deepEqual(unknown, []);
  });

  it('has unique ids and complete entries', () => {
    assert.equal(new Set(IDS).size, IDS.length, 'duplicate id');
    for (const i of items) {
      assert.match(i.id, /^[a-z]+$/, `id "${i.id}" must be lowercase letters, so admins can type it`);
      assert.ok(i.icon?.startsWith('bi-') && i.title && i.text, `entry ${i.id} is incomplete`);
      assert.ok(Array.isArray(i.departments), `entry ${i.id} needs departments`);
      if (i.when) assert.ok(KNOWN_CONDITIONS.includes(i.when), `unknown condition ${i.when}`);
      if (i.extra) assert.ok(KNOWN_CONDITIONS.includes(i.extra.when), `unknown condition ${i.extra.when}`);
    }
  });

  it('is configurable, and the setting lists every id', () => {
    const key = GROUPS.flatMap((g) => g.keys).find((k) => k.key === 'PUBLIC_HOME_HIDDEN');
    assert.ok(key, 'PUBLIC_HOME_HIDDEN missing from configRegistry');
    for (const id of IDS) assert.ok(key.help.includes(id), `help text is missing ${id}`);
  });
});

describe('publicFeaturesService', () => {
  it('reads hidden ids, ignoring spaces, blanks and unknown ids', () => {
    assert.deepEqual([...hiddenIds(' fleet, website ,nope,,')], ['fleet', 'website']);
    assert.equal(hiddenIds('').size, 0);
    assert.equal(hiddenIds(undefined).size, 0);
  });

  it('shows everything when nothing is hidden and every condition holds', () => {
    const shown = visibleGroups({ hidden: new Set(), when: all }).flatMap((g) => g.items.map((i) => i.id));
    assert.deepEqual(shown, IDS);
  });

  it('leaves out hidden entries and drops groups left empty', () => {
    const groups = features.map((g) => g.group);
    const lastGroup = features.at(-1);
    const hidden = new Set(['fleet', ...lastGroup.items.map((i) => i.id)]);
    const out = visibleGroups({ hidden, when: all });
    assert.ok(!out.flatMap((g) => g.items).some((i) => i.id === 'fleet'));
    assert.ok(!out.some((g) => g.group === lastGroup.group));
    assert.equal(out.length, groups.length - 1);
  });

  it('leaves out conditional entries and extras when their condition fails', () => {
    const none = () => false;
    const out = visibleGroups({ hidden: new Set(), when: none }).flatMap((g) => g.items);
    assert.ok(!out.some((i) => i.id === 'website'), 'Website shown without a company website');
    const signin = out.find((i) => i.id === 'signin');
    assert.ok(!/Microsoft/.test(signin.text), 'Microsoft sign-in offered while it is off');

    const on = visibleGroups({ hidden: new Set(), when: all }).flatMap((g) => g.items);
    assert.match(on.find((i) => i.id === 'signin').text, /Microsoft/);
  });

  it('never mentions internal tooling on the public page', () => {
    const text = items.map((i) => `${i.title} ${i.text} ${i.extra?.text || ''}`).join(' ');
    for (const word of ['KashFlow', 'Paperless', 'maintenance mode', 'background jobs', 'system logs', 'audit log']) {
      assert.ok(!text.toLowerCase().includes(word.toLowerCase()), `public page mentions "${word}"`);
    }
  });
});
