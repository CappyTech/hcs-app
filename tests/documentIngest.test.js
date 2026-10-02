import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.PAPERLESS_URL = 'mock';

import ingest from '../mongoose/services/paperless/documentIngestService.js';
import { makeDocumentAddedHandler } from '../mongoose/controllers/paperlessWebhookController.js';
import mockPaperless from '../mongoose/services/paperless/mock/paperlessMockClient.js';

const {
  initialStateFromPaperless, buildClassifyUpdate, classifyDocument,
  parseWebhookDocumentId, handleDocumentAdded, reconcileRecentDocuments,
} = ingest;
const { makeMockClient, resetMockPaperless, mockPaperlessState } = mockPaperless;

/** H3: ingest trigger — webhook, reconciliation, first state from tags (PAPERLESS-MIGRATION.md H3, 0a). */

const PI = { id: 1, name: 'Purchase Invoice' };
const SI = { id: 3, name: 'Subcontractor Invoice' };
const STATEMENT = { id: 2, name: 'Supplier Statement' };
const BANK = { id: 4, name: 'Bank Statement' };
const REMITTANCE = { id: 5, name: 'Remittance Advice' };
const tag = (id, name) => ({ id, name });
const T = {
  dataEntryDone: tag(1, 'data entry done'),
  added: tag(2, 'added'),
  inbox: tag(3, 'inbox'),
  originalMulti: tag(4, 'original/multiple invoice one pdf'),
  manual: tag(11, 'manually added to kashflow'),
  notifiedJohn: tag(19, 'notified/john'),
  notifiedKf: tag(20, 'notified/kashflow'),
  notifiedStatement: tag(21, 'notified/admin-statement'),
  notifiedCredit: tag(22, 'notified/credit-note'),
};

// In-memory OcrDocument supporting what the service calls: findOne with
// equality/$ne filters (+ select/lean), findOneAndUpdate with $set/$push $each,
// and an upsert used by the fake ingest.
function fakeOcrDocument(docs = []) {
  const rows = docs.map((d) => structuredClone(d));
  const matches = (r, filter) => Object.entries(filter).every(([k, v]) => {
    const actual = r[k] ?? null;
    if (v && typeof v === 'object' && '$ne' in v) return actual !== v.$ne;
    return actual === v;
  });
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
          Object.assign(r, update.$set || {});
          for (const [k, v] of Object.entries(update.$push || {})) {
            r[k] = [...(r[k] || []), ...(v.$each || [v])];
          }
          return clone(r);
        },
      };
    },
    upsert(record) {
      const r = rows.find((x) => x.paperlessId === record.paperlessId);
      if (r) Object.assign(r, record);
      else rows.push({ processingState: null, statementReviewed: false, creditNote: false, excludedReason: null, ...record });
    },
  };
}

// Stand-in for grabServicePaperless.ingestOnePaperlessDoc: reads the document
// from the mock Paperless and upserts the cached copy the way the real one does.
function fakeIngest(OcrDocument) {
  const calls = [];
  const api = makeMockClient();
  const fn = async (id) => {
    calls.push(id);
    const d = await api.getDocument(id);
    const docType = await api.getDocumentType(d.document_type).catch(() => null);
    const tags = await Promise.all(d.tags.map((t) => api.getTag(t)));
    const fields = mockPaperlessState().customFields;
    OcrDocument.upsert({
      paperlessId: d.id,
      title: d.title,
      documentType: docType ? { id: docType.id, name: docType.name } : undefined,
      tags: tags.map((t) => ({ id: t.id, name: t.name })),
      customFields: d.custom_fields.map((e) => ({ fieldId: e.field, fieldName: fields.find((f) => f.id === e.field)?.name, value: e.value })),
      modified: new Date(d.modified),
    });
    return { paperlessId: d.id, status: 'fetched' };
  };
  fn.calls = calls;
  return fn;
}

function addMockDocument(doc) {
  const now = new Date().toISOString();
  mockPaperlessState().documents.push({
    correspondent: 1, custom_fields: [], content: '', created: now.slice(0, 10), added: now, modified: now, ...doc,
  });
}

