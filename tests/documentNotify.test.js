import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';

process.env.PAPERLESS_URL = 'mock';

import NotificationLogDef from '../mongoose/models/mongoose/PAPERLESS/NotificationLog.js';
import notifySvc from '../mongoose/services/paperless/documentNotifyService.js';
import ingest from '../mongoose/services/paperless/documentIngestService.js';
import entrySvc from '../mongoose/services/paperless/documentEntryService.js';
import mockPaperless from '../mongoose/services/paperless/mock/paperlessMockClient.js';

const { KINDS, placeholders, fill, buildMessages, notify, retryFailed, MAX_ATTEMPTS } = notifySvc;
const { followSteps, followPaperlessTags, syncDocument, handleDocumentAdded, reconcileRecentDocuments } = ingest;
const { makeMockClient, resetMockPaperless, mockPaperlessState } = mockPaperless;

/** H6: notifications (PAPERLESS-MIGRATION.md H6, section 3a; PB-1, 5, 6, 8, 9, 10). */

const PI = { id: 1, name: 'Purchase Invoice' };
const SI = { id: 3, name: 'Subcontractor Invoice' };
const STATEMENT = { id: 2, name: 'Supplier Statement' };
const BANK = { id: 4, name: 'Bank Statement' };
const tag = (id, name) => ({ id, name });
const T = { dataEntryDone: tag(1, 'data entry done'), added: tag(2, 'added'), notifiedStatement: tag(21, 'notified/admin-statement'), notifiedCredit: tag(22, 'notified/credit-note') };
const user = { userId: new mongoose.Types.ObjectId(), name: 'bev', isAdmin: false };

const ENV_KEYS = ['NOTIFY_MODE', 'NOTIFY_JOHN_EMAIL', 'NOTIFY_ADMIN_EMAIL', 'DISCORD_WEBHOOK_URL', 'PAPERLESS_UI_URL', 'PAPERLESS_BASE_URL', 'PAPERLESS_FOLLOW_TAGS'];
let savedEnv;
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { NOTIFY_JOHN_EMAIL: 'john@example.test', NOTIFY_ADMIN_EMAIL: 'bev@example.test', PAPERLESS_UI_URL: 'https://docs.heroncs.co.uk' });
  delete process.env.NOTIFY_MODE;
  delete process.env.DISCORD_WEBHOOK_URL;
  delete process.env.PAPERLESS_FOLLOW_TAGS;
  resetMockPaperless();
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

// ── Fakes ───────────────────────────────────────────────────────────

const LogModel = new mongoose.Mongoose().model(NotificationLogDef.modelName, NotificationLogDef.schema);
const uniqueIndexes = NotificationLogDef.schema.indexes().filter(([, o]) => o?.unique);
const inPartial = (row, partial) => !partial || Object.entries(partial).every(([k, v]) => row[k] === v);

const matches = (r, filter) => Object.entries(filter).every(([k, v]) => {
  const actual = r[k] ?? null;
  if (v && typeof v === 'object' && !(v instanceof Date) && !mongoose.isValidObjectId(v)) {
    if ('$ne' in v) return actual !== v.$ne;
    if ('$lt' in v) return actual != null && actual < v.$lt;
  }
  return String(actual) === String(v) || actual === v;
});

/** NotificationLog that enforces the schema's partial unique index, like MongoDB. */
function fakeNotificationLog() {
  const rows = [];
  const chain = (list) => {
    let out = list;
    const c = {
      sort(spec) { const [[k, dir]] = Object.entries(spec); out = [...out].sort((a, b) => ((a[k] ?? 0) > (b[k] ?? 0) ? dir : -dir)); return c; },
      limit(n) { out = out.slice(0, n); return c; },
      // Shallow copies, as structuredClone would strip ObjectId's class
      lean: async () => out.map((r) => ({ ...r, channels: (r.channels || []).map((ch) => ({ ...ch })) })),
    };
    return c;
  };
  return {
    rows,
    async create(data) {
      const doc = new LogModel(data);
      await doc.validate();
      const row = { ...doc.toObject(), createdAt: new Date() };
      for (const [keys, opts] of uniqueIndexes) {
        if (!inPartial(row, opts.partialFilterExpression)) continue;
        if (rows.some((r) => inPartial(r, opts.partialFilterExpression) && Object.keys(keys).every((k) => r[k] === row[k]))) {
          const err = new Error(`E11000 duplicate key error index: ${opts.name}`);
          err.code = 11000;
          throw err;
        }
      }
      rows.push(row);
      return row;
    },
    findOne: (filter) => ({ lean: async () => { const r = rows.find((x) => matches(x, filter)); return r ? { ...r } : null; } }),
    find: (filter) => chain(rows.filter((r) => matches(r, filter))),
    async updateOne(filter, update) {
      const r = rows.find((x) => matches(x, filter));
      if (!r) return { modifiedCount: 0 };
      Object.assign(r, update.$set || {});
      for (const [k, v] of Object.entries(update.$inc || {})) r[k] = (r[k] || 0) + v;
      return { modifiedCount: 1 };
    },
    exists: async (filter) => rows.some((r) => matches(r, filter)),
  };
}

