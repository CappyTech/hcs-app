import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import mdb from '../mongoose/services/mongooseDatabaseService.js';
import layoutPreference from '../mongoose/services/layoutPreferenceService.js';
import registry from '../services/configRegistry.js';

/**
 * A person's page width resolves: their own choice → the company default
 * (CONTENT_WIDTH_DEFAULT) → 'standard'. configService reads process.env live,
 * so the company default is set through the environment here.
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

const user = { _id: 'u-1', role: 'employee' };

beforeEach(() => {
  docs = [];
  mdb.INTERNAL = { ...mdb.INTERNAL, layoutPreference: storeModel() };
  delete process.env.CONTENT_WIDTH_DEFAULT;
});
afterEach(() => { delete process.env.CONTENT_WIDTH_DEFAULT; });

describe('page width resolution', () => {
  it('is standard when nobody has chosen anything', async () => {
    assert.deepEqual(await layoutPreference.resolve(user), { width: 'standard', source: 'default' });
    assert.equal(layoutPreference.companyDefault(), 'standard');
  });

  it('uses the company default over standard, and the person\'s own choice over both', async () => {
    process.env.CONTENT_WIDTH_DEFAULT = 'wide';
    assert.deepEqual(await layoutPreference.resolve(user), { width: 'wide', source: 'company' });

    await layoutPreference.save('u-1', { contentWidth: 'full' });
    assert.deepEqual(await layoutPreference.resolve(user), { width: 'full', source: 'user' });

    await layoutPreference.reset('u-1');
    assert.equal((await layoutPreference.resolve(user)).source, 'company');
  });

  it('ignores an unknown company default', async () => {
    process.env.CONTENT_WIDTH_DEFAULT = 'enormous';
    assert.deepEqual(await layoutPreference.resolve(user), { width: 'standard', source: 'default' });
  });

  it('falls back when there is no database', async () => {
    mdb.INTERNAL = { ...mdb.INTERNAL, layoutPreference: undefined };
    assert.equal((await layoutPreference.resolve(user)).width, 'standard');
    await assert.rejects(() => layoutPreference.save('u-1', { contentWidth: 'wide' }), /unavailable/);
  });
});

describe('the account form', () => {
  it('accepts every listed width and refuses anything else', () => {
    for (const w of layoutPreference.WIDTHS) {
      assert.deepEqual(layoutPreference.fromForm({ contentWidth: w.value }), { contentWidth: w.value });
    }
    assert.throws(() => layoutPreference.fromForm({ contentWidth: 'huge' }), /does not exist/);
    assert.throws(() => layoutPreference.fromForm({}), /does not exist/);
  });

  it('offers the same widths as the company setting', () => {
    const entry = registry.findKey(layoutPreference.CONFIG_KEY);
    assert.ok(entry, 'CONTENT_WIDTH_DEFAULT is a managed setting');
    assert.deepEqual(entry.options.map((o) => o.value).sort(), layoutPreference.WIDTHS.map((w) => w.value).sort());
  });
});