describe('initialStateFromPaperless (the H7 table)', () => {
  const s = (documentType, tags = [], customFields = []) => initialStateFromPaperless({ documentType, tags, customFields });

  it('puts a fresh invoice in awaiting_entry', () => {
    assert.deepEqual(s(PI, [T.inbox]), { processingState: 'awaiting_entry', creditNote: false, excludedReason: null, statementReviewed: false });
    assert.equal(s(SI).processingState, 'awaiting_entry');
  });

  it('maps `data entry done` to entered and `added` to sent', () => {
    assert.equal(s(PI, [T.dataEntryDone, T.notifiedJohn]).processingState, 'entered');
    assert.equal(s(PI, [T.added, T.notifiedKf]).processingState, 'sent');
    assert.equal(s(PI, [T.added, T.dataEntryDone]).processingState, 'sent', 'added wins over data entry done');
  });

  it('treats tag 22 or the Credit Note field as a credit note entered by hand', () => {
    assert.deepEqual(
      [s(PI, [T.notifiedCredit]).processingState, s(PI, [T.notifiedCredit]).creditNote],
      ['manual_kashflow', true],
    );
    for (const value of [true, 'true', 'True']) {
      assert.equal(s(PI, [], [{ fieldId: 58, fieldName: 'Credit Note', value }]).processingState, 'manual_kashflow');
    }
    assert.equal(s(PI, [], [{ fieldName: 'Credit Note', value: true }]).processingState, 'manual_kashflow', 'matched by name');
    assert.equal(s(PI, [], [{ fieldId: 58, value: false }]).processingState, 'awaiting_entry');
    assert.equal(s(PI, [T.dataEntryDone, T.notifiedCredit]).processingState, 'manual_kashflow', 'credit note wins over data entry done');
  });

  it('records why a document is kept out of the queues', () => {
    assert.equal(s(PI, [T.originalMulti]).excludedReason, 'original_multiple');
    assert.equal(s(PI, [T.manual]).excludedReason, 'manually_added');
    assert.equal(s(PI, [T.manual]).processingState, 'awaiting_entry', 'exclusion is separate from state');
  });

  it('matches tags by id when the name has changed', () => {
    assert.equal(s(PI, [tag(2, 'renamed in the UI')]).processingState, 'sent');
  });

  it('gives a statement only statementReviewed, and other types nothing', () => {
    assert.deepEqual(s(STATEMENT, [T.notifiedStatement]), { processingState: null, creditNote: false, excludedReason: null, statementReviewed: true });
    assert.equal(s(STATEMENT).statementReviewed, false);
    for (const t of [BANK, REMITTANCE, undefined]) {
      assert.deepEqual(s(t, [T.added, T.notifiedStatement]), { processingState: null, creditNote: false, excludedReason: null, statementReviewed: false });
    }
  });
});

describe('buildClassifyUpdate', () => {
  const now = new Date('2026-10-02T12:00:00Z');

  it('only fills an empty state, stamped as system with history', () => {
    const b = buildClassifyUpdate({ paperlessId: 7, documentType: PI, tags: [T.notifiedCredit, T.originalMulti] }, { now });
    assert.deepEqual(b.filter, { paperlessId: 7, processingState: null });
    assert.equal(b.update.$set.processingState, 'manual_kashflow');
    assert.equal(b.update.$set.creditNote, true);
    assert.equal(b.update.$set.excludedReason, 'original_multiple');
    assert.deepEqual(b.update.$set.processingStateChanged, { at: now, by: { userId: null, name: 'system' } });
    const history = b.update.$push.processingHistory.$each;
    assert.deepEqual(history.map((h) => [h.field, h.from, h.to, h.action]), [
      ['processingState', null, 'manual_kashflow', 'classify'],
      ['creditNote', false, true, 'classify'],
      ['excludedReason', null, 'original_multiple', 'classify'],
    ]);
  });

  it('returns null when nothing applies', () => {
    assert.equal(buildClassifyUpdate({ paperlessId: 1, documentType: BANK, tags: [] }), null);
    assert.equal(buildClassifyUpdate({ paperlessId: 1, documentType: STATEMENT, tags: [] }), null);
  });
});

