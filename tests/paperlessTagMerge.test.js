import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * H1 (PAPERLESS-MIGRATION.md 5.1, 5.2): sending to KashFlow used to replace a
 * document's Paperless tags with just `added`, wiping notified/*, credit/refund,
 * inbox, the type tags and the queue-exclusion tags. It now adds `added` and
 * removes `data entry done` through bulk_edit modify_tags, and the draft
 * screen's "already sent" lock uses the same test as claimSend.
 */
describe('send-to-KashFlow tag change (mock Paperless)', () => {
  let mock;
  let modifyPaperlessDocumentTags;

  before(async () => {
    process.env.PAPERLESS_URL = 'mock';
    mock = await import('../mongoose/services/paperless/mock/paperlessMockClient.js');
    ({ modifyPaperlessDocumentTags } = await import('../mongoose/services/paperless/paperlessUpdateService.js'));
  });
  after(() => { delete process.env.PAPERLESS_URL; });
  beforeEach(() => mock.resetMockPaperless());

  const tagsOf = (id) => mock.mockPaperlessState().documents.find((d) => d.id === id).tags;

  it('keeps every other tag on the document', async () => {
    // 9002: data entry done, notified, purchase-invoice, notified/john
    await modifyPaperlessDocumentTags(9002, { add: ['added'], remove: ['dataEntryDone'] });
    assert.deepEqual([...tagsOf(9002)].sort((a, b) => a - b), [2, 9, 16, 19]);
  });

  it('keeps notified/kashflow, so WF4 does not fire a second time', async () => {
    const doc = mock.mockPaperlessState().documents.find((d) => d.id === 9002);
    doc.tags.push(20); // as if WF4 had already run
    await modifyPaperlessDocumentTags(9002, { add: ['added'], remove: ['dataEntryDone'] });
    assert.ok(tagsOf(9002).includes(20));
  });

  it('uses one bulk_edit modify_tags call, never a tag-replacing PATCH', async () => {
    await modifyPaperlessDocumentTags(9002, { add: ['added'], remove: ['dataEntryDone'] });
    const calls = mock.mockPaperlessState().calls;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].path, '/documents/bulk_edit/');
    assert.deepEqual(calls[0].body, {
      documents: [9002],
      method: 'modify_tags',
      parameters: { add_tags: [2], remove_tags: [1] },
    });
  });

  it('rejects a tag key it does not know rather than sending nothing', async () => {
    await assert.rejects(
      modifyPaperlessDocumentTags(9002, { add: ['addded'] }),
      /Unknown Paperless tag "addded"/,
    );
  });

  it('is what the controller send path calls', () => {
    const src = fs.readFileSync(path.join(ROOT, 'mongoose/controllers/paperlessController.js'), 'utf8');
    assert.ok(!/updatePaperlessDocumentTags\(/.test(src), 'the controller must not replace tags');
    assert.match(
      src,
      /modifyPaperlessDocumentTags\(paperlessId,\s*\{\s*add:\s*\["added"\],\s*remove:\s*\["dataEntryDone"\],?\s*\}\)/,
    );
  });
});

describe('real client bulk_edit request', () => {
  let server;
  let received = [];

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result: 'OK' }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    delete process.env.PAPERLESS_URL;
    process.env.PAPERLESS_TOKEN = 'test-token';
    process.env.PAPERLESS_BASE_URL = `http://127.0.0.1:${server.address().port}/api`;
    process.env.PAPERLESS_SSH_TUNNEL_ENABLED = 'false';
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  it('posts modify_tags to /api/documents/bulk_edit/', async () => {
    received = [];
    const { default: client } = await import('../mongoose/services/paperless/paperlessClient.js');
    await client.makeClient().modifyDocumentTags([42], { add: [2], remove: [1] });
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].url, '/api/documents/bulk_edit/');
    assert.deepEqual(received[0].body, {
      documents: [42],
      method: 'modify_tags',
      parameters: { add_tags: [2], remove_tags: [1] },
    });
  });
});

describe('already-sent lock', () => {
  let isAlreadyLinked;
  before(async () => {
    ({ default: { isAlreadyLinked } } = await import('../mongoose/services/paperless/kashflowSendClaimService.js'));
  });

  it('shows as sent when other tags are present alongside `added`', () => {
    const doc = {
      kashflowPurchaseId: 555,
      kashflowPurchaseNumber: 1200,
      lastSendStatus: 201,
      tags: [{ id: 2, name: 'added' }, { id: 20, name: 'notified/kashflow' }, { id: 16, name: 'purchase-invoice' }],
    };
    assert.equal(isAlreadyLinked(doc), true);
  });

  it('matches claimSend: needs a purchase id and a 201', () => {
    assert.equal(isAlreadyLinked({ kashflowPurchaseId: 555, lastSendStatus: 400 }), false);
    assert.equal(isAlreadyLinked({ kashflowPurchaseId: null, lastSendStatus: 201 }), false);
    assert.equal(isAlreadyLinked(null), false);
  });

  it('drives both canSend and alreadySentLock on the draft screen', () => {
    const src = fs.readFileSync(path.join(ROOT, 'mongoose/controllers/paperlessController.js'), 'utf8');
    assert.match(src, /alreadySentLock:\s*kfSendClaim\.isAlreadyLinked\(doc\)/);
    assert.match(src, /!kfSendClaim\.isAlreadyLinked\(doc\)/);
    assert.ok(!/onlyAddedTag/.test(src), 'the tag-only lock must be gone');
  });
});

