import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import ejs from 'ejs';

/*
 * Notification channels: email, SMS and in-app.
 *  - preference resolution (emailPreferenceService.resolveChannels)
 *  - fan-out per channel with dedupe (notifyService.notifyUsers)
 *  - SMS delivery through the outbox with a mocked smsService
 *  - the in-app store (read / unread) and its controller
 *  - the preferences table, the /notifications page and the header bell
 * Nothing here touches a database, Twilio or a mail server: mdb.INTERNAL is
 * replaced with in-memory fakes, and smsService / emailService are mocked.
 */
// Email enqueue signs a per-recipient unsubscribe link; give it a test secret.
process.env.UNSUBSCRIBE_SECRET = process.env.UNSUBSCRIBE_SECRET || 'test-only-unsubscribe-secret';

import mdb from '../mongoose/services/mongooseDatabaseService.js';
import emailPreferenceService from '../mongoose/services/emailPreferenceService.js';
import emailTypesSeed from '../mongoose/services/emailTypesSeedService.js';
import inAppNotificationService from '../mongoose/services/inAppNotificationService.js';
import inAppController from '../mongoose/controllers/inAppNotificationController.js';
import notificationService from '../services/notificationService.js';
import notifyService from '../services/notifyService.js';
import smsService from '../services/smsService.js';
import emailService from '../services/emailService.js';
import nav from '../services/navigationService.js';

const VIEWS = path.resolve('mongoose/views/tailwindcss');

// ── In-memory fakes ─────────────────────────────────────────────────────
const matches = (doc, query) => Object.entries(query).every(([k, v]) => {
  if (v && typeof v === 'object' && !(v instanceof Date) && '$in' in v) return v.$in.map(String).includes(String(doc[k]));
  if (v === null) return doc[k] == null;
  return String(doc[k]) === String(v);
});
const chain = (value) => {
  const c = {
    select: () => c, sort: () => c, skip: () => c, limit: () => c,
    lean: async () => value,
    then: (res, rej) => Promise.resolve(value).then(res, rej),
  };
  return c;
};

function fakeCollection(initial = []) {
  const rows = initial.map((r) => ({ ...r }));
  return {
    rows,
    find: (q = {}) => chain(rows.filter((r) => matches(r, q))),
    findOne: (q = {}) => chain(rows.find((r) => matches(r, q)) || null),
    countDocuments: async (q = {}) => rows.filter((r) => matches(r, q)).length,
    create: async (doc) => {
      const row = { _id: `id-${rows.length + 1}`, uuid: `uuid-${rows.length + 1}`, createdAt: new Date(), readAt: null, ...doc };
      rows.push(row);
      return row;
    },
    updateOne: async (q, patch) => {
      const r = rows.find((x) => matches(x, q));
      if (r) Object.assign(r, patch);
      return { modifiedCount: r ? 1 : 0 };
    },
    updateMany: async (q, patch) => {
      const hit = rows.filter((x) => matches(x, q));
      hit.forEach((r) => Object.assign(r, patch));
      return { modifiedCount: hit.length };
    },
    findOneAndUpdate: async (q, patch) => {
      let r = rows.find((x) => matches(x, q));
      if (!r) { r = { ...q }; rows.push(r); }
      Object.assign(r, patch);
      return r;
    },
  };
}

const PEOPLE_TYPE = {
  key: 'attendance', label: 'Your weekly attendance', senderType: 'system', enabled: true,
  subscribable: true, defaultOn: true, channels: ['email', 'sms', 'inApp'], smsDefaultOn: false, inAppDefaultOn: true,
};
const SECURITY_TYPE = {
  key: 'security', label: 'Security alerts', senderType: 'system', enabled: true,
  subscribable: false, defaultOn: true, channels: ['email', 'sms', 'inApp'], smsDefaultOn: true, inAppDefaultOn: false,
};
const LEGACY_TYPE = { key: 'holiday', label: 'Holiday requests', senderType: 'system', enabled: true, subscribable: true, defaultOn: true };

