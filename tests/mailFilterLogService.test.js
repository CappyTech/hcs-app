import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import log from '../mongoose/services/mailFilterLogService.js';

/**
 * The filtering log is flat NDJSON on a read-only mount, not a collection, so
 * these tests drive the real reader against a real temporary directory. No
 * database and no HTTP.
 */

let dir;
const ORIGINAL = process.env.MAILSIEM_EVENTS_DIR;

/** A day file `n` days before today, in the collector's naming scheme. */
function writeDay(daysAgo, rows) {
  const d = new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
  fs.writeFileSync(
    path.join(dir, `${d}.ndjson`),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  return d;
}

function decision(over = {}) {
  return {
    id: 'ID1',
    filtering_host: 'mx1.eu.spamexperts.com',
    event_time: new Date().toISOString(),
    received_at: new Date().toISOString(),
    sender: 'accounts@acme.co.uk',
    recipient: 'invoices@heroncs.co.uk',
    status: 'rejected',
    main_class: 'Spam',
    sub_class: 'Bulk',
    extra_class: 'Quarantine response set to Rejected',
    raw: 'ID1,mx1.eu.spamexperts.com,...',
    ...over,
  };
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailsiem-test-'));
  process.env.MAILSIEM_EVENTS_DIR = dir;
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (ORIGINAL === undefined) delete process.env.MAILSIEM_EVENTS_DIR;
  else process.env.MAILSIEM_EVENTS_DIR = ORIGINAL;
});

beforeEach(() => {
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
});

describe('mailFilterLogService — mount state', () => {
  it('reports an unmounted directory instead of throwing', async () => {
    process.env.MAILSIEM_EVENTS_DIR = path.join(dir, 'does-not-exist');
    try {
      const st = log.status();
      assert.equal(st.mounted, false);
      // The page must still render: an absent collector is a different message
      // from a quiet week, but neither is an error.
      const found = await log.search({ q: 'anything' });
      assert.equal(found.mounted, false);
      assert.deepEqual(found.rows, []);
      const sum = await log.summary({});
      assert.equal(sum.mounted, false);
      assert.equal(sum.total, 0);
    } finally {
      process.env.MAILSIEM_EVENTS_DIR = dir;
    }
  });

  it('reports the held window when files are present', () => {
    writeDay(0, [decision()]);
    writeDay(5, [decision({ id: 'ID2' })]);
    const st = log.status();
    assert.equal(st.mounted, true);
    assert.equal(st.files, 2);
    assert.ok(st.bytes > 0);
    assert.ok(st.oldest < st.newest);
  });

  it('ignores files that are not day files', () => {
    writeDay(0, [decision()]);
    fs.writeFileSync(path.join(dir, 'mailsiem-retention.log'), 'not a day file\n');
    fs.writeFileSync(path.join(dir, 'notadate.ndjson'), '{}\n');
    assert.equal(log.status().files, 1);
  });
});