function fakeOcrDocument(docs) {
  const rows = docs.map((d) => ({ processingState: null, statementReviewed: false, creditNote: false, excludedReason: null, classifiedAt: null, deletedInPaperlessAt: null, tags: [], customFields: [], ...structuredClone(d) }));
  const clone = (r) => (r ? structuredClone(r) : null);
  return {
    rows,
    findOne(filter) {
      const hit = () => clone(rows.find((r) => matches(r, filter)));
      return { select: () => ({ lean: async () => hit() }), lean: async () => hit() };
    },
    findOneAndUpdate(filter, update) {
      return {
        lean: async () => {
          const r = rows.find((x) => matches(x, filter));
          if (!r) return null;
          Object.assign(r, structuredClone(update.$set || {}));
          for (const [k, v] of Object.entries(update.$push || {})) r[k] = [...(r[k] || []), ...(v.$each || [v])];
          return clone(r);
        },
      };
    },
  };
}

function harness(docs, { live = false } = {}) {
  const NotificationLog = fakeNotificationLog();
  const OcrDocument = fakeOcrDocument(docs);
  const sent = { emails: [], discord: [] };
  const deps = {
    NotificationLog,
    OcrDocument,
    sendMail: async (m) => { sent.emails.push(m); return { accepted: [m.to] }; },
    postDiscord: async (p) => { sent.discord.push(p); return { sent: true }; },
    getPdf: async () => ({ content: Buffer.from('%PDF-1.4 fake'), contentType: 'application/pdf' }),
  };
  const run = (kind, id, opts = {}) => notify(kind, id, { deps, mode: live ? 'live' : 'shadow', ...opts });
  return { NotificationLog, OcrDocument, sent, deps, run };
}

const invoice = (extra = {}) => ({ paperlessId: 1131, title: 'Heron 260832', originalFileName: 'Heron 260832.pdf', correspondent: { name: 'Duttons Builders Merchants Ltd' }, documentType: PI, created: new Date('2026-10-01T00:00:00Z'), ...extra });

// ── Templates ───────────────────────────────────────────────────────