const withPhone = { _id: 'u1', email: 'one@example.test', phoneNumber: '+447700900001' };
const noPhone = { _id: 'u2', email: 'two@example.test', phoneNumber: null };

// ── Preference resolution ───────────────────────────────────────────────
describe('emailPreferenceService.resolveChannels', () => {
  it('uses the type defaults when the person has made no choice', () => {
    assert.deepEqual(emailPreferenceService.resolveChannels({ type: PEOPLE_TYPE, pref: null, user: withPhone }),
      { email: true, sms: false, inApp: true });
  });

  it('applies saved choices per channel', () => {
    const pref = { subscribed: false, sms: true, inApp: false };
    assert.deepEqual(emailPreferenceService.resolveChannels({ type: PEOPLE_TYPE, pref, user: withPhone }),
      { email: false, sms: true, inApp: false });
  });

  it('keeps an existing email-only preference meaning the same thing', () => {
    // A row saved before channels existed: only `subscribed`.
    const pref = { subscribed: false };
    assert.deepEqual(emailPreferenceService.resolveChannels({ type: PEOPLE_TYPE, pref, user: withPhone }),
      { email: false, sms: false, inApp: true });
  });

  it('lets a row that only records an SMS choice leave email at its default', () => {
    const pref = { sms: true };
    assert.deepEqual(emailPreferenceService.resolveChannels({ type: PEOPLE_TYPE, pref, user: withPhone }),
      { email: true, sms: true, inApp: true });
  });

  it('never sends SMS to someone without a phone number', () => {
    const pref = { sms: true };
    const r = emailPreferenceService.resolveChannels({ type: PEOPLE_TYPE, pref, user: noPhone });
    assert.equal(r.sms, false);
    const d = emailPreferenceService.channelDetail({ type: PEOPLE_TYPE, pref, user: noPhone });
    assert.equal(d.sms.reason, 'no-phone');
    assert.equal(d.sms.locked, true);
  });

  it('ignores saved choices for an unsubscribable type and always emails', () => {
    const pref = { subscribed: false, sms: false, inApp: true };
    assert.deepEqual(emailPreferenceService.resolveChannels({ type: SECURITY_TYPE, pref, user: withPhone }),
      { email: true, sms: true, inApp: false });
    const d = emailPreferenceService.channelDetail({ type: SECURITY_TYPE, pref, user: withPhone });
    assert.equal(d.email.locked, true);
    assert.equal(d.email.reason, 'required');
  });

  it('only uses channels the type supports (older types: email only)', () => {
    const pref = { sms: true, inApp: true };
    assert.deepEqual(emailPreferenceService.resolveChannels({ type: LEGACY_TYPE, pref, user: withPhone }),
      { email: true, sms: false, inApp: false });
    assert.deepEqual(emailPreferenceService.supportedChannels(LEGACY_TYPE), ['email']);
  });

  it('sends nothing for a disabled or missing type', () => {
    assert.deepEqual(emailPreferenceService.resolveChannels({ type: { ...PEOPLE_TYPE, enabled: false }, user: withPhone }),
      { email: false, sms: false, inApp: false });
    assert.deepEqual(emailPreferenceService.resolveChannels({ type: null, user: withPhone }),
      { email: false, sms: false, inApp: false });
  });
});

