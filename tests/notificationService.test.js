const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

/*
 * notificationService requires the mdb singleton; patch INTERNAL models
 * before each test (same pattern as taskService.test.js).
 */
const mdb = require('../mongoose/services/mongooseDatabaseService');
const notificationService = require('../services/notificationService');

let createdDocs = [];
let existingByDedupe = null;
let users = [];

function patchMdb() {
  createdDocs = [];
  existingByDedupe = null;
  users = [];

  mdb.INTERNAL = {
    notification: {
      create: mock.fn(async (doc) => { createdDocs.push(doc); return doc; }),
      findOne: mock.fn((query) => ({
        select: () => ({
          lean: async () => (query.dedupeKey && existingByDedupe === query.dedupeKey ? { _id: 'x' } : null),
        }),
      })),
    },
    user: {
      find: mock.fn(() => ({
        select: () => ({ lean: async () => users }),
      })),
    },
  };
}

describe('notificationService.wrapTemplate', () => {
  it('escapes HTML in heading and body lines', () => {
    const html = notificationService.wrapTemplate({
      heading: 'Alert <script>',
      bodyLines: ['Tom & Jerry <b>bold</b>'],
    });
    assert.ok(html.includes('Alert &lt;script&gt;'));
    assert.ok(html.includes('Tom &amp; Jerry &lt;b&gt;bold&lt;/b&gt;'));
    assert.ok(!html.includes('<script>'));
  });

  it('renders a CTA button when text and url are given', () => {
    const html = notificationService.wrapTemplate({
      heading: 'H', bodyLines: ['x'], ctaText: 'Open', ctaUrl: 'https://example.com/a?b=1',
    });
    assert.ok(html.includes('href="https://example.com/a?b=1"'));
    assert.ok(html.includes('>\n          Open\n        <') || html.includes('Open'));
  });

  it('omits the CTA when not provided', () => {
    const html = notificationService.wrapTemplate({ heading: 'H', bodyLines: ['x'] });
    assert.ok(!html.includes('href='));
  });

  it('renders multiple action buttons from the actions array', () => {
    const html = notificationService.wrapTemplate({
      heading: 'H', bodyLines: ['x'],
      actions: [{ label: 'One', url: 'https://a.test/1' }, { label: 'Two', url: '/local/path' }],
    });
    assert.ok(html.includes('href="https://a.test/1"'));
    assert.ok(html.includes('href="/local/path"'));
    assert.ok(html.includes('One') && html.includes('Two'));
  });

  it('neutralises unsafe button URL schemes', () => {
    const html = notificationService.wrapTemplate({
      heading: 'H', bodyLines: ['x'],
      actions: [{ label: 'Bad', url: 'javascript:alert(1)' }],
    });
    assert.ok(!html.includes('javascript:'));
    assert.ok(html.includes('href="#"'));
  });
});

describe('notificationService.resolveBranding', () => {
  const branding = { headerEnabled: true, headerHtml: '<h>', footerEnabled: true, footerHtml: '<f>' };

  it('includes both blocks when enabled and the type opts in', () => {
    const out = notificationService.resolveBranding(branding, { useGlobalHeader: true, useGlobalFooter: true });
    assert.equal(out.header, '<h>');
    assert.equal(out.footer, '<f>');
  });

  it('omits a block when the type opts out', () => {
    const out = notificationService.resolveBranding(branding, { useGlobalHeader: false, useGlobalFooter: true });
    assert.equal(out.header, '');
    assert.equal(out.footer, '<f>');
  });

  it('omits a block when globally disabled', () => {
    const out = notificationService.resolveBranding({ ...branding, footerEnabled: false }, {});
    assert.equal(out.header, '<h>');
    assert.equal(out.footer, '');
  });

  it('returns empty blocks when branding is absent', () => {
    assert.deepEqual(notificationService.resolveBranding(null, {}), { header: '', footer: '' });
  });
});

describe('notificationService.enqueue', () => {
  beforeEach(patchMdb);

  it('creates an outbox document', async () => {
    const doc = await notificationService.enqueue({
      to: 'a@b.com', subject: 'Hi', text: 'Body', category: 'holiday',
    });
    assert.ok(doc);
    assert.equal(createdDocs.length, 1);
    assert.equal(createdDocs[0].to, 'a@b.com');
    assert.equal(createdDocs[0].category, 'holiday');
  });

  it('skips when recipient is missing', async () => {
    const doc = await notificationService.enqueue({ to: '', subject: 'Hi' });
    assert.equal(doc, null);
    assert.equal(createdDocs.length, 0);
  });

  it('deduplicates on dedupeKey', async () => {
    existingByDedupe = 'key-1';
    const doc = await notificationService.enqueue({
      to: 'a@b.com', subject: 'Hi', dedupeKey: 'key-1',
    });
    assert.equal(doc, null);
    assert.equal(createdDocs.length, 0);
  });

  it('stringifies refId', async () => {
    await notificationService.enqueue({ to: 'a@b.com', subject: 'Hi', refId: 42 });
    assert.equal(createdDocs[0].refId, '42');
  });
});

describe('notificationService.enqueueForRoles', () => {
  beforeEach(patchMdb);

  it('queues one notification per matching user with per-recipient dedupe', async () => {
    users = [{ email: 'one@x.com' }, { email: 'two@x.com' }];
    const result = await notificationService.enqueueForRoles(['admin'], {
      subject: 'S', text: 'T', dedupeKey: 'base',
    });
    assert.equal(result.queued, 2);
    assert.deepEqual(createdDocs.map((d) => d.dedupeKey), ['base:one@x.com', 'base:two@x.com']);
  });

  it('returns zero queued when no users match', async () => {
    users = [];
    const result = await notificationService.enqueueForRoles(['admin'], { subject: 'S' });
    assert.equal(result.queued, 0);
  });
});

describe('notificationService.processOutbox', () => {
  it('returns zeros when the model is unavailable', async () => {
    mdb.INTERNAL = {};
    const stats = await notificationService.processOutbox();
    assert.deepEqual(stats, { sent: 0, failed: 0 });
  });
});
