import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'test-key-for-unit-tests-only';
process.env.HCS_SYNC_API_KEY = 'sync-key-for-tests';
process.env.STAFFOLOGY_API_KEY = 'staffology-key-for-tests';
process.env.STAFFOLOGY_EMPLOYER_ID = 'employer-for-tests';

const { staffologyConfigForSync } = await import('../mongoose/controllers/ssoController.js');
const { PUBLIC_PATHS_FOR_TEST } = await import('../services/authService.js');

function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    json(b) { this.body = b; return this; },
  };
}

describe('GET /api/sync/staffology-config', () => {
  it('is reachable without a session (it authenticates with the sync key)', () => {
    assert.ok(PUBLIC_PATHS_FOR_TEST.has('/api/sync/staffology-config'));
  });

  it('refuses a missing or wrong sync key', async () => {
    for (const key of [undefined, 'wrong']) {
      const res = fakeRes();
      await staffologyConfigForSync({ headers: key ? { 'x-sync-api-key': key } : {} }, res);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.apiKey, undefined);
    }
  });

  it('returns the Staffology settings, uncached, for the right key', async () => {
    const res = fakeRes();
    await staffologyConfigForSync({ headers: { 'x-sync-api-key': 'sync-key-for-tests' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { apiKey: 'staffology-key-for-tests', employerId: 'employer-for-tests' });
    assert.equal(res.headers['Cache-Control'], 'no-store');
  });

  describe('with no sync key configured', () => {
    let saved;
    before(() => { saved = process.env.HCS_SYNC_API_KEY; delete process.env.HCS_SYNC_API_KEY; });
    after(() => { process.env.HCS_SYNC_API_KEY = saved; });
    it('is disabled (503)', async () => {
      const res = fakeRes();
      await staffologyConfigForSync({ headers: { 'x-sync-api-key': 'anything' } }, res);
      assert.equal(res.statusCode, 503);
    });
  });
});
