import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import firstRun, { firstRunGate, needsFirstRun, seedBaseUrl } from '../services/firstRunService.js';

/**
 * The user-count gate: while INTERNAL.user is empty every request goes to
 * /setup; once a user exists the gate stands aside and stops querying.
 */
describe('firstRunService', () => {
  describe('needsFirstRun', () => {
    beforeEach(() => firstRun.reset());

    it('is true while the collection is empty, and keeps asking', async () => {
      let calls = 0;
      const model = { countDocuments: async () => { calls++; return 0; } };
      assert.equal(await needsFirstRun(model), true);
      assert.equal(await needsFirstRun(model), true);
      assert.equal(calls, 2);
    });

    it('remembers once a user exists and never queries again', async () => {
      let calls = 0;
      const model = { countDocuments: async () => { calls++; return 1; } };
      assert.equal(await needsFirstRun(model), false);
      assert.equal(await needsFirstRun(model), false);
      assert.equal(calls, 1);
    });

    it('stands aside when there is no model yet', async () => {
      assert.equal(await needsFirstRun(undefined), false);
    });
  });

  describe('firstRunGate over a real express app', () => {
    let server;
    let origin;
    let count = 0;
    let failCount = false;
    const model = {
      countDocuments: async () => {
        if (failCount) throw new Error('boom');
        return count;
      },
    };

    before(async () => {
      const app = express();
      const setupRouter = express.Router();
      setupRouter.get('/setup', (_req, res) => res.type('text/plain').send('first-run page'));
      app.use(firstRunGate(() => model, setupRouter));
      app.get('/', (_req, res) => res.type('text/plain').send('home'));
      app.get('/setup', (_req, res) => res.type('text/plain').send('not the first-run page'));
      app.use((_req, res) => res.status(404).type('text/plain').send('404'));
      server = app.listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      origin = `http://127.0.0.1:${server.address().port}`;
    });

    after(() => new Promise((resolve) => server.close(resolve)));

    beforeEach(() => {
      firstRun.reset();
      count = 0;
      failCount = false;
    });

    it('redirects every request to /setup while there are no users', async () => {
      for (const p of ['/', '/user/login', '/CIS/Dashboard', '/api/web/content']) {
        const res = await fetch(`${origin}${p}`, { redirect: 'manual' });
        assert.equal(res.status, 302, p);
        assert.equal(res.headers.get('location'), '/setup', p);
      }
    });

    it('serves /setup from the first-run router while there are no users', async () => {
      const res = await fetch(`${origin}/setup`);
      assert.equal(await res.text(), 'first-run page');
    });

    it('lets everything through once a user exists, including /setup', async () => {
      count = 1;
      assert.equal(await (await fetch(`${origin}/`)).text(), 'home');
      assert.equal(await (await fetch(`${origin}/setup`)).text(), 'not the first-run page');
    });

    it('does not trap users on the setup page when the count itself fails', async () => {
      failCount = true;
      assert.equal(await (await fetch(`${origin}/`)).text(), 'home');
    });

    it('markHasUsers satisfies the gate without a query', async () => {
      firstRun.markHasUsers();
      failCount = true; // would throw if queried
      assert.equal(await (await fetch(`${origin}/`)).text(), 'home');
    });
  });

  describe('seedBaseUrl', () => {
    beforeEach(() => firstRun.resetBaseUrlSeed());

    function run(mw, req) {
      return new Promise((resolve) => {
        const r = { protocol: 'https', get: (h) => (h === 'host' ? req.host : undefined), user: req.user };
        mw(r, {}, resolve);
      });
    }

    it('stores the first signed-in request\'s origin when BASE_URL is unset', async () => {
      const writes = [];
      const store = { set: async (k, v, by) => writes.push([k, v, by]) };
      const cfg = { get: () => '' };
      const mw = seedBaseUrl(store, { configService: cfg });
      await run(mw, { host: 'app.example.test', user: { username: 'jane' } });
      await run(mw, { host: 'other.example.test', user: { username: 'jane' } });
      assert.deepEqual(writes, [['BASE_URL', 'https://app.example.test', 'jane']]);
    });

    it('does nothing when BASE_URL already has a value, or nobody is signed in', async () => {
      const writes = [];
      const store = { set: async (...a) => writes.push(a) };
      await run(seedBaseUrl(store, { configService: { get: () => 'https://set.example.test' } }), { host: 'h', user: { username: 'x' } });
      await run(seedBaseUrl(store, { configService: { get: () => '' } }), { host: 'h', user: null });
      assert.deepEqual(writes, []);
    });
  });
});