describe('templates (section 3a, exact)', () => {
  const doc = invoice();

  it('fills the Paperless placeholders', () => {
    assert.deepEqual(placeholders(doc), {
      filename: 'Heron 260832',
      correspondent: 'Duttons Builders Merchants Ltd',
      document_type: 'Purchase Invoice',
      created: '2026-10-01',
      doc_url: 'https://docs.heroncs.co.uk/documents/1131/details',
    });
    assert.equal(placeholders({ paperlessId: 5 }).correspondent, 'None');
    assert.equal(fill('{{a}} {{ b }} {{c}}', { a: 1, b: 2 }), '1 2 {{c}}');
  });

  it('E1 to John, word for word', () => {
    const m = buildMessages('john', doc);
    assert.equal(m.email.to, 'john@example.test');
    assert.equal(m.email.subject, 'New purchase invoice: Heron 260832 from Duttons Builders Merchants Ltd');
    assert.equal(m.email.text, [
      'A new purchase invoice has been added to Heron CS | Documents.',
      '', '',
      'Title: Heron 260832',
      'Type: Purchase Invoice',
      'Date: 2026-10-01',
      '',
      'https://docs.heroncs.co.uk/documents/1131/details',
      '',
      'Document Attached.',
    ].join('\n'));
    assert.deepEqual(buildMessages('john_resend', doc).email, m.email, 'WF9 uses the identical email');
  });

  it('C2a statement and E2 credit note to Bev', () => {
    const s = buildMessages('statement', { ...doc, documentType: STATEMENT }).email;
    assert.equal(s.to, 'bev@example.test');
    assert.equal(s.subject, 'New statement: Heron 260832 from Duttons Builders Merchants Ltd');
    assert.equal(s.text, 'A new statement has been added to https://docs.heroncs.co.uk/\n\nTitle: Heron 260832\nType: Supplier Statement\nDate: 2026-10-01\n\nStatement: https://docs.heroncs.co.uk/documents/1131/details');
    const c = buildMessages('credit_note', doc).email;
    assert.equal(c.subject, 'New credit note: Heron 260832 from Duttons Builders Merchants Ltd');
    assert.match(c.text, /^A new credit note has been added to https:\/\/docs\.heroncs\.co\.uk\/\n\n[\s\S]*\nCredit note: https:\/\/docs\.heroncs\.co\.uk\/documents\/1131\/details$/);
  });

  it('every Discord message, as the "Heron CS | Documents" user', () => {
    const url = 'https://docs.heroncs.co.uk/documents/1131/details';
    const expected = {
      new_doc: `New document: Heron 260832 (Purchase Invoice) from Duttons Builders Merchants Ltd - ${url}`,
      statement: `Emailed statement to Admin: Heron 260832 - ${url}`,
      john: `Emailed invoice to John: Heron 260832 - ${url}`,
      john_resend: `Re-sent invoice to John: Heron 260832 - ${url}`,
      kashflow: `Document added to kashflow: Heron 260832 - ${url}`,
      credit_note: `Emailed credit note to Admin: Heron 260832 - ${url}`,
    };
    for (const [kind, content] of Object.entries(expected)) {
      assert.deepEqual(buildMessages(kind, doc).discord, { username: 'Heron CS | Documents', content }, kind);
    }
    assert.equal(buildMessages('new_doc', doc).email, null);
    assert.equal(buildMessages('kashflow', doc).email, null);
  });

  it('applies each kind to the same documents as its Paperless workflow', () => {
    assert.equal(KINDS.john.appliesTo({ documentType: PI }), true);
    assert.equal(KINDS.john.appliesTo({ documentType: SI }), false, 'WF3 is Purchase Invoice only');
    assert.equal(KINDS.credit_note.appliesTo({ documentType: SI }), false);
    assert.equal(KINDS.statement.appliesTo({ documentType: STATEMENT }), true);
    assert.equal(KINDS.statement.appliesTo({ documentType: PI }), false);
    assert.equal(KINDS.new_doc.appliesTo({ documentType: BANK }), true);
    assert.equal(KINDS.kashflow.appliesTo({ documentType: SI }), true);
  });
});

// ── notify() ────────────────────────────────────────────────────────

