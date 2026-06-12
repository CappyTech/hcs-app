const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const mdb = require('../mongoose/services/mongooseDatabaseService');
const notificationService = require('../services/notificationService');

let enqueueCalls = [];
const origEnqueueForRoles = notificationService.enqueueForRoles;

function patchAll({ policies = [] } = {}) {
  enqueueCalls = [];
  notificationService.enqueueForRoles = mock.fn(async (roles, payload) => {
    enqueueCalls.push({ roles, payload });
    return { queued: 1, recipients: 1 };
  });

  mdb.INTERNAL = {
    ...mdb.INTERNAL,
    policyDocument: {
      find: mock.fn(() => ({
        sort: mock.fn(() => ({ lean: mock.fn(() => Promise.resolve(policies)) })),
      })),
    },
  };
}

const { checkAndQueueReminders } = require('../mongoose/services/policyReviewReminderService');

function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

describe('policyReviewReminderService', () => {
  beforeEach(() => patchAll());

  it('returns early when the model is unavailable', async () => {
    const orig = mdb.INTERNAL.policyDocument;
    mdb.INTERNAL.policyDocument = undefined;
    const stats = await checkAndQueueReminders();
    assert.deepStrictEqual(stats, { due: 0, queued: 0 });
    mdb.INTERNAL.policyDocument = orig;
  });

  it('queues nothing when no policies are due', async () => {
    patchAll({ policies: [] });
    const stats = await checkAndQueueReminders();
    assert.equal(stats.due, 0);
    assert.equal(enqueueCalls.length, 0);
  });

  it('queues one admin summary listing due and overdue policies', async () => {
    patchAll({
      policies: [
        { title: 'Data Protection Policy', version: '2.1', category: 'GDPR', reviewDate: daysFromNow(-3) },
        { title: 'H&S Policy', version: '1.0', category: 'Health & Safety', reviewDate: daysFromNow(10) },
      ],
    });

    const stats = await checkAndQueueReminders();
    assert.equal(stats.due, 2);
    assert.equal(stats.queued, 1);
    assert.equal(enqueueCalls.length, 1);
    assert.deepEqual(enqueueCalls[0].roles, ['admin']);
    assert.ok(enqueueCalls[0].payload.text.includes('Data Protection Policy'));
    assert.ok(enqueueCalls[0].payload.text.includes('overdue'));
    assert.ok(enqueueCalls[0].payload.dedupeKey.startsWith('policy-review-'));
  });

  it('restores the original enqueueForRoles (cleanup)', () => {
    notificationService.enqueueForRoles = origEnqueueForRoles;
    assert.equal(notificationService.enqueueForRoles, origEnqueueForRoles);
  });
});