describe('emailPreferenceService with stored rows', () => {
  let prefs;
  beforeEach(() => {
    prefs = fakeCollection();
    mdb.INTERNAL = {
      emailPreference: prefs,
      emailType: fakeCollection([PEOPLE_TYPE, SECURITY_TYPE, LEGACY_TYPE]),
    };
  });

  it('isSubscribed falls back to the email default when a row has no email choice', async () => {
    prefs.rows.push({ userId: 'u1', typeKey: 'attendance', sms: true });
    assert.equal(await emailPreferenceService.isSubscribed('u1', 'attendance', PEOPLE_TYPE), true);
  });

  it('setChannelPreference writes the right field and refuses what cannot change', async () => {
    assert.equal(await emailPreferenceService.setChannelPreference('u1', 'attendance', 'sms', true), true);
    assert.equal(await emailPreferenceService.setChannelPreference('u1', 'attendance', 'email', false), true);
    assert.equal(prefs.rows.length, 1);
    assert.equal(prefs.rows[0].sms, true);
    assert.equal(prefs.rows[0].subscribed, false);
    assert.equal(await emailPreferenceService.setChannelPreference('u1', 'security', 'sms', false), false, 'unsubscribable');
    assert.equal(await emailPreferenceService.setChannelPreference('u1', 'holiday', 'sms', true), false, 'unsupported channel');
    assert.equal(await emailPreferenceService.setChannelPreference('u1', 'attendance', 'pigeon', true), false, 'unknown channel');
  });

  it('getPreferencesForUser returns per-channel detail', async () => {
    prefs.rows.push({ userId: 'u1', typeKey: 'attendance', subscribed: false, inApp: false });
    const list = await emailPreferenceService.getPreferencesForUser('u1', withPhone);
    const att = list.find((t) => t.key === 'attendance');
    assert.equal(att.subscribed, false);
    assert.equal(att.channels.email.chosen, false);
    assert.equal(att.channels.inApp.chosen, false);
    assert.equal(att.channels.sms.supported, true);
    const hol = list.find((t) => t.key === 'holiday');
    assert.equal(hol.channels.sms.supported, false);
  });
});

describe('seeded people notice types', () => {
  it('adds attendance, payroll and policy-update: subscribable, email + in-app on, SMS off', () => {
    for (const key of ['attendance', 'payroll', 'policy-update']) {
      const t = emailTypesSeed.DEFAULT_TYPES.find((d) => d.key === key);
      assert.ok(t, key);
      assert.equal(t.subscribable, true);
      assert.equal(t.defaultOn, true);
      assert.equal(t.inAppDefaultOn, true);
      assert.equal(t.smsDefaultOn, false);
      assert.deepEqual(t.channels, ['email', 'sms', 'inApp']);
    }
    const policy = emailTypesSeed.DEFAULT_TYPES.find((d) => d.key === 'policy');
    assert.equal(policy.label, 'Policy reviews', 'the admin review reminder type is untouched');
  });
});