describe('notify', () => {
  it('defaults to shadow: records what would be sent and sends nothing', async () => {
    const h = harness([invoice()]);
    const r = await notify('john', 1131, { deps: h.deps });
    assert.equal(r.status, 'shadow');
    assert.deepEqual(r.channels.map((c) => [c.channel, c.status]), [['email', 'shadow'], ['discord', 'shadow']]);
    assert.deepEqual(h.sent, { emails: [], discord: [] });
    assert.equal(h.NotificationLog.rows[0].mode, 'shadow');
  });

  it('live: emails the PDF as the sender name and posts to Discord', async () => {
    const h = harness([invoice()], { live: true });
    const r = await h.run('john', 1131, { actor: user });
    assert.equal(r.status, 'sent');
    const [mail] = h.sent.emails;
    assert.equal(mail.to, 'john@example.test');
    assert.equal(mail.fromName, 'Heron CS | Documents');
    assert.equal(mail.attachments[0].filename, 'Heron 260832.pdf');
    assert.equal(mail.attachments[0].contentType, 'application/pdf');
    assert.equal(h.sent.discord[0].content, 'Emailed invoice to John: Heron 260832 - https://docs.heroncs.co.uk/documents/1131/details');
    assert.equal(h.NotificationLog.rows[0].status, 'sent');
    assert.equal(h.NotificationLog.rows[0].attempts, 1);
  });

  it('live email attaches the real PDF from Paperless', async () => {
    const h = harness([{ ...invoice(), paperlessId: 9001 }], { live: true });
    delete h.deps.getPdf;
    await h.run('john', 9001);
    assert.equal(h.sent.emails[0].attachments[0].content.subarray(0, 5).toString(), '%PDF-');
    assert.ok(mockPaperlessState().calls.some((c) => c.path === '/documents/9001/preview/'));
  });

  it('a one-shot kind fires exactly once, even when called concurrently', async () => {
    const h = harness([invoice()], { live: true });
    const results = await Promise.all(Array.from({ length: 5 }, () => h.run('john', 1131)));
    assert.equal(results.filter((r) => r.fired).length, 1);
    assert.ok(results.filter((r) => !r.fired).every((r) => r.reason === 'already-sent'));
    assert.equal(h.sent.emails.length, 1);
    assert.equal((await h.run('john', 1131)).reason, 'already-sent');
  });

  it('a re-send to John fires every time (PB-6)', async () => {
    const h = harness([invoice()], { live: true });
    for (let i = 0; i < 3; i++) assert.equal((await h.run('john_resend', 1131)).fired, true);
    assert.equal(h.sent.emails.length, 3);
    assert.equal(h.NotificationLog.rows.filter((r) => r.kind === 'john_resend').length, 3);
  });

  it('skips documents a kind does not apply to, without claiming it', async () => {
    const h = harness([invoice({ documentType: SI })], { live: true });
    assert.equal((await h.run('john', 1131)).reason, 'not-applicable');
    assert.equal(h.NotificationLog.rows.length, 0);
  });

  it('records a missing recipient or Discord URL as skipped, and a missing mail transport as failed', async () => {
    delete process.env.NOTIFY_JOHN_EMAIL;
    const h = harness([invoice()], { live: true });
    h.deps.postDiscord = async () => ({ skipped: true });
    const r = await h.run('john', 1131);
    assert.deepEqual(r.channels.map((c) => [c.channel, c.status]), [['email', 'skipped'], ['discord', 'skipped']]);
    assert.equal(r.status, 'sent', 'nothing failed');

    process.env.NOTIFY_ADMIN_EMAIL = 'bev@example.test';
    const h2 = harness([invoice()], { live: true });
    h2.deps.sendMail = async () => ({ fallback: true });
    const r2 = await h2.run('credit_note', 1131);
    assert.equal(r2.status, 'failed');
    assert.match(r2.channels[0].error, /No email transport/);
  });
});

describe('retryFailed', () => {
  it('resends only the channel that failed, then marks it sent', async () => {
    const h = harness([invoice()], { live: true });
    h.deps.sendMail = async () => { throw new Error('SMTP down'); };
    const first = await h.run('john', 1131);
    assert.equal(first.status, 'failed');
    assert.equal(h.sent.discord.length, 1, 'Discord went out');

    const mails = [];
    h.deps.sendMail = async (m) => { mails.push(m); return { accepted: [m.to] }; };
    const later = new Date(Date.now() + 60 * 60 * 1000);
    const r = await retryFailed({ deps: h.deps, now: later });
    assert.deepEqual(r, { retried: 1, sent: 1, failed: 0 });
    assert.equal(mails.length, 1);
    assert.equal(h.sent.discord.length, 1, 'Discord not posted twice');
    assert.equal(h.NotificationLog.rows[0].status, 'sent');
  });

  it('waits for the backoff and stops after the maximum attempts', async () => {
    const h = harness([invoice()], { live: true });
    h.deps.sendMail = async () => { throw new Error('down'); };
    await h.run('john', 1131);
    assert.equal((await retryFailed({ deps: h.deps, now: new Date() })).retried, 0, 'too soon');
    h.NotificationLog.rows[0].attempts = MAX_ATTEMPTS;
    assert.equal((await retryFailed({ deps: h.deps, now: new Date(Date.now() + 864e5) })).retried, 0, 'given up');
  });

  it('never retries shadow rows', async () => {
    const h = harness([invoice()]);
    await h.run('john', 1131);
    h.NotificationLog.rows[0].status = 'failed';
    assert.equal((await retryFailed({ deps: h.deps, now: new Date(Date.now() + 864e5) })).retried, 0);
  });
});

