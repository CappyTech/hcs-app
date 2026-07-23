import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

/*
 * The store reaches MongoDB through the mdb singleton's INTERNAL connection;
 * patch it with a fake native collection.
 */
import mdb from '../mongoose/services/mongooseDatabaseService.js';

let coll;

function makeCollection() {
  return {
    createIndex: mock.fn(async () => {}),
    findOneAndUpdate: mock.fn(async () => null),
    updateOne: mock.fn(async () => ({})),
    deleteOne: mock.fn(async () => ({})),
  };
}

function patchMdb({ connected = true } = {}) {
  coll = makeCollection();
  mdb.INTERNAL = {
    ...mdb.INTERNAL,
    connection: connected
      ? { readyState: 1, db: { collection: () => coll } }
      : { readyState: 0 },
  };
}

import RateLimitMongoStore from '../services/rateLimitMongoStore.js';

function makeStore() {
  const store = new RateLimitMongoStore({ prefix: 'test:' });
  store.init({ windowMs: 60_000 });
  return store;
}

describe('rateLimitMongoStore', () => {
  beforeEach(() => patchMdb());

  it('increments an existing live bucket', async () => {
    const resetTime = new Date(Date.now() + 30_000);
    coll.findOneAndUpdate = mock.fn(async () => ({ hits: 7, expiresAt: resetTime }));

    const store = makeStore();
    const result = await store.increment('1.2.3.4');

    assert.equal(result.totalHits, 7);
    assert.equal(result.resetTime, resetTime);
    assert.equal(coll.findOneAndUpdate.mock.calls[0].arguments[0]._id, 'test:1.2.3.4');
  });

  it('starts a fresh window when no live bucket exists', async () => {
    const store = makeStore();
    const before = Date.now();
    const result = await store.increment('1.2.3.4');

    assert.equal(result.totalHits, 1);
    assert.ok(result.resetTime.getTime() >= before + 60_000 - 5);
    assert.equal(coll.updateOne.mock.calls.length, 1);
    assert.deepEqual(coll.updateOne.mock.calls[0].arguments[2], { upsert: true });
  });

  it('fails open while MongoDB is not connected', async () => {
    patchMdb({ connected: false });
    const store = makeStore();
    const result = await store.increment('1.2.3.4');
    assert.equal(result.totalHits, 1);
    assert.ok(result.resetTime instanceof Date);
  });

  it('fails open on a transient database error', async () => {
    coll.findOneAndUpdate = mock.fn(async () => { throw new Error('boom'); });
    const store = makeStore();
    const result = await store.increment('1.2.3.4');
    assert.equal(result.totalHits, 1);
  });

  it('decrement only touches buckets with positive hits', async () => {
    const store = makeStore();
    await store.decrement('1.2.3.4');
    const [filter, update] = coll.updateOne.mock.calls[0].arguments;
    assert.deepEqual(filter, { _id: 'test:1.2.3.4', hits: { $gt: 0 } });
    assert.deepEqual(update, { $inc: { hits: -1 } });
  });

  it('resetKey deletes the bucket', async () => {
    const store = makeStore();
    await store.resetKey('1.2.3.4');
    assert.deepEqual(coll.deleteOne.mock.calls[0].arguments[0], { _id: 'test:1.2.3.4' });
  });
});
