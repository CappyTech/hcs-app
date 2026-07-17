const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

/*
 * Covers the DB-driven notification gating + unsubscribe-footer logic added on
 * top of the email outbox. Patches the mdb singleton (same approach as
 * notificationService.test.js) so no real database is required.
 */
const mdb = require('../mongoose/services/mongooseDatabaseService');
const notificationService = require('../services/notificationService');
const emailPreferenceService = require('../mongoose/services/emailPreferenceService');

// A chainable stub usable for findOne(...).lean() AND findOne(...).select().lean()
function query(val) {
  return { lean: async () => val, select: () => ({ lean: async () => val }) };
}

let createdDocs = [];

/**
 * @param {object} cfg
 *   type: emailType doc (or null) returned for any key
 *   prefRow: emailPreference row (or null)
 *   user: recipient user doc (or null)
 */
function patchMdb(cfg = {}) {
  createdDocs = [];
  const { type = null, prefRow = null, user = null } = cfg;
  mdb.INTERNAL = {
    emailType: {
      findOne: () => query(type),
      create: async (d) => d,
    },
    emailPreference: {
      findOne: () => query(prefRow),
      findOneAndUpdate: async () => ({}),
    },
    user: {
      findById: () => query(user),
      findOne: () => query(user),
      updateOne: async () => ({}),
    },
    notification: {
      create: async (doc) => { createdDocs.push(doc); return doc; },
      findOne: () => query(null),
    },
  };
}

const systemSubscribable = { key: 'task-assigned', label: 'Task', senderType: 'system', subscribable: true, defaultOn: true, enabled: true };
const adminDirect = { key: 'admin-message', label: 'Admin', senderType: 'admin', subscribable: false, defaultOn: true, enabled: true };

describe('emailPreferenceService.isSubscribed', () => {
  beforeEach(() => patchMdb());

  it('non-subscribable types are always subscribed', async () => {
    const t = { key: 'security', subscribable: false, defaultOn: false };
    assert.equal(await emailPreferenceService.isSubscribed('u1', 'security', t), true);
  });

  it('falls back to defaultOn=true when no explicit preference exists', async () => {
    patchMdb({ prefRow: null });
    assert.equal(await emailPreferenceService.isSubscribed('u1', 'task-assigned', systemSubscribable), true);
  });

  it('falls back to defaultOn=false when no explicit preference exists', async () => {
    patchMdb({ prefRow: null });
    const t = { ...systemSubscribable, defaultOn: false };
    assert.equal(await emailPreferenceService.isSubscribed('u1', 'task-assigned', t), false);
  });

  it('an explicit unsubscribe wins over defaultOn', async () => {
    patchMdb({ prefRow: { subscribed: false } });
    assert.equal(await emailPreferenceService.isSubscribed('u1', 'task-assigned', systemSubscribable), false);
  });
});

describe('notificationService.enqueue gating', () => {
  it('skips a disabled type', async () => {
    patchMdb({ type: { ...systemSubscribable, enabled: false }, user: { _id: 'u1', notificationToken: 't' } });
    const doc = await notificationService.enqueue({ to: 'a@b.com', subject: 'S', text: 'B', typeKey: 'task-assigned', senderType: 'system' });
    assert.equal(doc, null);
    assert.equal(createdDocs.length, 0);
  });

  it('skips when the recipient has unsubscribed from a subscribable type', async () => {
    patchMdb({ type: systemSubscribable, prefRow: { subscribed: false }, user: { _id: 'u1', notificationToken: 't' } });
    const doc = await notificationService.enqueue({ to: 'a@b.com', subject: 'S', text: 'B', typeKey: 'task-assigned', senderType: 'system', recipientUserId: 'u1' });
    assert.equal(doc, null);
  });

  it('skips admin email when the recipient blocks admin contact', async () => {
    patchMdb({ type: adminDirect, user: { _id: 'u1', allowAdminEmails: false, notificationToken: 't' } });
    const doc = await notificationService.enqueue({ to: 'a@b.com', subject: 'S', text: 'B', typeKey: 'admin-message', senderType: 'admin', recipientUserId: 'u1' });
    assert.equal(doc, null);
  });

  it('queues a subscribed system notification', async () => {
    patchMdb({ type: systemSubscribable, prefRow: { subscribed: true }, user: { _id: 'u1', notificationToken: 't' } });
    const doc = await notificationService.enqueue({ to: 'a@b.com', subject: 'S', text: 'B', typeKey: 'task-assigned', senderType: 'system', recipientUserId: 'u1' });
    assert.ok(doc);
    assert.equal(createdDocs.length, 1);
    assert.equal(createdDocs[0].typeKey, 'task-assigned');
    assert.equal(createdDocs[0].unsubscribable, true);
  });
});

describe('notificationService.buildFooter variants', () => {
  it('system + subscribable → system notification with token unsubscribe link', () => {
    const { html, text } = notificationService.buildFooter({ senderType: 'system', subscribable: true, typeKey: 'task-assigned', token: 'tok123' });
    assert.match(text, /system notification email/i);
    // Scope is baked into the signed token, so the URL carries only the token.
    assert.match(html, /\/notifications\/unsubscribe\?token=tok123/);
  });

  it('admin + non-subscribable → cannot unsubscribe, offers to block admins', () => {
    const { html, text } = notificationService.buildFooter({ senderType: 'admin', subscribable: false, typeKey: 'admin-message', token: 'tok123' });
    assert.match(text, /sent by an administrator/i);
    assert.match(text, /change your notification settings/i);
    assert.match(html, /\/notifications\/unsubscribe\?token=tok123/);
  });

  it('admin + subscribable → admin notification email', () => {
    const { text } = notificationService.buildFooter({ senderType: 'admin', subscribable: true, typeKey: 'promo', token: 'tok123' });
    assert.match(text, /admin notification email/i);
  });

  it('user self-send → user notification email', () => {
    const { text } = notificationService.buildFooter({ senderType: 'user', subscribable: true, typeKey: 'task-assigned', token: 'tok123' });
    assert.match(text, /user notification email/i);
  });

  it('non-subscribable system (mandatory) → no unsubscribe link', () => {
    const { html } = notificationService.buildFooter({ senderType: 'system', subscribable: false, typeKey: 'security', token: 'tok123' });
    assert.doesNotMatch(html, /unsubscribe\?token/);
    assert.match(html, /cannot be unsubscribed/i);
  });
});
