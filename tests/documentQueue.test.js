import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import sift from 'sift';

import queues from '../mongoose/services/paperless/documentQueueService.js';
import ingest from '../mongoose/services/paperless/documentIngestService.js';
import fixtures from '../mongoose/services/paperless/mock/fixtures.js';

const require = createRequire(import.meta.url);
const ejs = require('ejs');

const { QUEUES, QUEUE_KEYS, queueFilter, unclassifiedFilters, daysWaiting, loadQueue } = queues;

/** H4: document queues (PAPERLESS-MIGRATION.md H4; PB-3, PB-7, PB-10, PB-11, PB-12). */

const PI = { id: 1, name: 'Purchase Invoice' };
const SI = { id: 3, name: 'Subcontractor Invoice' };
const STATEMENT = { id: 2, name: 'Supplier Statement' };
const BANK = { id: 4, name: 'Bank Statement' };
const REMITTANCE = { id: 5, name: 'Remittance Advice' };

// The fixture documents as hcs-app holds them after an H3 ingest: tags and
// type resolved, and the first state derived from the tags.
function fixtureRecords() {
  return fixtures.DOCUMENTS.map((d) => {
    const t = fixtures.DOCUMENT_TYPES.find((x) => x.id === d.document_type);
    const record = {
      paperlessId: d.id,
      title: d.title,
      documentType: t ? { id: t.id, name: t.name } : undefined,
      tags: d.tags.map((id) => ({ id, name: fixtures.TAGS.find((x) => x.id === id)?.name })),
      customFields: d.custom_fields.map((e) => ({ fieldId: e.field, value: e.value })),
      added: new Date(d.added),
      deletedInPaperlessAt: null,
    };
    const base = { ...record, processingState: null, creditNote: false, excludedReason: null, statementReviewed: false, classifiedAt: null };
    const built = ingest.buildClassifyUpdate(base, { now: new Date('2026-10-01T12:00:00Z') });
    return built ? { ...base, ...built.update.$set } : base;
  });
}

const doc = (paperlessId, documentType, extra = {}) => ({
  paperlessId, title: `doc ${paperlessId}`, documentType, added: new Date(`2026-09-${String(paperlessId % 28 + 1).padStart(2, '0')}`),
  processingState: null, excludedReason: null, statementReviewed: false, creditNote: false, classifiedAt: null, deletedInPaperlessAt: null, ...extra,
});
const CLASSIFIED = { classifiedAt: new Date('2026-10-01') };

const idsIn = (key, rows) => rows.filter(sift(queueFilter(key))).map((r) => r.paperlessId).sort((a, b) => a - b);

describe('queues on the mock Paperless fixtures', () => {
  const rows = fixtureRecords();

  it('Needs Data Entry holds the fresh invoices (view 12)', () => {
    // 9001 and 9003 are new; 9002 is entered; 9004 is a credit note
    assert.deepEqual(idsIn('needs-entry', rows), [9001, 9003]);
  });

  it('Ready for KashFlow holds the entered invoice (view 4)', () => {
    assert.deepEqual(idsIn('ready', rows), [9002]);
  });

  it('Statements to Review holds the unreviewed statement (view 13)', () => {
    assert.deepEqual(idsIn('statements', rows), [9005]);
  });

  it('keeps the credit note and the bank statement out of every queue (PB-12)', () => {
    for (const key of QUEUE_KEYS) {
      const ids = idsIn(key, rows);
      assert.ok(!ids.includes(9004), `credit note in ${key}`);
      assert.ok(!ids.includes(9006), `bank statement in ${key}`);
    }
  });
});

