import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import NotificationLogDef, { ONE_SHOT_KINDS } from '../mongoose/models/mongoose/PAPERLESS/NotificationLog.js';
import notificationLog from '../mongoose/services/paperless/notificationLogService.js';

const { claimOneShot, recordRepeatable, completeNotification, hasOneShot } = notificationLog;

/**
 * H2: the partial unique index on (paperlessId, kind) is what makes one-shot
 * notifications exactly-once, replacing the notified/* tags.
 *
 * There is no MongoDB in the unit-test run, so the fake below enforces the
 * unique indexes *as the schema declares them* — including the partial
 * filter. Weakening the schema's index makes these tests fail. The block at
 * the bottom proves the same against a real server when TEST_MONGO_URI is set.
 */
const Model = new mongoose.Mongoose().model(NotificationLogDef.modelName, NotificationLogDef.schema);

const uniqueIndexes = NotificationLogDef.schema.indexes().filter(([, opts]) => opts?.unique);

const matchesPartial = (row, partial) =>
  !partial || Object.entries(partial).every(([k, v]) => row[k] === v);

function fakeNotificationLog() {
  const rows = [];
  return {
    rows,
    async create(data) {
      const doc = new Model(data);
      await doc.validate(); // runs the pre-validate hook that sets oneShot
      const row = doc.toObject();
      for (const [keys, opts] of uniqueIndexes) {
        if (!matchesPartial(row, opts.partialFilterExpression)) continue;
        const clash = rows.find((r) =>
          matchesPartial(r, opts.partialFilterExpression) &&
          Object.keys(keys).every((k) => r[k] === row[k]));
        if (clash) {
          const err = new Error(`E11000 duplicate key error collection: notificationlogs index: ${opts.name}`);
          err.code = 11000;
          throw err;
        }
      }
      rows.push(row);
      return row;
    },
    findOne(filter) {
      const hit = rows.find((r) => Object.entries(filter).every(([k, v]) => r[k] === v)) || null;
      return { lean: async () => hit };
    },
    async exists(filter) {
      return rows.some((r) => Object.entries(filter).every(([k, v]) => r[k] === v)) ? { _id: 1 } : null;
    },
    async updateOne(filter, update) {
      const r = rows.find((x) => String(x._id) === String(filter._id));
      if (r) Object.assign(r, update.$set);
    },
  };
}

describe('NotificationLog schema', () => {
  it('declares a unique index on (paperlessId, kind) limited to one-shot rows', () => {
    const idx = uniqueIndexes.find(([keys]) => keys.paperlessId === 1 && keys.kind === 1);
    assert.ok(idx, 'missing unique (paperlessId, kind) index');
    assert.deepEqual(idx[1].partialFilterExpression, { oneShot: true });
  });

  it('derives oneShot from kind', async () => {
    for (const kind of ONE_SHOT_KINDS) {
      const d = new Model({ paperlessId: 1, kind });
      await d.validate();
      assert.equal(d.oneShot, true, kind);
    }
    const resend = new Model({ paperlessId: 1, kind: 'john_resend', oneShot: true });
    await resend.validate();
    assert.equal(resend.oneShot, false, 'a caller cannot make a re-send unique');
  });

  it('rejects an unknown kind', async () => {
    await assert.rejects(new Model({ paperlessId: 1, kind: 'bev' }).validate());
  });
});

describe('claimOneShot', () => {
  let NL;
  beforeEach(() => { NL = fakeNotificationLog(); });

  it('lets exactly one claim win per document and kind', async () => {
    const first = await claimOneShot(NL, 9002, 'john');
    const second = await claimOneShot(NL, 9002, 'john');
    assert.equal(first.claimed, true);
    assert.equal(second.claimed, false);
    assert.equal(String(second.existing._id), String(first.entry._id));
    assert.equal(NL.rows.length, 1);
  });

  it('lets exactly one of several concurrent claims win', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => claimOneShot(NL, 9002, 'kashflow')));
    assert.equal(results.filter((r) => r.claimed).length, 1);
  });

  it('treats each kind and each document separately', async () => {
    assert.equal((await claimOneShot(NL, 9002, 'john')).claimed, true);
    assert.equal((await claimOneShot(NL, 9002, 'kashflow')).claimed, true);
    assert.equal((await claimOneShot(NL, 9003, 'john')).claimed, true);
  });

  it('refuses a repeatable kind', async () => {
    await assert.rejects(claimOneShot(NL, 9002, 'john_resend'), /not a one-shot/);
  });

  it('rethrows errors other than a duplicate key', async () => {
    NL.create = async () => { throw new Error('connection reset'); };
    await assert.rejects(claimOneShot(NL, 9002, 'john'), /connection reset/);
  });

  it('records the actor without the admin flag', async () => {
    const userId = new mongoose.Types.ObjectId();
    const { entry } = await claimOneShot(NL, 9002, 'statement', { actor: { userId, name: 'bev', isAdmin: true } });
    assert.deepEqual({ ...entry.triggeredBy }, { userId, name: 'bev' });
  });
});

describe('recordRepeatable / completeNotification / hasOneShot', () => {
  it('records every re-send to John', async () => {
    const NL = fakeNotificationLog();
    await claimOneShot(NL, 9002, 'john');
    await recordRepeatable(NL, 9002, 'john_resend');
    await recordRepeatable(NL, 9002, 'john_resend');
    await recordRepeatable(NL, 9002, 'john_resend');
    assert.equal(NL.rows.filter((r) => r.kind === 'john_resend').length, 3);
  });

  it('refuses a one-shot kind as a repeatable', async () => {
    await assert.rejects(recordRepeatable(fakeNotificationLog(), 9002, 'john'), /not a repeatable/);
  });

  it('records the outcome and reports what has been sent', async () => {
    const NL = fakeNotificationLog();
    assert.equal(await hasOneShot(NL, 9002, 'john'), false);
    const { entry } = await claimOneShot(NL, 9002, 'john', { mode: 'shadow' });
    await completeNotification(NL, entry._id, { status: 'shadow', channels: [{ channel: 'email', status: 'shadow' }] });
    assert.equal(NL.rows[0].status, 'shadow');
    assert.equal(await hasOneShot(NL, 9002, 'john'), true);
    await assert.rejects(completeNotification(NL, entry._id, { status: 'done' }), /Invalid completion status/);
  });
});

// Real-server proof of the index. Skipped unless TEST_MONGO_URI points at a
// throwaway MongoDB, e.g.:
//   docker run --rm -d -p 27099:27017 mongo:7
//   TEST_MONGO_URI=mongodb://127.0.0.1:27099/hcs_test npm test
describe('NotificationLog index on a real MongoDB', { skip: !process.env.TEST_MONGO_URI && 'TEST_MONGO_URI not set' }, () => {
  let conn;
  let RealNL;

  before(async () => {
    conn = await mongoose.createConnection(process.env.TEST_MONGO_URI).asPromise();
    RealNL = conn.model(NotificationLogDef.modelName, NotificationLogDef.schema);
    await RealNL.deleteMany({});
    await RealNL.syncIndexes();
  });
  after(async () => {
    await conn.dropDatabase();
    await conn.close();
  });

  it('rejects a duplicate one-shot and allows repeated re-sends', async () => {
    assert.equal((await claimOneShot(RealNL, 1, 'john')).claimed, true);
    assert.equal((await claimOneShot(RealNL, 1, 'john')).claimed, false);
    await recordRepeatable(RealNL, 1, 'john_resend');
    await recordRepeatable(RealNL, 1, 'john_resend');
    assert.equal(await RealNL.countDocuments({ paperlessId: 1 }), 3);
  });
});