// ── Fan-out ─────────────────────────────────────────────────────────────
describe('notifyService.notifyUsers', () => {
  let db;
  beforeEach(() => {
    db = {
      user: fakeCollection([withPhone, noPhone]),
      emailType: fakeCollection([PEOPLE_TYPE, SECURITY_TYPE, LEGACY_TYPE]),
      emailPreference: fakeCollection(),
      notification: fakeCollection(),
      inAppNotification: fakeCollection(),
    };
    mdb.INTERNAL = db;
  });

  const send = (extra = {}) => notifyService.notifyUsers({
    userIds: ['u1', 'u2'], type: 'attendance', subject: 'Your attendance', text: 'You worked 38 hours.',
    link: '/attendance/mine', dedupeKey: 'att:2026-11-09', ...extra,
  });

  it('enqueues email and in-app by default, and SMS only for opted-in people with a phone', async () => {
    db.emailPreference.rows.push({ userId: 'u1', typeKey: 'attendance', sms: true });
    db.emailPreference.rows.push({ userId: 'u2', typeKey: 'attendance', sms: true });
    const r = await send();
    assert.deepEqual(r, { recipients: 2, email: 2, sms: 1, inApp: 2, skipped: 0 });
    const sms = db.notification.rows.filter((n) => n.channel === 'sms');
    assert.equal(sms.length, 1);
    assert.equal(sms[0].to, withPhone.phoneNumber);
    assert.match(sms[0].text, /Your attendance: You worked 38 hours\. http.*\/attendance\/mine/);
    const emails = db.notification.rows.filter((n) => n.channel !== 'sms');
    assert.deepEqual(emails.map((n) => n.to).sort(), [withPhone.email, noPhone.email]);
    assert.ok(emails[0].html.includes('/attendance/mine'), 'email carries the link');
    assert.deepEqual(db.inAppNotification.rows.map((n) => n.link), ['/attendance/mine', '/attendance/mine']);
  });

  it('is idempotent per user and channel on dedupeKey', async () => {
    db.emailPreference.rows.push({ userId: 'u1', typeKey: 'attendance', sms: true });
    await send();
    const again = await send();
    assert.deepEqual(again, { recipients: 2, email: 0, sms: 0, inApp: 0, skipped: 2 });
    assert.equal(db.notification.rows.length, 3);
    assert.equal(db.inAppNotification.rows.length, 2);
    assert.ok(db.notification.rows.some((n) => n.dedupeKey === 'att:2026-11-09:sms:u1'));
    assert.ok(db.notification.rows.some((n) => n.dedupeKey === 'att:2026-11-09:email:u2'));
    assert.ok(db.inAppNotification.rows.some((n) => n.dedupeKey === 'att:2026-11-09:inApp:u1'));
  });

  it('honours a person who turned every channel off', async () => {
    db.emailPreference.rows.push({ userId: 'u2', typeKey: 'attendance', subscribed: false, inApp: false });
    const r = await send();
    assert.equal(r.skipped, 1);
    assert.ok(!db.notification.rows.some((n) => n.to === noPhone.email));
    assert.ok(!db.inAppNotification.rows.some((n) => n.userId === 'u2'));
  });

  it('accepts user objects, uses smsText and drops off-site links from the in-app copy', async () => {
    const r = await notifyService.notifyUsers({
      users: [withPhone], type: 'security', subject: 'New sign-in', text: 'Was this you?',
      smsText: 'New sign-in to your account.', link: 'https://elsewhere.example/x',
    });
    assert.deepEqual(r, { recipients: 1, email: 1, sms: 1, inApp: 0, skipped: 0 });
    assert.equal(db.notification.rows.find((n) => n.channel === 'sms').text, 'New sign-in to your account.');
  });

  it('sends nothing for a disabled type or without a subject', async () => {
    db.emailType.rows[0].enabled = false;
    assert.equal((await send()).skipped, 2);
    assert.equal((await notifyService.notifyUsers({ userIds: ['u1'], type: 'attendance' })).recipients, 0);
    assert.equal(db.notification.rows.length + db.inAppNotification.rows.length, 0);
  });
});

