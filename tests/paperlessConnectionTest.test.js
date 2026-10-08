import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.PAPERLESS_URL = 'mock';

import paperlessClient from '../mongoose/services/paperless/paperlessClient.js';
import { testConnection } from '../mongoose/controllers/connectionSettingsController.js';
import mockPaperless from '../mongoose/services/paperless/mock/paperlessMockClient.js';

const { buildPaperlessBaseURL } = paperlessClient;

/** The Paperless "Test connection" button on /admin/config/paperless. */
describe('the Paperless API address', () => {
  it('adds the scheme and /api the way the app always has', () => {
    assert.equal(buildPaperlessBaseURL({ PAPERLESS_BASE_URL: 'https://docs.heroncs.co.uk' }), 'https://docs.heroncs.co.uk/api');
    assert.equal(buildPaperlessBaseURL({ PAPERLESS_BASE_URL: 'https://docs.heroncs.co.uk/api/' }), 'https://docs.heroncs.co.uk/api/');
    assert.equal(buildPaperlessBaseURL({ PAPERLESS_BASE_URL: 'docs.heroncs.co.uk', NO_PORT: 'true' }), 'https://docs.heroncs.co.uk/api');
    assert.equal(buildPaperlessBaseURL({ PAPERLESS_BASE_URL: 'paperless', PAPERLESS_PORT: '8000' }), 'http://paperless:8000/api');
    assert.equal(buildPaperlessBaseURL({}), null);
  });
});

describe('Test connection', () => {
  const saved = {};
  const KEYS = ['PAPERLESS_BASE_URL', 'PAPERLESS_TOKEN', 'PAPERLESS_SSH_TUNNEL_ENABLED'];
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    mockPaperless.resetMockPaperless();
  });
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
  const run = async () => {
    const flashed = [];
    const req = { params: { service: 'paperless' }, get: () => '/admin/config/paperless', flash: (type, msg) => flashed.push([type, msg]) };
    let to = null;
    await testConnection(req, { redirect: (u) => { to = u; } });
    return { flashed, to };
  };

  it('goes through the app client, so a base URL without /api passes as it does for the app', async () => {
    // Set like the live server: no /api. The old test fetched <base>/documents/, got the web page and failed
    Object.assign(process.env, { PAPERLESS_BASE_URL: 'https://docs.heroncs.co.uk', PAPERLESS_TOKEN: 't' });
    const { flashed, to } = await run();
    assert.equal(to, '/admin/config/paperless');
    assert.equal(flashed[0][0], 'success');
    assert.match(flashed[0][1], /^Paperless reachable at https:\/\/docs\.heroncs\.co\.uk\/api: \d+ document\(s\) visible to this token\.$/);
  });

  it('says what is missing, and what went wrong', async () => {
    delete process.env.PAPERLESS_TOKEN;
    process.env.PAPERLESS_BASE_URL = 'https://docs.heroncs.co.uk';
    assert.deepEqual((await run()).flashed, [['error', 'paperless test failed: Paperless base URL or token not configured.']]);

    process.env.PAPERLESS_TOKEN = 't';
    mockPaperless.mockPaperlessState().failNext.add('listDocuments');
    const { flashed } = await run();
    assert.equal(flashed[0][0], 'error');
    assert.match(flashed[0][1], /^paperless test failed: https:\/\/docs\.heroncs\.co\.uk\/api: /);
  });
});
