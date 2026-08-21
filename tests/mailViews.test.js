import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';

/**
 * Renders both mail views with full data, with the bare minimum, and with the
 * collector absent — mirroring tests/bankViews.test.js. Catches template syntax
 * errors and unguarded property access with no browser and no filesystem.
 *
 * The "collector absent" case is not decoration: it is the state the module
 * ships in, since hcs-app deploys from a GHCR image and the read-only mount is
 * added to the stack separately. A page that throws in that state would be the
 * first thing anyone saw.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWS = path.join(ROOT, 'mongoose/views/tailwindcss/mail');

import dateService from '../services/dateService.js';
import currencyService from '../services/currencyService.js';

const baseLocals = {
  csrfToken: 'test-csrf-token',
  user: { role: 'admin', name: 'Test Admin' },
  slimDateTime: dateService.slimDateTime,
  fmtDate: dateService.fmtDate,
  formatCurrency: currencyService.formatCurrency,
};

const render = (view, locals) => ejs.renderFile(
  path.join(VIEWS, `${view}.ejs`),
  { ...baseLocals, ...locals },
  { async: false },
);

const decision = (over = {}) => ({
  id: 'ID1',
  filtering_host: 'mx1.eu.spamexperts.com',
  event_time: '2026-08-21T10:15:02Z',
  received_at: '2026-08-21T10:15:03Z',
  sender: 'accounts@acme.co.uk',
  sender_ip: '203.0.113.45',
  recipient: 'invoices@heroncs.co.uk',
  domain: 'heroncs.co.uk',
  status: 'rejected',
  main_class: 'Spam',
  sub_class: 'Bulk',
  extra_class: 'Quarantine response set to Rejected',
  raw: 'ID1,mx1.eu.spamexperts.com,2026-08-21 11:15:02,STATUS=rejected',
  ...over,
});

const mountedStatus = {
  mounted: true, dir: '/app/mailsiem/events', files: 30,
  bytes: 4_500_000, oldest: '2026-07-23', newest: '2026-08-21',
};
const absentStatus = {
  mounted: false, dir: '/app/mailsiem/events', files: 0,
  bytes: 0, oldest: null, newest: null,
};

const fullSummary = {
  mounted: true, days: 7, total: 4210, blocked: 318, truncatedFields: 2,
  reasons: [
    { reason: 'Quarantine response set to Rejected', count: 297 },
    { reason: '(no reason given)', count: 21 },
  ],
  byDay: [{ date: '2026-08-21', total: 600, blocked: 40 }],
};
const emptySummary = {
  mounted: true, days: 7, total: 0, blocked: 0, truncatedFields: 0, reasons: [], byDay: [],
};

const cases = {
  index: {
    full: {
      title: 'Mail Filtering Log', status: mountedStatus, summary: fullSummary,
      results: {
        rows: [decision(), decision({ id: 'ID2', status: 'accepted', kv_partial: true, extra_class: 'Rejected' })],
        mounted: true, truncated: true, scanned: 900, filesScanned: 7, days: 30,
      },
      q: 'acme.co.uk', days: 30, blockedOnly: false, maxDays: 90,
      limit: 200, limitOptions: [100, 200, 500], filtered: true,
    },
    // No search term and no filter — the plain log view, which is the default.
    minimal: {
      title: 'Mail Filtering Log', status: mountedStatus, summary: emptySummary,
      results: { rows: [decision()], mounted: true, truncated: false, scanned: 1, filesScanned: 1, days: 30 },
      q: '', days: 30, blockedOnly: false, maxDays: 90,
      limit: 100, limitOptions: [100, 200, 500], filtered: false,
    },
    // The collector is not mounted — the state this ships in.
    unmounted: {
      title: 'Mail Filtering Log', status: absentStatus,
      summary: { mounted: false, days: 7, total: 0, blocked: 0, truncatedFields: 0, reasons: [], byDay: [] },
      results: { rows: [], mounted: false, truncated: false, scanned: 0, filesScanned: 0, days: 30 },
      q: '', days: 30, blockedOnly: false, maxDays: 90,
      limit: 100, limitOptions: [100, 200, 500], filtered: false,
    },
    noResults: {
      title: 'Mail Filtering Log', status: mountedStatus, summary: emptySummary,
      results: { rows: [], mounted: true, truncated: false, scanned: 10, filesScanned: 3, days: 30 },
      q: 'nobody@example.com', days: 30, blockedOnly: false, maxDays: 90,
      limit: 100, limitOptions: [100, 200, 500], filtered: true,
    },
  },
  message: {
    full: {
      title: 'Message ID1', id: 'ID1', status: mountedStatus, mounted: true,
      rows: [
        decision({ recipient: 'a@heroncs.co.uk' }),
        decision({ recipient: 'b@heroncs.co.uk', status: 'accepted', kv_partial: true }),
      ],
    },
    minimal: {
      title: 'Message ID1', id: 'ID1', status: mountedStatus, mounted: true,
      rows: [{ id: 'ID1' }],
    },
    unmounted: {
      title: 'Message ID1', id: 'ID1', status: absentStatus, mounted: false, rows: [],
    },
    noResults: {
      title: 'Message ID1', id: 'ID1', status: mountedStatus, mounted: true, rows: [],
    },
  },
};

for (const [view, variants] of Object.entries(cases)) {
  describe(`mail view: ${view}.ejs`, () => {
    for (const [name, locals] of Object.entries(variants)) {
      it(`renders with ${name} data`, async () => {
        const html = await render(view, locals);
        assert.ok(html.length > 50, 'rendered almost nothing');
      });
    }

    it('contains no inline script, style or event handler', async () => {
      // Helmet's CSP blocks all three; a violation only shows up as a silently
      // broken page in production.
      const html = await render(view, variants.full);
      assert.ok(!/<script/i.test(html), 'contains a <script> tag');
      assert.ok(!/<style/i.test(html), 'contains a <style> tag');
      assert.ok(!/\son(click|change|submit|load|input)\s*=/i.test(html), 'contains an inline event handler');
      assert.ok(!/\b(fetch|XMLHttpRequest|axios)\s*\(/.test(html), 'contains a browser network call');
    });

    it('is a fragment, not a full page', async () => {
      const html = await render(view, variants.full);
      for (const tag of ['<html', '<head', '<body', '<nav']) {
        assert.ok(!html.toLowerCase().includes(tag), `contains ${tag}`);
      }
    });

    it('has no mutating form', async () => {
      // Read-only by absence, asserted at the view layer too: a POST form here
      // would need CSRF, and there is no route to receive it.
      const html = await render(view, variants.full);
      assert.ok(!/method\s*=\s*["']post["']/i.test(html), 'contains a POST form');
    });
  });
}

describe('mail view: index.ejs — states that must be distinguishable', () => {
  it('says the collector is not mounted rather than showing an empty log', async () => {
    const html = await render('index', cases.index.unmounted);
    assert.match(html, /Collector not mounted/i);
    // An empty log and an absent one mean very different things.
    assert.ok(!/Nothing was stopped in this window/i.test(html));
  });

  it('lists the log with no search term and no filter', async () => {
    // This is a log first and a search second. It used to refuse to list
    // anything until you filtered, which made the page useless for its most
    // obvious use: reading what just happened.
    const html = await render('index', cases.index.minimal);
    assert.ok(!/Enter a search term/i.test(html), 'still gating the list behind a filter');
    assert.match(html, /Recent decisions/i);
    assert.match(html, /invoices@heroncs\.co\.uk/);
  });

  it('offers a way back to the unfiltered log once filtered', async () => {
    const filteredHtml = await render('index', cases.index.full);
    assert.match(filteredHtml, /Clear filters/i);
    const plainHtml = await render('index', cases.index.minimal);
    assert.ok(!/Clear filters/i.test(plainHtml), 'nothing to clear on the plain log');
  });

  it('shows the reason a message was stopped', async () => {
    const html = await render('index', cases.index.full);
    assert.match(html, /Quarantine response set to Rejected/);
  });

  it('flags truncated field values', async () => {
    const html = await render('index', cases.index.full);
    assert.match(html, /\[truncated\]/i);
    assert.match(html, /needs quoting support/i);
  });

  it('describes a capped list as the most recent, not the first', async () => {
    // The reader keeps each file's newest rows, so a capped list is the newest
    // end of the log. Calling it "the first N" described the opposite end.
    const html = await render('index', cases.index.full);
    assert.match(html, /most recent/i);
    assert.ok(!/Showing the first/i.test(html), 'still claims to show the first N');
  });

  it('escapes values rather than interpolating them raw', async () => {
    const html = await render('index', {
      ...cases.index.full,
      results: { ...cases.index.full.results, rows: [decision({ sender: '<img src=x onerror=alert(1)>' })] },
    });
    // These records are attacker-influenced: the sender chooses their own
    // address and HELO string.
    assert.ok(!html.includes('<img src=x'), 'sender was interpolated unescaped');
    assert.match(html, /&lt;img/);
  });
});

describe('mail view: message.ejs', () => {
  it('explains that one message can be several decisions', async () => {
    const html = await render('message', cases.message.full);
    assert.match(html, /addressed to <strong>2<\/strong> recipients/i);
  });

  it('offers the original syslog line', async () => {
    const html = await render('message', cases.message.full);
    assert.match(html, /Original syslog line/i);
  });

  it('escapes the raw line', async () => {
    const html = await render('message', {
      ...cases.message.full,
      rows: [decision({ raw: '<script>alert(1)</script>' })],
    });
    assert.ok(!/<script>alert/i.test(html), 'raw line was interpolated unescaped');
  });
});