// ── Exactly once per PB, across both paths ──────────────────────────

describe('each PB notification fires exactly once', () => {
  // Route entry-service and ingest notifications into one harness
  const wire = (h) => (kind, id, opts = {}) => notify(kind, id, { deps: h.deps, mode: 'live', ...opts });
  const count = (h, kind) => h.NotificationLog.rows.filter((r) => r.kind === kind).length;
  const fullEntry = { invoiceNumber: '260832', invoiceDate: new Date('2026-10-01'), invoiceTotal: 198.93, lines: [{ description: 'Spoil', total: 20 }], savedAt: new Date() };

  it('PB-1 new document: once, however many times the webhook is delivered', async () => {
    const h = harness([]);
    const ingestOne = async (id) => { if (!h.OcrDocument.rows.some((r) => r.paperlessId === id)) h.OcrDocument.rows.push({ ...invoice({ paperlessId: id }), processingState: null, tags: [], customFields: [], classifiedAt: null, statementReviewed: false }); };
    for (let i = 0; i < 3; i++) await handleDocumentAdded(9100, { OcrDocument: h.OcrDocument, ingestOne, connect: null, notify: wire(h) });
    assert.equal(count(h, 'new_doc'), 1);
    assert.equal(h.sent.discord.filter((p) => p.content.startsWith('New document:')).length, 1);
  });

  it('PB-1 reconciliation announces a missed document added inside the window, not older ones', async () => {
    const h = harness([]);
    const now = new Date();
    mockPaperlessState().documents.push(
      { id: 9200, title: 'new.pdf', document_type: 1, tags: [], custom_fields: [], content: '', created: '2026-10-03', added: now.toISOString(), modified: now.toISOString() },
      { id: 9201, title: 'old-but-touched.pdf', document_type: 1, tags: [], custom_fields: [], content: '', created: '2026-01-01', added: '2026-01-01T00:00:00Z', modified: now.toISOString() },
    );
    const ingestOne = async (id) => { if (!h.OcrDocument.rows.some((r) => r.paperlessId === id)) h.OcrDocument.rows.push({ ...invoice({ paperlessId: id }), processingState: null, tags: [], customFields: [], classifiedAt: null, statementReviewed: false, modified: now }); };
    await reconcileRecentDocuments({ OcrDocument: h.OcrDocument, ingestOne, api: makeMockClient(), connect: null, lookbackHours: 1, notify: wire(h) });
    await reconcileRecentDocuments({ OcrDocument: h.OcrDocument, ingestOne, api: makeMockClient(), connect: null, lookbackHours: 1, notify: wire(h) });
    assert.deepEqual(h.NotificationLog.rows.filter((r) => r.kind === 'new_doc').map((r) => r.paperlessId), [9200]);
  });

  it('PB-5 John: once, whether entry is completed in hcs-app or Paperless is followed afterwards', async () => {
    const h = harness([invoice({ processingState: 'awaiting_entry', entry: fullEntry })]);
    const r = await entrySvc.completeEntry(h.OcrDocument, 1131, user, { modifyTags: async () => {}, notify: wire(h) });
    assert.equal(r.ok, true);
    h.OcrDocument.rows[0].tags = [T.dataEntryDone];
    await syncDocument(h.OcrDocument, 1131, { notify: wire(h) });
    assert.equal(count(h, 'john'), 1);
    assert.equal(h.sent.emails.length, 1);
  });

  it('PB-5 John: fired by following Paperless when entry was completed there (source paperless)', async () => {
    const h = harness([invoice({ processingState: 'awaiting_entry', classifiedAt: new Date(), tags: [T.dataEntryDone] })]);
    const res = await syncDocument(h.OcrDocument, 1131, { notify: wire(h) });
    assert.deepEqual(res.followed, ['complete_entry']);
    assert.equal(h.OcrDocument.rows[0].processingState, 'entered');
    assert.equal(h.NotificationLog.rows[0].source, 'paperless');
    await syncDocument(h.OcrDocument, 1131, { notify: wire(h) });
    assert.equal(count(h, 'john'), 1);
  });

  it('PB-8 KashFlow: once across the send and the follow; the state moves to sent', async () => {
    const h = harness([invoice({ processingState: 'entered' })]);
    await entrySvc.recordSentToKashflow(h.OcrDocument, 1131, user, { notify: wire(h) });
    assert.equal(h.OcrDocument.rows[0].processingState, 'sent');
    h.OcrDocument.rows[0].tags = [T.added];
    await syncDocument(h.OcrDocument, 1131, { notify: wire(h) });
    await entrySvc.recordSentToKashflow(h.OcrDocument, 1131, user, { notify: wire(h) });
    assert.equal(count(h, 'kashflow'), 1);
  });

  it('PB-8 a send straight from the draft screen goes via entered, without emailing John', async () => {
    const h = harness([invoice({ processingState: 'awaiting_entry' })]);
    await entrySvc.recordSentToKashflow(h.OcrDocument, 1131, user, { notify: wire(h) });
    assert.equal(h.OcrDocument.rows[0].processingState, 'sent');
    assert.equal(count(h, 'john'), 0);
    assert.equal(count(h, 'kashflow'), 1);
  });

  it('PB-9 credit note: once, even after an admin unflags and it is flagged again', async () => {
    const h = harness([invoice({ processingState: 'awaiting_entry' })]);
    const d = { setFields: async () => {}, notify: wire(h) };
    await entrySvc.setCreditNote(h.OcrDocument, 1131, true, user, d);
    await entrySvc.setCreditNote(h.OcrDocument, 1131, false, { ...user, isAdmin: true }, d);
    await entrySvc.setCreditNote(h.OcrDocument, 1131, true, user, d);
    h.OcrDocument.rows[0].tags = [T.notifiedCredit];
    await syncDocument(h.OcrDocument, 1131, { notify: wire(h) });
    assert.equal(count(h, 'credit_note'), 1);
  });

  it('PB-10 statement: once, from Mark reviewed or from following Paperless', async () => {
    const stmt = { paperlessId: 1124, title: 'CU0091724', correspondent: { name: 'IRIS Software' }, documentType: STATEMENT, created: new Date('2026-09-29'), classifiedAt: new Date() };
    const h = harness([stmt]);
    const first = await entrySvc.markReviewed(h.OcrDocument, 1124, user, { notify: wire(h) });
    assert.equal(first.firstTime, true);
    assert.equal((await entrySvc.markReviewed(h.OcrDocument, 1124, user, { notify: wire(h) })).firstTime, false);
    h.OcrDocument.rows[0].tags = [T.notifiedStatement];
    await syncDocument(h.OcrDocument, 1124, { notify: wire(h) });
    assert.equal(count(h, 'statement'), 1);

    const h2 = harness([{ ...stmt, tags: [T.notifiedStatement] }]);
    const res = await syncDocument(h2.OcrDocument, 1124, { notify: wire(h2) });
    assert.deepEqual(res.followed, ['mark_reviewed']);
    assert.equal(count(h2, 'statement'), 1);
  });

  it('PB-6 Resend to John adds the notify tag until cutover and logs every click', async () => {
    const h = harness([invoice({ paperlessId: 9002, processingState: 'entered' })]);
    for (let i = 0; i < 2; i++) await entrySvc.resendToJohn(h.OcrDocument, 9002, user, { notify: wire(h) });
    assert.equal(count(h, 'john_resend'), 2);
    assert.ok(mockPaperlessState().documents.find((d) => d.id === 9002).tags.includes(10));
    const si = harness([invoice({ documentType: SI })]);
    assert.equal((await entrySvc.resendToJohn(si.OcrDocument, 1131, user, { notify: wire(si) })).reason, 'not-applicable');
  });
});