describe('classifyDocument', () => {
  it('classifies once; a second call changes nothing', async () => {
    const M = fakeOcrDocument([{ paperlessId: 1, documentType: PI, tags: [T.inbox], processingState: null }]);
    assert.deepEqual((await classifyDocument(M, 1)).classified, true);
    assert.equal(M.rows[0].processingState, 'awaiting_entry');
    const again = await classifyDocument(M, 1);
    assert.deepEqual([again.classified, again.reason], [false, 'already-classified']);
    assert.equal(M.rows[0].processingHistory.length, 1);
  });

  it('never overwrites a state set by a person', async () => {
    const M = fakeOcrDocument([{ paperlessId: 1, documentType: PI, tags: [T.added], processingState: 'entered' }]);
    assert.equal((await classifyDocument(M, 1)).classified, false);
    assert.equal(M.rows[0].processingState, 'entered');
  });

  it('skips documents deleted in Paperless and ones it has no copy of', async () => {
    const M = fakeOcrDocument([{ paperlessId: 1, documentType: PI, tags: [], processingState: null, deletedInPaperlessAt: new Date() }]);
    assert.equal((await classifyDocument(M, 1)).reason, 'deleted');
    assert.equal((await classifyDocument(M, 2)).reason, 'not-found');
  });

  it('marks an already-emailed statement reviewed once', async () => {
    const M = fakeOcrDocument([{ paperlessId: 5, documentType: STATEMENT, tags: [T.notifiedStatement], processingState: null, statementReviewed: false }]);
    assert.equal((await classifyDocument(M, 5)).classified, true);
    assert.equal(M.rows[0].statementReviewed, true);
    assert.equal(M.rows[0].processingState, null);
    assert.equal((await classifyDocument(M, 5)).classified, false);
  });
});

describe('parseWebhookDocumentId', () => {
  it('reads doc_id, document_id or id', () => {
    assert.equal(parseWebhookDocumentId({ doc_id: '1069' }), 1069);
    assert.equal(parseWebhookDocumentId({ document_id: 12 }), 12);
    assert.equal(parseWebhookDocumentId({ id: ' 7 ' }), 7);
  });

  it('falls back to the {{doc_url}} path', () => {
    assert.equal(parseWebhookDocumentId({ doc_url: 'https://docs.heroncs.co.uk/documents/1069/details' }), 1069);
    assert.equal(parseWebhookDocumentId({ doc_url: 'http://paperless:8000/documents/42/' }), 42);
    assert.equal(parseWebhookDocumentId({ doc_id: '', doc_url: '/documents/9/details' }), 9);
  });

  it('rejects anything without a usable id', () => {
    for (const body of [null, undefined, 'x', {}, { doc_id: 'abc' }, { doc_id: '-3' }, { doc_id: '1.5' }, { doc_url: 'https://x/tags/5/' }]) {
      assert.equal(parseWebhookDocumentId(body), null, JSON.stringify(body));
    }
  });
});

describe('handleDocumentAdded (webhook path, mock Paperless)', () => {
  beforeEach(() => resetMockPaperless());

  it('creates the record once and classifies it, however many times it is delivered', async () => {
    const M = fakeOcrDocument();
    const ingestOne = fakeIngest(M);
    const deps = { OcrDocument: M, ingestOne, connect: null };

    const first = await handleDocumentAdded(9001, deps);
    assert.deepEqual([first.classified, first.state.processingState], [true, 'awaiting_entry']);
    await handleDocumentAdded(9001, deps);
    await handleDocumentAdded(9001, deps);

    assert.equal(M.rows.length, 1);
    assert.equal(M.rows[0].processingState, 'awaiting_entry');
    assert.equal(M.rows[0].processingHistory.length, 1, 'classified exactly once');
  });

  it('derives the state of fixture documents from their tags', async () => {
    const M = fakeOcrDocument();
    const deps = { OcrDocument: M, ingestOne: fakeIngest(M), connect: null };
    for (const id of [9001, 9002, 9003, 9004, 9005, 9006]) await handleDocumentAdded(id, deps);
    const byId = Object.fromEntries(M.rows.map((r) => [r.paperlessId, r]));
    assert.equal(byId[9001].processingState, 'awaiting_entry');
    assert.equal(byId[9002].processingState, 'entered');
    assert.equal(byId[9003].processingState, 'awaiting_entry');
    assert.equal(byId[9004].processingState, 'manual_kashflow');
    assert.equal(byId[9004].creditNote, true);
    assert.equal(byId[9005].processingState, null);
    assert.equal(byId[9005].statementReviewed, false);
    assert.equal(byId[9006].processingState, null);
  });

  it('sends nothing to Paperless beyond reads', async () => {
    const M = fakeOcrDocument();
    await handleDocumentAdded(9001, { OcrDocument: M, ingestOne: fakeIngest(M), connect: null });
    assert.deepEqual(mockPaperlessState().calls.filter((c) => c.method !== 'GET'), []);
  });
});