// ── SMS delivery through the outbox ─────────────────────────────────────
describe('notificationService outbox SMS delivery', () => {
  let rows;
  const outboxDoc = (over) => ({
    channel: 'sms', to: '+447700900001', subject: 'S', text: 'Hello', status: 'pending',
    attempts: 0, maxAttempts: 5, nextAttemptAt: new Date(0),
    save: async function () { return this; }, ...over,
  });
  beforeEach(() => {
    rows = [];
    mdb.INTERNAL = {
      notification: {
        find: () => ({ sort: () => ({ limit: async () => rows }) }),
        findOne: () => chain(null),
        create: async (d) => { rows.push(d); return d; },
      },
    };
  });
  afterEach(() => mock.restoreAll());

  it('enqueueSms queues an sms row, capped in length', async () => {
    const doc = await notificationService.enqueueSms({ to: ' +447700900001 ', text: 'x'.repeat(400), subject: 'S', typeKey: 'payroll' });
    assert.equal(doc.channel, 'sms');
    assert.equal(doc.to, '+447700900001');
    assert.ok(doc.text.length <= 320);
    assert.equal(await notificationService.enqueueSms({ to: '', text: 'x' }), null);
  });

  it('delivers sms rows through smsService and email rows through emailService', async () => {
    const sms = mock.method(smsService, 'sendSms', async () => ({ sid: 'SM1' }));
    const mail = mock.method(emailService, 'sendMail', async () => ({ accepted: ['a'] }));
    rows.push(outboxDoc(), outboxDoc({ channel: 'email', to: 'a@example.test', html: '<p>x</p>' }));
    const stats = await notificationService.processOutbox();
    assert.equal(stats.sent, 2);
    assert.equal(sms.mock.callCount(), 1);
    assert.deepEqual(sms.mock.calls[0].arguments[0], { to: '+447700900001', body: 'Hello' });
    assert.equal(mail.mock.callCount(), 1);
    assert.equal(rows[0].status, 'sent');
  });

  it('retries a failed SMS with backoff, then gives up', async () => {
    mock.method(smsService, 'sendSms', async () => { throw new Error('Twilio down'); });
    rows.push(outboxDoc());
    const first = await notificationService.processOutbox();
    assert.equal(first.retried, 1);
    assert.equal(rows[0].status, 'pending');
    assert.ok(rows[0].nextAttemptAt > new Date());
    rows[0].attempts = 4;
    const last = await notificationService.processOutbox();
    assert.equal(last.failed, 1);
    assert.equal(rows[0].status, 'failed');
    assert.equal(rows[0].lastError, 'Twilio down');
  });
});

// ── In-app store and controller ─────────────────────────────────────────
describe('inAppNotificationService', () => {
  let store;
  beforeEach(() => {
    store = fakeCollection();
    mdb.INTERNAL = { inAppNotification: store };
  });

  it('creates unread notifications and counts them per person', async () => {
    await inAppNotificationService.create({ userId: 'u1', title: 'A' });
    await inAppNotificationService.create({ userId: 'u1', title: 'B' });
    await inAppNotificationService.create({ userId: 'u2', title: 'C' });
    assert.equal(await inAppNotificationService.unreadCount('u1'), 2);
    assert.equal(await inAppNotificationService.unreadCount('u2'), 1);
  });

  it('marks one read, only for its owner', async () => {
    const a = await inAppNotificationService.create({ userId: 'u1', title: 'A' });
    assert.equal(await inAppNotificationService.markRead('u2', a.uuid), null, 'someone else cannot mark it');
    assert.equal(await inAppNotificationService.unreadCount('u1'), 1);
    const doc = await inAppNotificationService.markRead('u1', a.uuid);
    assert.ok(doc.readAt instanceof Date);
    assert.equal(await inAppNotificationService.unreadCount('u1'), 0);
  });

  it('marks all read for one person only', async () => {
    await inAppNotificationService.create({ userId: 'u1', title: 'A' });
    await inAppNotificationService.create({ userId: 'u1', title: 'B' });
    await inAppNotificationService.create({ userId: 'u2', title: 'C' });
    assert.equal(await inAppNotificationService.markAllRead('u1'), 2);
    assert.equal(await inAppNotificationService.unreadCount('u1'), 0);
    assert.equal(await inAppNotificationService.unreadCount('u2'), 1);
  });

  it('only keeps same-site links', () => {
    assert.equal(inAppNotificationService.safeLink('/payroll/mine'), '/payroll/mine');
    assert.equal(inAppNotificationService.safeLink('https://evil.example'), null);
    assert.equal(inAppNotificationService.safeLink('//evil.example'), null);
    assert.equal(inAppNotificationService.safeLink('/\\evil.example'), null);
    assert.equal(inAppNotificationService.safeLink('javascript:alert(1)'), null);
  });

  it('dedupes on dedupeKey', async () => {
    await inAppNotificationService.create({ userId: 'u1', title: 'A', dedupeKey: 'k' });
    assert.equal(await inAppNotificationService.create({ userId: 'u1', title: 'A', dedupeKey: 'k' }), null);
    assert.equal(store.rows.length, 1);
  });
});