/**
 * 5.3: writing the KashFlow reference fields back used to PATCH the whole
 * custom_fields array rebuilt from MongoDB's cached copy, reverting anything
 * changed in Paperless since the last ingest. It now sets only the four
 * KashFlow fields via bulk_edit, falling back to a fresh read-then-write.
 */
describe('KashFlow custom-field write-back (mock Paperless)', () => {
  let mock;
  let updatePaperlessWithKashFlowInfo;
  const purchase = { Id: 555, Number: 1200, Permalink: 'https://kf.example/p/555' };

  before(async () => {
    process.env.PAPERLESS_URL = 'mock';
    mock = await import('../mongoose/services/paperless/mock/paperlessMockClient.js');
    ({ default: { updatePaperlessWithKashFlowInfo } } = await import('../mongoose/services/paperless/paperlessUpdateService.js'));
  });
  after(() => { delete process.env.PAPERLESS_URL; });
  beforeEach(() => {
    mock.resetMockPaperless();
    // Credit Note ticked in Paperless after hcs-app last ingested the document
    const doc = mock.mockPaperlessState().documents.find((d) => d.id === 9002);
    doc.custom_fields.find((e) => e.field === 58).value = true;
  });

  const fieldsOf = (id) =>
    Object.fromEntries(mock.mockPaperlessState().documents.find((d) => d.id === id).custom_fields.map((e) => [e.field, e.value]));

  const assertWritten = () => {
    const f = fieldsOf(9002);
    assert.equal(f[58], true, 'Credit Note must not be reverted');
    assert.equal(f[1], 'NPH-778', 'other invoice fields must survive');
    assert.equal(f[34], '555');
    assert.equal(f[35], '1200');
    assert.equal(f[36], 'https://kf.example/p/555');
    assert.equal(f[37], '201');
  };

  it('sets only the KashFlow fields via bulk_edit modify_custom_fields', async () => {
    await updatePaperlessWithKashFlowInfo(9002, purchase, 201);
    assertWritten();
    const calls = mock.mockPaperlessState().calls;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/documents/bulk_edit/');
    assert.deepEqual(calls[0].body.parameters, {
      add_custom_fields: { 34: '555', 35: '1200', 36: 'https://kf.example/p/555', 37: '201' },
      remove_custom_fields: [],
    });
  });

  it('falls back to a fresh read-then-write if bulk_edit fails', async () => {
    mock.mockPaperlessState().failNext.add('setDocumentCustomFields');
    await updatePaperlessWithKashFlowInfo(9002, purchase, 201);
    assertWritten();
    const calls = mock.mockPaperlessState().calls.map((c) => `${c.method} ${c.path}`);
    assert.deepEqual(calls, ['GET /documents/9002/', 'PATCH /documents/9002/']);
  });

  it('no caller passes the cached MongoDB fields any more', () => {
    for (const file of ['mongoose/controllers/paperlessController.js', 'mongoose/services/grabServicePaperless.js']) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.ok(!/existingCf/.test(src), `${file} still passes existingCf`);
    }
  });
});

describe('real client modify_custom_fields request', () => {
  let server;
  let received = [];

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
        res.writeHead(200, { 'content-type': 'application/json' });
        if (req.url.startsWith('/api/custom_fields/')) {
          res.end(JSON.stringify({ count: 2, next: null, results: [
            { id: 34, name: 'KashFlow Purchase Id' },
            { id: 37, name: 'KashFlow Last Send Status' },
          ] }));
        } else {
          res.end(JSON.stringify({ result: 'OK' }));
        }
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    delete process.env.PAPERLESS_URL;
    process.env.PAPERLESS_TOKEN = 'test-token';
    process.env.PAPERLESS_BASE_URL = `http://127.0.0.1:${server.address().port}/api`;
    process.env.PAPERLESS_SSH_TUNNEL_ENABLED = 'false';
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  it('posts a {fieldId: value} dict and touches no other field', async () => {
    received = [];
    const { default: client } = await import('../mongoose/services/paperless/paperlessClient.js');
    client.invalidateCfCache();
    await client.makeClient().setDocumentCustomFields(42, {
      'KashFlow Purchase Id': 555,
      'KashFlow Last Send Status': 201,
      'KashFlow Purchase Permalink': null,
    });
    const post = received.find((r) => r.method === 'POST');
    assert.equal(post.url, '/api/documents/bulk_edit/');
    assert.deepEqual(post.body, {
      documents: [42],
      method: 'modify_custom_fields',
      parameters: { add_custom_fields: { 34: '555', 37: '201' }, remove_custom_fields: [] },
    });
    assert.ok(!received.some((r) => r.method === 'PATCH'), 'must not PATCH custom_fields');
  });
});
