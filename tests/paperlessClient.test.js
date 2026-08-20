import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * The Accept header this client sends names a Paperless API version, and
 * Paperless retires old versions: 3.0.5 serves only 9 and 10, which turned the
 * built-in default of `version=6` into an HTTP 406 on every call at once —
 * document listing, custom fields, the 6-hourly bank-statement ingest, the lot.
 *
 * These drive a real server rather than reading the source, because what matters
 * is the retry actually completing: the fallback is registered on an axios
 * instance built inside makeClient(), so a source assertion would not catch it
 * being registered on the wrong instance or after the request is issued.
 */
describe('paperlessClient Accept-version fallback', () => {
  let server;
  let baseURL;
  /** @type {Array<{url: string, accept: string|undefined}>} */
  let received = [];
  /** Status returned while an Accept header naming a version is present. */
  let rejectVersionedWith = 406;

  before(async () => {
    server = http.createServer((req, res) => {
      const accept = req.headers.accept;
      received.push({ url: req.url, accept });
      if (accept && /version=/.test(accept)) {
        res.writeHead(rejectVersionedWith, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: 'Invalid version in "Accept" header.' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ count: 1, next: null, results: [{ id: 42 }] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${server.address().port}/api`;

    process.env.PAPERLESS_TOKEN = 'test-token';
    process.env.PAPERLESS_BASE_URL = baseURL;
    process.env.PAPERLESS_SSH_TUNNEL_ENABLED = 'false';
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  const freshClient = async () => {
    const mod = await import('../mongoose/services/paperless/paperlessClient.js');
    return mod.default.makeClient();
  };

  it('retries without the Accept header when the server answers 406', async () => {
    received = [];
    rejectVersionedWith = 406;
    process.env.PAPERLESS_ACCEPT = 'application/json; version=6';

    const client = await freshClient();
    const data = await client.listDocuments({ page: 1, pageSize: 1 });

    assert.equal(data.count, 1, 'the retry should have returned the real payload');
    assert.equal(received.length, 2, 'expected one rejected call and one retry');
    assert.match(received[0].accept, /version=6/);
    assert.ok(
      !received[1].accept || !/version=/.test(received[1].accept),
      `retry still carried a versioned Accept: ${received[1].accept}`,
    );
  });

  it('still retries on 400, which some installs answer instead', async () => {
    received = [];
    rejectVersionedWith = 400;
    process.env.PAPERLESS_ACCEPT = 'application/json; version=6';

    const client = await freshClient();
    const data = await client.listDocuments({ page: 1, pageSize: 1 });

    assert.equal(data.count, 1);
    assert.equal(received.length, 2);
  });

  it('does not retry forever when the server rejects the unversioned request too', async () => {
    received = [];
    rejectVersionedWith = 406;
    process.env.PAPERLESS_ACCEPT = 'application/json; version=6';

    // A server that 406s regardless of what is asked for: the fallback must give
    // up after one attempt rather than looping.
    const strict = http.createServer((req, res) => {
      received.push({ url: req.url, accept: req.headers.accept });
      res.writeHead(406, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: 'Invalid version in "Accept" header.' }));
    });
    await new Promise((resolve) => strict.listen(0, '127.0.0.1', resolve));
    process.env.PAPERLESS_BASE_URL = `http://127.0.0.1:${strict.address().port}/api`;

    try {
      const client = await freshClient();
      await assert.rejects(
        () => client.listDocuments({ page: 1, pageSize: 1 }),
        /406/,
      );
      assert.equal(received.length, 2, 'expected exactly one retry, then failure');
    } finally {
      process.env.PAPERLESS_BASE_URL = baseURL;
      await new Promise((resolve) => strict.close(resolve));
    }
  });
});
