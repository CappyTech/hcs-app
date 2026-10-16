import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import mdb from '../mongoose/services/mongooseDatabaseService.js';
import navPreference from '../mongoose/services/navPreferenceService.js';
import nav from '../services/navigationService.js';
import registry from '../services/configRegistry.js';

/**
 * A person's header style resolves: their own choice → the company default
 * (NAV_STYLE_DEFAULT) → 'tabs'. configService reads process.env live, so the
 * company default is set through the environment here.
 */

let docs = [];
function storeModel() {
  const match = (q) => (d) => String(d.userId) === String(q.userId);
  return {
    findOne: (q) => ({ lean: async () => docs.find(match(q)) || null }),
    findOneAndUpdate: async (q, update) => {
      const existing = docs.find(match(q));
      if (existing) Object.assign(existing, update.$set);
      else docs.push({ ...q, ...update.$set });
    },
    deleteOne: async (q) => { docs = docs.filter((d) => !match(q)(d)); },
  };
}

const user = { _id: 'u-1', role: 'admin', customPermissions: {} };

beforeEach(() => {
  docs = [];
  mdb.INTERNAL = { ...mdb.INTERNAL, navPreference: storeModel() };
  delete process.env.NAV_STYLE_DEFAULT;
});
afterEach(() => { delete process.env.NAV_STYLE_DEFAULT; });

describe('navigation style resolution', () => {
  it('is tabs when nobody has chosen anything', async () => {
    const r = await navPreference.resolve(user);
    assert.deepEqual(r, { style: 'tabs', pinned: null, source: 'default' });
    assert.equal(navPreference.companyDefault(), 'tabs');
  });

  it('uses the company default over tabs, and the person\'s own choice over both', async () => {
    process.env.NAV_STYLE_DEFAULT = 'grouped';
    assert.equal((await navPreference.resolve(user)).style, 'grouped');
    assert.equal((await navPreference.resolve(user)).source, 'company');
    assert.equal(navPreference.companyDefault(), 'grouped');

    await navPreference.save('u-1', { navStyle: 'sidebar', pinned: ['finance'] });
    const own = await navPreference.resolve(user);
    assert.deepEqual(own, { style: 'sidebar', pinned: ['finance'], source: 'user' });

    await navPreference.reset('u-1');
    assert.equal((await navPreference.resolve(user)).source, 'company');
  });

  it('ignores an unknown company default', async () => {
    process.env.NAV_STYLE_DEFAULT = 'carousel';
    assert.equal((await navPreference.resolve(user)).style, 'tabs');
    assert.equal(navPreference.companyDefault(), 'tabs');
  });

  it('survives a missing model or an unknown stored style', async () => {
    docs.push({ userId: 'u-1', navStyle: 'retired', pinned: ['admin'] });
    const r = await navPreference.resolve(user);
    assert.equal(r.style, 'tabs');
    assert.deepEqual(r.pinned, ['admin'], 'a pinned list still counts even when the style is stale');

    mdb.INTERNAL = { ...mdb.INTERNAL, navPreference: null };
    assert.equal((await navPreference.resolve(user)).source, 'default');
    await assert.rejects(() => navPreference.save('u-1', { navStyle: 'tabs', pinned: [] }), /unavailable/);
  });
});

describe('the account form', () => {
  const built = nav.build({ path: '/', user });

  it('accepts a listed style and keeps only pinnable slugs', () => {
    const pref = navPreference.fromForm({ navStyle: 'command', pinned: ['finance', 'create', 'user', 'nope', 'admin'] }, built);
    assert.deepEqual(pref, { navStyle: 'command', pinned: ['finance', 'admin'] });
    assert.deepEqual(navPreference.fromForm({ navStyle: 'tabs', pinned: 'attendance' }, built).pinned, ['attendance']);
    assert.deepEqual(navPreference.fromForm({ navStyle: 'tabs' }, built).pinned, []);
  });

  it('refuses a style that does not exist', () => {
    assert.throws(() => navPreference.fromForm({ navStyle: 'carousel' }, built), /does not exist/);
    assert.throws(() => navPreference.fromForm({}, built), /does not exist/);
  });

  it('offers the same five styles as the registry and the model', () => {
    const values = navPreference.STYLES.map((s) => s.value);
    assert.deepEqual(values, [...nav.STYLES]);
    const entry = registry.findKey('NAV_STYLE_DEFAULT');
    assert.equal(entry.group, 'appearance');
    assert.equal(entry.type, 'select');
    assert.deepEqual(entry.options.map((o) => o.value), values);
    for (const s of navPreference.STYLES) assert.ok(s.label && s.description, `${s.value} has a label and a one-line description`);
  });
});