describe('following Paperless', () => {
  const inv = (state, tags, extra = {}) => ({ documentType: PI, processingState: state, tags, customFields: [], ...extra });

  it('moves forward to match the tags, one step at a time', () => {
    assert.deepEqual(followSteps(inv('awaiting_entry', [T.dataEntryDone])), ['complete_entry']);
    assert.deepEqual(followSteps(inv('awaiting_entry', [T.added])), ['complete_entry', 'mark_sent']);
    assert.deepEqual(followSteps(inv('entered', [T.added])), ['mark_sent']);
    assert.deepEqual(followSteps(inv('entered', [T.notifiedCredit])), ['flag_credit_note']);
    assert.deepEqual(followSteps(inv('awaiting_entry', [], { customFields: [{ fieldId: 58, value: true }] })), ['flag_credit_note']);
  });

  it('never moves backwards or touches unclassified documents', () => {
    assert.deepEqual(followSteps(inv('sent', [T.dataEntryDone])), []);
    assert.deepEqual(followSteps(inv('entered', [])), [], 'tag removed in Paperless: hcs-app keeps its state');
    assert.deepEqual(followSteps(inv('manual_kashflow', [T.added])), []);
    assert.deepEqual(followSteps(inv(null, [T.added])), []);
    assert.deepEqual(followSteps({ documentType: STATEMENT, tags: [T.notifiedStatement], classifiedAt: null }), []);
    assert.deepEqual(followSteps({ documentType: BANK, tags: [T.added] }), []);
  });

  it('can be switched off at cutover', async () => {
    process.env.PAPERLESS_FOLLOW_TAGS = 'false';
    const M = fakeOcrDocument([invoice({ processingState: 'awaiting_entry', tags: [T.dataEntryDone] })]);
    assert.deepEqual(await followPaperlessTags(M, 1131), []);
    assert.equal(M.rows[0].processingState, 'awaiting_entry');
  });

  it('records each followed step as the system user with a note', async () => {
    const M = fakeOcrDocument([invoice({ processingState: 'awaiting_entry', tags: [T.added] })]);
    assert.deepEqual(await followPaperlessTags(M, 1131), ['complete_entry', 'mark_sent']);
    const h = M.rows[0].processingHistory;
    assert.deepEqual(h.map((e) => [e.action, e.by.name, e.note]), [
      ['complete_entry', 'system', 'Followed a Paperless tag change'],
      ['mark_sent', 'system', 'Followed a Paperless tag change'],
    ]);
  });
});

