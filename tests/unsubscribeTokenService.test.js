import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// A stable server secret so sign/verify agree across the test run.
process.env.UNSUBSCRIBE_SECRET = process.env.UNSUBSCRIBE_SECRET || 'test-unsub-secret';

import mdb from '../mongoose/services/mongooseDatabaseService.js';
import svc from '../mongoose/services/unsubscribeTokenService.js';

// Minimal user store keyed by id, returning the CURRENT notificationToken.
let store = {};
function patchMdb() {
  store = {};
  mdb.INTERNAL = {
    user: {
      findById: (id) => ({ lean: async () => store[String(id)] || null }),
    },
  };
}

describe('unsubscribeTokenService', () => {
  beforeEach(patchMdb);

  it('signs and verifies a type-scoped token', async () => {
    store.u1 = { _id: 'u1', email: 'a@b.com', notificationToken: 'nt-1' };
    const token = svc.sign({ userId: 'u1', scope: 'type:task-assigned', notificationToken: 'nt-1' });
    const res = await svc.verify(token);
    assert.equal(res.ok, true);
    assert.equal(res.user._id, 'u1');
    assert.deepEqual(svc.parseScope(res.scope), { kind: 'type', typeKey: 'task-assigned' });
  });

  it('verifies the admin-contact scope', async () => {
    store.u1 = { _id: 'u1', notificationToken: 'nt-1' };
    const token = svc.sign({ userId: 'u1', scope: 'admin', notificationToken: 'nt-1' });
    const res = await svc.verify(token);
    assert.equal(res.ok, true);
    assert.deepEqual(svc.parseScope(res.scope), { kind: 'admin-contact' });
  });

  it('rejects a tampered payload (bad-signature)', async () => {
    store.u1 = { _id: 'u1', notificationToken: 'nt-1' };
    store.u2 = { _id: 'u2', notificationToken: 'nt-2' };
    const token = svc.sign({ userId: 'u1', scope: 'type:x', notificationToken: 'nt-1' });
    // Swap the payload for one pointing at u2 while keeping u1's signature.
    const forgedPayload = Buffer.from(JSON.stringify({ u: 'u2', s: 'admin', e: Math.floor(Date.now() / 1000) + 999 }))
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const forged = `${forgedPayload}.${token.split('.')[1]}`;
    const res = await svc.verify(forged);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'bad-signature');
  });

  it('rejects an expired token', async () => {
    store.u1 = { _id: 'u1', notificationToken: 'nt-1' };
    const token = svc.sign({ userId: 'u1', scope: 'type:x', notificationToken: 'nt-1', ttlDays: -1 });
    const res = await svc.verify(token);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'expired');
  });

  it('rejects after the user rotates their notificationToken', async () => {
    store.u1 = { _id: 'u1', notificationToken: 'nt-1' };
    const token = svc.sign({ userId: 'u1', scope: 'type:x', notificationToken: 'nt-1' });
    assert.equal((await svc.verify(token)).ok, true); // valid now
    store.u1.notificationToken = 'nt-rotated'; // rotation job (or manual reset) ran
    const res = await svc.verify(token);
    assert.equal(res.ok, false); // old link dead
    assert.equal(res.reason, 'bad-signature');
  });

  it('rejects garbage and unknown users', async () => {
    assert.equal((await svc.verify('not-a-token')).reason, 'malformed');
    assert.equal((await svc.verify('')).reason, 'malformed');
    const token = svc.sign({ userId: 'ghost', scope: 'admin', notificationToken: 'x' });
    assert.equal((await svc.verify(token)).reason, 'unknown-user');
  });
});