describe('reconcileRecentDocuments (missed webhook)', () => {
  beforeEach(() => resetMockPaperless());

  it('ingests and classifies a recent document whose webhook never arrived', async () => {
    addMockDocument({ id: 9100, title: 'missed.pdf', document_type: 1, tags: [3, 16] });
    const M = fakeOcrDocument();
    const ingestOne = fakeIngest(M);
    const res = await reconcileRecentDocuments({ OcrDocument: M, ingestOne, api: makeMockClient(), connect: null, lookbackHours: 1 });

    assert.deepEqual(ingestOne.calls, [9100]);
    assert.deepEqual([res.seen, res.ingested, res.classified, res.failed], [1, 1, 1, 0]);
    assert.equal(M.rows.find((r) => r.paperlessId === 9100).processingState, 'awaiting_entry');
  });

  it('is a no-op on a second run', async () => {
    addMockDocument({ id: 9100, title: 'missed.pdf', document_type: 1, tags: [3, 16] });
    const M = fakeOcrDocument();
    const ingestOne = fakeIngest(M);
    const deps = { OcrDocument: M, ingestOne, api: makeMockClient(), connect: null, lookbackHours: 1 };
    await reconcileRecentDocuments(deps);
    const second = await reconcileRecentDocuments(deps);
    assert.deepEqual([second.ingested, second.classified], [0, 0]);
    assert.deepEqual(ingestOne.calls, [9100]);
    assert.equal(M.rows[0].processingHistory.length, 1);
  });

  it('re-ingests a stale copy before classifying it', async () => {
    addMockDocument({ id: 9100, title: 'late-type.pdf', document_type: 1, tags: [1] });
    const M = fakeOcrDocument([{ paperlessId: 9100, documentType: undefined, tags: [], processingState: null, modified: new Date('2020-01-01') }]);
    const ingestOne = fakeIngest(M);
    const res = await reconcileRecentDocuments({ OcrDocument: M, ingestOne, api: makeMockClient(), connect: null, lookbackHours: 1 });
    assert.deepEqual(ingestOne.calls, [9100]);
    assert.equal(res.classified, 1);
    assert.equal(M.rows[0].processingState, 'entered', 'classified from the fresh tags, not the stale copy');
  });

  it('leaves documents outside the window to the H7 backfill', async () => {
    // Fixtures were all modified in September/early October 2026
    const M = fakeOcrDocument();
    const ingestOne = fakeIngest(M);
    const res = await reconcileRecentDocuments({ OcrDocument: M, ingestOne, api: makeMockClient(), connect: null, lookbackHours: 1, now: new Date('2027-01-01T00:00:00Z') });
    assert.equal(res.seen, 0);
    assert.deepEqual(ingestOne.calls, []);
  });

  it('keeps going when one document fails', async () => {
    addMockDocument({ id: 9100, title: 'a.pdf', document_type: 1, tags: [] });
    addMockDocument({ id: 9101, title: 'b.pdf', document_type: 1, tags: [] });
    const M = fakeOcrDocument();
    const good = fakeIngest(M);
    const ingestOne = async (id) => { if (id === 9100) throw new Error('boom'); return good(id); };
    const res = await reconcileRecentDocuments({ OcrDocument: M, ingestOne, api: makeMockClient(), connect: null, lookbackHours: 1 });
    assert.deepEqual([res.failed, res.classified], [1, 1]);
  });
});