describe('queue rules', () => {
  it('Needs Data Entry: PI or SI awaiting entry, matched by type id even after a rename', () => {
    const rows = [
      doc(1, PI, { processingState: 'awaiting_entry' }),
      doc(2, SI, { processingState: 'awaiting_entry' }),
      doc(3, { id: 1, name: 'Renamed Purchase Type' }, { processingState: 'awaiting_entry' }),
      doc(4, { id: 99, name: 'purchase invoice' }, { processingState: 'awaiting_entry' }),
      doc(5, PI, { processingState: 'entered' }),
      doc(6, PI, { processingState: 'sent' }),
      doc(7, PI, { processingState: null }),
    ];
    assert.deepEqual(idsIn('needs-entry', rows), [1, 2, 3, 4]);
  });

  it('Needs Data Entry leaves out "original/multiple" and "manually added" (tags 4, 11)', () => {
    const rows = [
      doc(1, PI, { processingState: 'awaiting_entry', excludedReason: 'original_multiple' }),
      doc(2, PI, { processingState: 'awaiting_entry', excludedReason: 'manually_added' }),
      doc(3, PI, { processingState: 'awaiting_entry' }),
    ];
    assert.deepEqual(idsIn('needs-entry', rows), [3]);
  });

  it('a flagged credit note is in neither invoice queue (PB-12)', () => {
    const rows = [doc(1, PI, { processingState: 'manual_kashflow', creditNote: true })];
    assert.deepEqual(idsIn('needs-entry', rows), []);
    assert.deepEqual(idsIn('ready', rows), []);
  });

  it('Ready for KashFlow is state entered, and a sent invoice leaves it', () => {
    const rows = [
      doc(1, PI, { processingState: 'entered' }),
      doc(2, SI, { processingState: 'entered' }),
      doc(3, PI, { processingState: 'sent' }),
    ];
    assert.deepEqual(idsIn('ready', rows), [1, 2]);
  });

  it('Statements to Review: classified, unreviewed supplier statements only', () => {
    const rows = [
      doc(1, STATEMENT, { statementReviewed: false, ...CLASSIFIED }),
      doc(2, STATEMENT, { statementReviewed: true, ...CLASSIFIED }),
      doc(3, { id: 2, name: 'statement' }, CLASSIFIED),
      doc(4, BANK, CLASSIFIED),
      doc(5, REMITTANCE, CLASSIFIED),
    ];
    delete rows[2].statementReviewed; // a record from before H2 has no field at all
    assert.deepEqual(idsIn('statements', rows), [1, 3]);
  });

  it('a statement not classified yet is not "unreviewed" (the 41-statement bug)', () => {
    // Every historical statement has statementReviewed: false by default, even
    // though Paperless tag 21 says Bev was emailed. Until H7 classifies them
    // they must stay out of the queue.
    const rows = [doc(1, STATEMENT), doc(2, STATEMENT, { classifiedAt: undefined })];
    delete rows[1].classifiedAt;
    assert.deepEqual(idsIn('statements', rows), []);
    assert.deepEqual(rows.filter(sift(unclassifiedFilters().statements)).map((r) => r.paperlessId), [1, 2]);
  });

  it('a document deleted in Paperless is in no queue', () => {
    const gone = new Date();
    const rows = [
      doc(1, PI, { processingState: 'awaiting_entry', deletedInPaperlessAt: gone }),
      doc(2, PI, { processingState: 'entered', deletedInPaperlessAt: gone }),
      doc(3, STATEMENT, { deletedInPaperlessAt: gone }),
    ];
    for (const key of QUEUE_KEYS) assert.deepEqual(idsIn(key, rows), [], key);
  });

  it('opening and saving without completing does not move a document (PB-11)', () => {
    // Saving in Paperless changes tags (e.g. the inbox tag is removed) but not
    // the hcs-app state, and the queues only read the state.
    const before = doc(1, PI, { processingState: 'awaiting_entry', tags: [{ id: 3, name: 'inbox' }] });
    const after = { ...before, tags: [] };
    assert.deepEqual(idsIn('needs-entry', [before]), [1]);
    assert.deepEqual(idsIn('needs-entry', [after]), [1]);
  });

  it('counts unclassified invoices and statements so the page can explain them', () => {
    const rows = [
      doc(1, PI), doc(2, SI), doc(3, PI, { processingState: 'sent' }),
      doc(4, STATEMENT), doc(5, STATEMENT, CLASSIFIED), doc(6, BANK),
      doc(7, PI, { deletedInPaperlessAt: new Date() }), doc(8, STATEMENT, { deletedInPaperlessAt: new Date() }),
    ];
    const f = unclassifiedFilters();
    assert.deepEqual(rows.filter(sift(f.invoices)).map((r) => r.paperlessId), [1, 2]);
    assert.deepEqual(rows.filter(sift(f.statements)).map((r) => r.paperlessId), [4]);
  });

  it('rejects an unknown queue', () => {
    assert.throws(() => queueFilter('nope'), /Unknown document queue/);
  });
});