describe('inAppNotificationController', () => {
  let store;
  const res = () => ({ redirected: null, redirect(url) { this.redirected = url; } });
  const req = (over = {}) => ({ session: { user: { id: 'u1' } }, params: {}, body: {}, query: {}, flash: mock.fn(), ...over });
  beforeEach(() => {
    store = fakeCollection();
    mdb.INTERNAL = { inAppNotification: store };
  });

  it('open marks read and follows a same-site link', async () => {
    const n = await inAppNotificationService.create({ userId: 'u1', title: 'A', link: '/payroll/mine' });
    const r = res();
    await inAppController.postOpen(req({ params: { uuid: n.uuid } }), r);
    assert.equal(r.redirected, '/payroll/mine');
    assert.ok(store.rows[0].readAt);
  });

  it('open on someone else\'s notification goes back to the list', async () => {
    const n = await inAppNotificationService.create({ userId: 'u2', title: 'A', link: '/payroll/mine' });
    const r = res();
    await inAppController.postOpen(req({ params: { uuid: n.uuid } }), r);
    assert.equal(r.redirected, '/notifications');
    assert.equal(store.rows[0].readAt, null);
  });

  it('mark read keeps the page; mark all read clears the count', async () => {
    const n = await inAppNotificationService.create({ userId: 'u1', title: 'A' });
    await inAppNotificationService.create({ userId: 'u1', title: 'B' });
    const r1 = res();
    await inAppController.postMarkRead(req({ params: { uuid: n.uuid }, body: { page: '2' } }), r1);
    assert.equal(r1.redirected, '/notifications?page=2');
    const r2 = res();
    await inAppController.postMarkAllRead(req(), r2);
    assert.equal(r2.redirected, '/notifications');
    assert.equal(await inAppNotificationService.unreadCount('u1'), 0);
  });
});