describe('POST /api/paperless/webhook handler', () => {
  function fakeRes() {
    return {
      statusCode: 200, body: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
    };
  }
  const req = (headers = {}, body = {}, query = {}) => ({
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    get(h) { return this.headers[h.toLowerCase()]; },
    body, query,
  });

  function handler(overrides = {}) {
    const handled = [];
    const fn = makeDocumentAddedHandler({
      getSecret: () => 's3cret',
      handleDocumentAdded: async (id) => { handled.push(id); return { paperlessId: id, classified: true }; },
      ...overrides,
    });
    fn.handled = handled;
    return fn;
  }

  it('is off (503) when no secret is configured', async () => {
    const h = handler({ getSecret: () => '' });
    const res = fakeRes();
    await h(req({ authorization: 'Bearer anything' }, { doc_id: 1 }), res);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(h.handled, []);
  });

  it('rejects a missing or wrong secret', async () => {
    const h = handler();
    for (const headers of [{}, { authorization: 'Bearer nope' }, { 'x-webhook-secret': 'nope' }, { authorization: 's3cret' }]) {
      const res = fakeRes();
      await h(req(headers, { doc_id: 1 }), res);
      assert.equal(res.statusCode, 401, JSON.stringify(headers));
    }
    assert.deepEqual(h.handled, []);
  });

  it('accepts the secret as a bearer token or X-Webhook-Secret', async () => {
    const h = handler();
    for (const headers of [{ Authorization: 'Bearer s3cret' }, { 'X-Webhook-Secret': 's3cret' }]) {
      const res = fakeRes();
      await h(req(headers, { doc_url: 'https://docs.heroncs.co.uk/documents/1069/details' }), res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.ok, true);
    }
    assert.deepEqual(h.handled, [1069, 1069]);
  });

  it('400s without a document id, and reads it from the query string as a fallback', async () => {
    const h = handler();
    let res = fakeRes();
    await h(req({ authorization: 'Bearer s3cret' }, { hello: 'world' }), res);
    assert.equal(res.statusCode, 400);
    res = fakeRes();
    await h(req({ authorization: 'Bearer s3cret' }, {}, { doc_id: '5' }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(h.handled, [5]);
  });

  it('maps a Paperless 404 to 404 and anything else to 502 so Paperless retries', async () => {
    const fail = (status) => handler({ handleDocumentAdded: async () => { const e = new Error('x'); e.status = status; throw e; } });
    let res = fakeRes();
    await fail(404)(req({ authorization: 'Bearer s3cret' }, { doc_id: 1 }), res);
    assert.equal(res.statusCode, 404);
    res = fakeRes();
    await fail(undefined)(req({ authorization: 'Bearer s3cret' }, { doc_id: 1 }), res);
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.error, 'Ingest failed.', 'no internal error text leaks');
  });
});

describe('H3 wiring', () => {
  it('the webhook path is public to the session guard and exempt from CSRF', async () => {
    const fs = await import('node:fs');
    const auth = fs.readFileSync(new URL('../services/authService.js', import.meta.url), 'utf8');
    const csrf = fs.readFileSync(new URL('../services/csrfService.js', import.meta.url), 'utf8');
    const routes = fs.readFileSync(new URL('../mongoose/routes/paperlessRoutes.js', import.meta.url), 'utf8');
    const jobs = fs.readFileSync(new URL('../mongoose/services/jobRegistry.js', import.meta.url), 'utf8');
    assert.match(auth, /"\/api\/paperless\/webhook"/);
    assert.match(csrf, /BUILTIN_EXEMPT = \[[^\]]*"\/api\/paperless\/webhook"/);
    assert.match(routes, /router\.post\("\/api\/paperless\/webhook", webhookLimiter, webhookCtrl\.documentAdded\)/);
    assert.match(jobs, /scheduler\.register\('paperless-ingest-reconcile'/);
  });
});