describe('unlink', () => {
  it('moves sent back to entered', async () => {
    const M = fakeOcrDocument([invoice({ processingState: 'sent' })]);
    assert.equal((await entrySvc.recordUnlinked(M, 1131, user)).ok, true);
    assert.equal(M.rows[0].processingState, 'entered');
    assert.equal((await entrySvc.recordUnlinked(M, 1131, user)).reason, 'not-sent');
  });
});

describe('H6 wiring', () => {
  const read = (p) => fs.readFileSync(path.resolve(p), 'utf8');
  it('routes, RBAC, retry job and settings are registered', () => {
    const routes = read('mongoose/routes/paperlessRoutes.js');
    assert.ok(routes.includes('router.post("/paperless/ocr/:paperlessId/resend-john", ...paperlessGuard, entryCtrl.postResendJohn)'));
    assert.ok(routes.includes('router.post("/paperless/ocr/:paperlessId/reviewed", ...paperlessGuard, entryCtrl.postReviewed)'));
    const rbac = read('mongoose/config/rolePermissionsConfig.js');
    assert.match(rbac, /'\/paperless\/ocr\/:paperlessId\/resend-john':\s+\['admin'\]/);
    assert.match(rbac, /'\/paperless\/ocr\/:paperlessId\/reviewed':\s+\['admin'\]/);
    assert.match(read('mongoose/services/jobRegistry.js'), /scheduler\.register\('paperless-notification-retry'/);
    const reg = read('services/configRegistry.js');
    for (const k of ['NOTIFY_MODE', 'NOTIFY_JOHN_EMAIL', 'NOTIFY_ADMIN_EMAIL', 'DISCORD_WEBHOOK_URL', 'PAPERLESS_FOLLOW_TAGS']) assert.ok(reg.includes(`key: '${k}'`), k);
  });

  it('the KashFlow send and unlink record the state change', () => {
    const ctrl = read('mongoose/controllers/paperlessController.js');
    assert.equal((ctrl.match(/documentEntry\.recordSentToKashflow\(/g) || []).length, 2, 'direct and webhook paths');
    assert.match(ctrl, /documentEntry\.recordUnlinked\(/);
    assert.match(ctrl, /modifyPaperlessDocumentTags\(paperlessId, \{ remove: \['added'\] \}\)/);
  });
});