describe('mailFilterLogService — search', () => {
  it('matches any field, because it matches the raw line', async () => {
    writeDay(0, [decision({ sender_ip: '203.0.113.45', message_id_header: '<abc@acme.co.uk>' })]);
    for (const needle of ['accounts@acme.co.uk', 'invoices@heroncs.co.uk', '203.0.113.45', '<abc@acme.co.uk>', 'ID1']) {
      const found = await log.search({ q: needle });
      assert.equal(found.rows.length, 1, `expected a hit for ${needle}`);
    }
  });

  it('is case-insensitive', async () => {
    writeDay(0, [decision()]);
    assert.equal((await log.search({ q: 'ACCOUNTS@ACME.CO.UK' })).rows.length, 1);
  });

  it('treats the query as a literal, never a pattern', async () => {
    // A RegExp built from user input would match everything here and, worse,
    // is a ReDoS vector. A substring test matches nothing, which is correct.
    writeDay(0, [decision()]);
    assert.equal((await log.search({ q: '.*' })).rows.length, 0);
    assert.equal((await log.search({ q: '(a+)+$' })).rows.length, 0);
  });

  it('honours the day window rather than reading everything', async () => {
    writeDay(0, [decision({ id: 'TODAY' })]);
    writeDay(40, [decision({ id: 'OLD' })]);
    const narrow = await log.search({ q: 'heroncs', days: 7 });
    assert.deepEqual(narrow.rows.map((r) => r.id), ['TODAY']);
    const wide = await log.search({ q: 'heroncs', days: 90 });
    assert.equal(wide.rows.length, 2);
  });

  it('clamps the window to the collector retention period', () => {
    assert.equal(log.normaliseDays(9999), log.MAX_DAYS);
    assert.equal(log.normaliseDays(0), 1);
    assert.equal(log.normaliseDays('nonsense'), log.DEFAULT_SEARCH_DAYS);
  });

  it('filters to stopped mail only', async () => {
    writeDay(0, [
      decision({ id: 'A', status: 'rejected' }),
      decision({ id: 'B', status: 'accepted' }),
      decision({ id: 'C', status: 'Quarantined' }),
    ]);
    const found = await log.search({ q: 'heroncs', blockedOnly: true });
    assert.deepEqual(found.rows.map((r) => r.id).sort(), ['A', 'C']);
  });

  it('caps results and says so rather than returning a short list silently', async () => {
    writeDay(0, Array.from({ length: 50 }, (_, i) => decision({ id: `ID${i}` })));
    const found = await log.search({ q: 'heroncs', limit: 10 });
    assert.equal(found.rows.length, 10);
    assert.equal(found.truncated, true);
  });

  it('caps to the NEWEST matches, not the first ones read', async () => {
    // Day files are written chronologically, so taking the first N matches and
    // stopping returns the OLDEST N of the newest day. This is the regression
    // that made "showing the first 200" show the wrong end of the log.
    writeDay(0, Array.from({ length: 50 }, (_, i) => decision({
      id: `ID${String(i).padStart(2, '0')}`,
      event_time: `2026-08-21T${String(i % 24).padStart(2, '0')}:00:00Z`,
    })));
    const found = await log.search({ days: 1, limit: 5 });
    assert.equal(found.rows.length, 5);
    assert.equal(found.truncated, true);
    // The last five written are ID45..ID49.
    assert.deepEqual(
      found.rows.map((r) => r.id).sort(),
      ['ID45', 'ID46', 'ID47', 'ID48', 'ID49'],
    );
  });

  it('does not let an older day file displace newer rows', async () => {
    writeDay(0, [decision({ id: 'TODAY-A' }), decision({ id: 'TODAY-B' })]);
    writeDay(1, [decision({ id: 'YESTERDAY' })]);
    const found = await log.search({ days: 7, limit: 2 });
    assert.deepEqual(found.rows.map((r) => r.id).sort(), ['TODAY-A', 'TODAY-B']);
    assert.equal(found.truncated, true, 'older matches exist and that must be said');
  });

  it('returns the log with no search term and no filter at all', async () => {
    // The page is a log first and a search second: asking for nothing must
    // return recent decisions rather than an empty result.
    writeDay(0, [decision({ id: 'A' }), decision({ id: 'B', status: 'accepted' })]);
    const found = await log.search({});
    assert.equal(found.rows.length, 2);
    assert.equal(found.truncated, false);
  });

  it('survives a torn final line without failing the request', async () => {
    // The collector may be mid-write. One unreadable line must not cost the
    // whole page.
    const d = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(
      path.join(dir, `${d}.ndjson`),
      JSON.stringify(decision()) + '\n{"id":"TORN","recipient":"x@her',
    );
    const found = await log.search({ q: 'heroncs' });
    assert.equal(found.rows.length, 1);
  });

  it('returns newest first', async () => {
    writeDay(0, [decision({ id: 'NEW', event_time: '2026-08-21T10:00:00Z' })]);
    writeDay(1, [decision({ id: 'OLD', event_time: '2026-08-20T10:00:00Z' })]);
    const found = await log.search({ q: 'heroncs', days: 7 });
    assert.deepEqual(found.rows.map((r) => r.id), ['NEW', 'OLD']);
  });
});

describe('mailFilterLogService — summary', () => {
  it('counts what was stopped and why', async () => {
    writeDay(0, [
      decision({ id: 'A', status: 'rejected', extra_class: 'Quarantine response set to Rejected' }),
      decision({ id: 'B', status: 'rejected', extra_class: 'Quarantine response set to Rejected' }),
      decision({ id: 'C', status: 'accepted', extra_class: '' }),
    ]);
    const sum = await log.summary({});
    assert.equal(sum.total, 3);
    assert.equal(sum.blocked, 2);
    assert.deepEqual(sum.reasons[0], { reason: 'Quarantine response set to Rejected', count: 2 });
  });

  it('surfaces truncated fields, because they mean the template changed', async () => {
    writeDay(0, [decision({ kv_partial: true }), decision({ id: 'B' })]);
    assert.equal((await log.summary({})).truncatedFields, 1);
  });

  it('labels a stopped message with no stated reason rather than dropping it', async () => {
    writeDay(0, [decision({ extra_class: '' })]);
    const sum = await log.summary({});
    assert.equal(sum.blocked, 1);
    assert.equal(sum.reasons[0].reason, '(no reason given)');
  });
});

describe('mailFilterLogService — byId', () => {
  it('returns every recipient decision sharing one filtering id', async () => {
    // The collector dedupes on id + filtering_host + recipient, so one message
    // to three recipients is three records under one id.
    writeDay(0, [
      decision({ id: 'SHARED', recipient: 'a@heroncs.co.uk', status: 'rejected' }),
      decision({ id: 'SHARED', recipient: 'b@heroncs.co.uk', status: 'accepted' }),
      decision({ id: 'OTHER', recipient: 'c@heroncs.co.uk' }),
    ]);
    const found = await log.byId('SHARED');
    assert.equal(found.rows.length, 2);
    assert.ok(found.rows.every((r) => r.id === 'SHARED'));
  });

  it('does not return partial-id matches', async () => {
    // The raw-line prefilter is a substring test, so 'ID1' would otherwise
    // bring back 'ID10' too.
    writeDay(0, [decision({ id: 'ID1' }), decision({ id: 'ID10' })]);
    const found = await log.byId('ID1');
    assert.deepEqual(found.rows.map((r) => r.id), ['ID1']);
  });
});

describe('mailFilterLogService — isBlocked', () => {
  it('recognises the filter vocabulary for stopping mail', () => {
    for (const s of ['rejected', 'Rejected', 'blocked', 'quarantined', 'deferred', 'discarded']) {
      assert.equal(log.isBlocked(s), true, `${s} should count as stopped`);
    }
    for (const s of ['accepted', 'delivered', 'passed', '', null, undefined]) {
      assert.equal(log.isBlocked(s), false, `${s} should not count as stopped`);
    }
  });
});
