import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import mdb from '../mongoose/services/mongooseDatabaseService.js';
import svc from '../mongoose/services/unsubscribeRotationService.js';

let users = [];
let updates = [];
let jobStateDoc = null;

function patchMdb() {
  users = [{ _id: 'u1', notificationToken: 'a' }, { _id: 'u2', notificationToken: 'b' }];
  updates = [];
  jobStateDoc = null;
  mdb.INTERNAL = {
    user: {
      find: () => ({ select: () => ({ lean: async () => users.map((u) => ({ _id: u._id })) }) }),
      updateOne: async (q, patch) => { updates.push({ id: q._id, patch }); },
    },
    jobState: {
      findOne: () => ({ lean: async () => jobStateDoc }),
      findOneAndUpdate: (q, patch) => ({ lean: async () => { jobStateDoc = { name: q.name, ...patch }; return jobStateDoc; } }),
    },
  };
}

describe('unsubscribeRotationService', () => {
  beforeEach(() => { patchMdb(); delete process.env.UNSUBSCRIBE_ROTATION_ENABLED; });
  afterEach(() => { delete process.env.UNSUBSCRIBE_ROTATION_ENABLED; });

  it('rotates every user when due and records last run', async () => {
    const res = await svc.rotateAll({ trigger: 'test' });
    assert.equal(res.rotated, 2);
    assert.equal(updates.length, 2);
    assert.ok(updates.every((u) => typeof u.patch.notificationToken === 'string' && u.patch.notificationToken.length > 0));
    assert.equal(jobStateDoc.lastOutcome, 'ok');
  });

  it('skips when a rotation ran recently (not forced)', async () => {
    jobStateDoc = { name: svc.JOB_NAME, lastRunAt: new Date() }; // just ran
    const res = await svc.rotateAll({ trigger: 'test' });
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'not-due');
    assert.equal(updates.length, 0);
  });

  it('force rotates even when recent (manual admin trigger)', async () => {
    jobStateDoc = { name: svc.JOB_NAME, lastRunAt: new Date() };
    const res = await svc.rotateAll({ force: true, trigger: 'manual' });
    assert.equal(res.rotated, 2);
  });

  it('skips entirely when disabled via config', async () => {
    process.env.UNSUBSCRIBE_ROTATION_ENABLED = 'false';
    const res = await svc.rotateAll({ trigger: 'test' });
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'disabled');
    assert.equal(updates.length, 0);
  });

  it('force overrides the disabled flag (explicit admin action)', async () => {
    process.env.UNSUBSCRIBE_ROTATION_ENABLED = 'false';
    const res = await svc.rotateAll({ force: true, trigger: 'manual' });
    assert.equal(res.rotated, 2);
  });
});