// ── Views ───────────────────────────────────────────────────────────────
describe('notification views', () => {
  const base = { csrfToken: 'tok' };

  it('the preferences page shows Email / SMS / In app columns with the right state per cell', async () => {
    mdb.INTERNAL = {
      emailPreference: fakeCollection([{ userId: 'u2', typeKey: 'attendance', subscribed: false }]),
      emailType: fakeCollection([PEOPLE_TYPE, SECURITY_TYPE, LEGACY_TYPE]),
    };
    const prefs = await emailPreferenceService.getPreferencesForUser('u2', noPhone);
    const html = await ejs.renderFile(path.join(VIEWS, 'user', 'notifications.ejs'), {
      ...base,
      user: { email: noPhone.email, phoneNumber: null },
      groups: { system: prefs.filter((p) => p.senderType === 'system'), admin: [] },
      allowAdminEmails: true,
    }, { async: false });
    for (const h of ['Email', 'SMS', 'In app']) assert.match(html, new RegExp(`<th[^>]*>${h}</th>`));
    const row = html.slice(html.indexOf('id="type-attendance"'), html.indexOf('</tr>', html.indexOf('id="type-attendance"')));
    assert.match(row, /data-channel="email" data-state="off"/);
    assert.match(row, /data-channel="sms" data-state="no-phone"/);
    assert.match(row, /data-channel="inApp" data-state="on"/);
    assert.match(row, /action="\/user\/account\/settings\/notifications\/channel"/);
    assert.match(row, /name="_csrf" value="tok"/);
    const hol = html.slice(html.indexOf('id="type-holiday"'), html.indexOf('</tr>', html.indexOf('id="type-holiday"')));
    assert.match(hol, /data-channel="sms" data-state="unavailable"/);
    const sec = html.slice(html.indexOf('id="type-security"'), html.indexOf('</tr>', html.indexOf('id="type-security"')));
    assert.match(sec, /data-channel="email" data-state="locked"/);
    assert.match(sec, />Always</);
    assert.match(html, /data-no-phone/);
    assert.ok(!/<script/i.test(html), 'no inline scripts');
  });

  it('with a phone number SMS can be switched on', async () => {
    mdb.INTERNAL = { emailPreference: fakeCollection(), emailType: fakeCollection([PEOPLE_TYPE]) };
    const prefs = await emailPreferenceService.getPreferencesForUser('u1', withPhone);
    const html = await ejs.renderFile(path.join(VIEWS, 'user', 'notifications.ejs'), {
      ...base, user: withPhone, groups: { system: prefs, admin: [] }, allowAdminEmails: true,
    }, { async: false });
    assert.match(html, /data-channel="sms" data-state="off"/);
    assert.ok(!html.includes('data-no-phone'));
  });

  it('the notifications page lists newest first with read/unread state and CSRF forms', async () => {
    const items = [
      { uuid: 'n2', title: 'Payslip ready', body: 'Your payslip is ready.', link: '/payroll/mine', createdAt: new Date('2026-11-16T09:00:00Z'), readAt: null },
      { uuid: 'n1', title: 'Policy updated', body: '', link: null, createdAt: new Date('2026-11-10T09:00:00Z'), readAt: new Date() },
    ];
    const html = await ejs.renderFile(path.join(VIEWS, 'notifications', 'index.ejs'),
      { ...base, items, total: 2, page: 1, pages: 1, unread: 1 }, { async: false });
    assert.ok(html.indexOf('Payslip ready') < html.indexOf('Policy updated'));
    assert.match(html, /data-notification="n2" data-read="false"/);
    assert.match(html, /data-notification="n1" data-read="true"/);
    assert.match(html, /action="\/notifications\/n2\/read"/);
    assert.ok(!html.includes('action="/notifications/n1/read"'), 'no mark-read on a read one');
    assert.match(html, /action="\/notifications\/n2\/open"/);
    assert.match(html, /action="\/notifications\/read-all"/);
    assert.match(html, /1 unread/);
    assert.match(html, /name="_csrf" value="tok"/);
    assert.ok(!/<script/i.test(html));
  });

  it('the notifications page has an empty state', async () => {
    const html = await ejs.renderFile(path.join(VIEWS, 'notifications', 'index.ejs'),
      { ...base, items: [], total: 0, page: 1, pages: 1, unread: 0 }, { async: false });
    assert.match(html, /You have no notifications\./);
    assert.ok(!html.includes('read-all'));
  });

  describe('the header bell', () => {
    const user = { _id: 'u-1', role: 'employee', customPermissions: {} };
    const locals = (style, notificationNav) => ({
      isAuthenticated: true, navStyle: style, nav: nav.build({ path: '/', user }),
      firstName: 'Test', companyShortName: 'Example', csrfToken: 't', notificationNav,
    });
    for (const style of nav.STYLES) {
      it(`${style}: links to /notifications with the unread count`, async () => {
        const html = await ejs.renderFile(path.join(VIEWS, 'partials', 'nav', `${style}.ejs`),
          locals(style, { href: '/notifications', unread: 3, active: false }), { async: false });
        assert.match(html, /href="\/notifications"/);
        assert.match(html, /data-unread-count>3</);
        assert.match(html, /aria-label="Notifications \(3 unread\)"/);
      });
    }
    it('shows no badge at zero, caps at 99+, and is absent without notificationNav', async () => {
      const file = path.join(VIEWS, 'partials', 'nav', 'grouped.ejs');
      const zero = await ejs.renderFile(file, locals('grouped', { href: '/notifications', unread: 0 }), { async: false });
      assert.match(zero, /href="\/notifications"/);
      assert.ok(!zero.includes('data-unread-count'));
      const many = await ejs.renderFile(file, locals('grouped', { href: '/notifications', unread: 250 }), { async: false });
      assert.match(many, /data-unread-count>99\+</);
      const none = await ejs.renderFile(file, locals('grouped', undefined), { async: false });
      assert.ok(!none.includes('href="/notifications"'));
    });
  });
});