describe('daysWaiting', () => {
  const now = new Date('2026-10-03T12:00:00Z');
  it('counts whole days and never goes negative', () => {
    assert.equal(daysWaiting(new Date('2026-10-03T08:00:00Z'), now), 0);
    assert.equal(daysWaiting(new Date('2026-09-26T12:00:00Z'), now), 7);
    assert.equal(daysWaiting(new Date('2026-10-04T12:00:00Z'), now), 0);
    assert.equal(daysWaiting(null, now), null);
  });
});

// In-memory OcrDocument backed by sift, supporting the calls loadQueue makes.
function siftModel(rows) {
  const query = (filter) => {
    let out = rows.filter(sift(filter));
    const chain = {
      sort(spec) {
        const keys = Object.entries(spec);
        out = [...out].sort((a, b) => {
          for (const [k, dir] of keys) {
            const av = a[k] instanceof Date ? a[k].getTime() : a[k];
            const bv = b[k] instanceof Date ? b[k].getTime() : b[k];
            if (av < bv) return -dir;
            if (av > bv) return dir;
          }
          return 0;
        });
        return chain;
      },
      skip(n) { out = out.slice(n); return chain; },
      limit(n) { out = out.slice(0, n); return chain; },
      select() { return chain; },
      lean: async () => structuredClone(out),
    };
    return chain;
  };
  return { find: query, countDocuments: async (filter) => rows.filter(sift(filter)).length };
}

describe('loadQueue', () => {
  it('returns the queue oldest first with counts for every queue', async () => {
    const rows = [
      doc(3, PI, { processingState: 'awaiting_entry', added: new Date('2026-09-20') }),
      doc(1, PI, { processingState: 'awaiting_entry', added: new Date('2026-09-01') }),
      doc(2, SI, { processingState: 'awaiting_entry', added: new Date('2026-09-01') }),
      doc(4, PI, { processingState: 'entered' }),
      doc(5, STATEMENT, CLASSIFIED),
      doc(6, PI),
      doc(7, STATEMENT),
    ];
    const res = await loadQueue(siftModel(rows), 'needs-entry', { now: new Date('2026-09-21T00:00:00Z') });
    assert.deepEqual(res.docs.map((d) => d.paperlessId), [1, 2, 3], 'oldest first, id breaks ties');
    assert.deepEqual(res.counts, { 'needs-entry': 3, ready: 1, statements: 1, 'check-type': 0 });
    assert.deepEqual(res.unclassified, { invoices: 1, statements: 1 });
    assert.equal(res.docs[0].daysWaiting, 20);
    assert.deepEqual([res.total, res.page, res.pages], [3, 1, 1]);
  });

  it('pages through a long queue', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => doc(i + 1, PI, { processingState: 'entered', added: new Date(2026, 8, i + 1) }));
    const res = await loadQueue(siftModel(rows), 'ready', { page: 2, pageSize: 3 });
    assert.deepEqual(res.docs.map((d) => d.paperlessId), [4, 5, 6]);
    assert.equal(res.pages, 3);
  });
});

describe('queue view', () => {
  const view = path.resolve('mongoose/views/tailwindcss/paperless/queue.ejs');
  const render = (locals) => ejs.renderFile(view, {
    key: 'ready', queue: QUEUES.ready, queues: QUEUES, docs: [], total: 0, page: 1, pages: 1,
    counts: { 'needs-entry': 2, ready: 1, statements: 0, 'check-type': 0 }, unclassified: { invoices: 0, statements: 0 }, paperlessUiBase: 'https://docs.example.test', ...locals,
  });

  it('renders rows with the document, Paperless and draft links', async () => {
    const html = await render({
      total: 1,
      docs: [{ paperlessId: 9002, title: 'scan_0042.pdf', correspondent: { name: 'Northern Plant Hire' }, documentType: PI, added: new Date('2026-09-06'), daysWaiting: 9 }],
    });
    assert.match(html, /href="\/paperless\/ocr\/9002"/);
    assert.match(html, /href="\/paperless\/ocr\/9002\/draft"/);
    assert.match(html, /href="https:\/\/docs\.example\.test\/documents\/9002\/details"/);
    assert.match(html, /Northern Plant Hire/);
    assert.match(html, /9 days/);
    assert.match(html, /amber-700/, 'a week-old item is highlighted');
  });

  it('shows an empty state, the counts on each tab, and the unclassified note', async () => {
    const html = await render({ unclassified: { invoices: 989, statements: 41 } });
    assert.match(html, /Nothing is waiting to be sent to KashFlow/);
    assert.match(html, /<strong>989<\/strong> invoices and <strong>41<\/strong> supplier statements haven(?:&#39;|')t been classified yet/);
    const one = await render({ unclassified: { invoices: 1, statements: 0 } });
    assert.match(one, /<strong>1<\/strong> invoice hasn(?:&#39;|')t been classified yet, so it isn(?:&#39;|')t in any queue/);
    assert.ok(!(await render()).includes('classified yet'), 'no note when everything is classified');
    for (const k of QUEUE_KEYS) assert.match(html, new RegExp(`href="/paperless/queues/${k}"`));
  });

  it('escapes document titles and has no inline script (UI guidelines)', async () => {
    const html = await render({ total: 1, docs: [{ paperlessId: 1, title: '<img src=x onerror=alert(1)>', added: new Date(), daysWaiting: 0 }] });
    assert.ok(!html.includes('<img src=x'), 'title is escaped');
    assert.ok(!/<script/i.test(fs.readFileSync(view, 'utf8')));
  });
});

describe('H4 wiring', () => {
  const read = (p) => fs.readFileSync(path.resolve(p), 'utf8');
  it('routes sit behind the Paperless guard and are in the RBAC table', () => {
    const routes = read('mongoose/routes/paperlessRoutes.js');
    assert.match(routes, /router\.get\("\/paperless\/queues", \.\.\.paperlessGuard, queueCtrl\.getQueueHub\)/);
    assert.match(routes, /router\.get\("\/paperless\/queues\/:queue", \.\.\.paperlessGuard, queueCtrl\.getQueue\)/);
    const rbac = read('mongoose/config/rolePermissionsConfig.js');
    assert.match(rbac, /'\/paperless\/queues\/:queue':\s+\['admin'\]/);
  });

  it('the Documents overview links to the queues', () => {
    assert.match(read('mongoose/views/tailwindcss/overview/documents.ejs'), /href="\/paperless\/queues"/);
  });
});

describe('the Paperless web address', () => {
  const base = (env) => queues.paperlessUiBase(env);

  it('is always absolute, so "Open in Paperless" never opens a path inside hcs-app', () => {
    // Set without https://, the link was /paperless/ocr/1158/docs.heroncs.co.uk/documents/1158/details
    assert.equal(base({ PAPERLESS_UI_URL: 'docs.heroncs.co.uk' }), 'https://docs.heroncs.co.uk');
    assert.equal(base({ PAPERLESS_UI_URL: ' docs.heroncs.co.uk/ ' }), 'https://docs.heroncs.co.uk');
    assert.equal(base({ PAPERLESS_UI_URL: 'https://docs.heroncs.co.uk/' }), 'https://docs.heroncs.co.uk');
    assert.equal(base({ PAPERLESS_UI_URL: 'http://paperless.local:8000' }), 'http://paperless.local:8000');
  });

  it('falls back to the API address without /api, and is empty when neither is set', () => {
    assert.equal(base({ PAPERLESS_BASE_URL: 'https://docs.heroncs.co.uk/api/' }), 'https://docs.heroncs.co.uk');
    assert.equal(base({ PAPERLESS_BASE_URL: 'docs.heroncs.co.uk/api' }), 'https://docs.heroncs.co.uk');
    assert.equal(base({}), '');
  });

  it('the draft page uses it too', () => {
    const ctrl = fs.readFileSync(path.resolve('mongoose/controllers/paperlessController.js'), 'utf8');
    assert.match(ctrl, /paperlessUiBase: paperlessUiBase\(\),/);
    assert.ok(!/process\.env\.PAPERLESS_UI_URL/.test(ctrl));
  });
});
