import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import svc from '../mongoose/services/paperless/documentReadingService.js';

const ejs = createRequire(import.meta.url)('ejs');
const read = (f) => fs.readFileSync(path.resolve(f), 'utf8');
const V = 'mongoose/views/tailwindcss/paperless/';

/** Every Documents (Paperless) page links back to where it was opened from. */
describe('Documents pages: back links', () => {
  it('each page has a back link to its parent', () => {
    const expected = {
      'list.ejs': /href="\/documents"[^>]*>← Documents/,
      'ingest.ejs': /href="\/paperless\/ocr"[^>]*>← All documents/,
      'queue.ejs': /href="\/documents"[^>]*>← Documents/,
      'mailRules.ejs': /href="\/paperless\/queues"[^>]*>← Queues/,
      'reading.ejs': /href="\/paperless\/queues"[^>]*>← Queues/,
      'shadowReport.ejs': /href="\/paperless\/queues"[^>]*>← Queues/,
      'supplierReading.ejs': /href="\/paperless\/reading"[^>]*>← Reading accuracy/,
      'match.ejs': /href="\/paperless\/ocr\/<%= doc\.paperlessId %>"[^>]*>← Back to document/,
      'sendResult.ejs': /href="\/paperless\/queues\/ready"[^>]*>← Ready for KashFlow/,
      'draft.ejs': /href="\/paperless\/queues<%= _queueBack \? `\/\$\{_queueBack\.key\}` : '' %>"[^>]*>← <%= _queueBack \? _queueBack\.label : 'Queues' %>/,
      'read.ejs': /← All documents/,
      'entry.ejs': /← <%= QUEUE_LABELS\[queueBack\] \|\| 'Queues' %>/,
    };
    for (const [f, re] of Object.entries(expected)) assert.match(read(V + f), re, f);
  });

  describe('send result page', () => {
    const render = (ok) => ejs.render(read(V + 'sendResult.ejs'), {
      title: 'KashFlow Send Result', paperlessId: 1005, payload: null, draft: null,
      result: { ok, response: ok ? { Number: 7 } : null },
    });

    it('links to the queues, all documents and the document either way', () => {
      for (const ok of [true, false]) {
        const html = render(ok);
        for (const href of ['/paperless/queues', '/paperless/ocr', '/paperless/ocr/1005']) assert.ok(html.includes(`href="${href}"`), `${ok} ${href}`);
      }
    });

    it('offers the draft only when the send failed', () => {
      assert.ok(!render(true).includes('/paperless/ocr/1005/draft'));
      assert.match(render(true), />Next to send</);
      assert.match(render(false), /href="\/paperless\/ocr\/1005\/draft"[^>]*>Back to draft/);
    });

    it('a GET of the send URL (refresh, bookmark) redirects to the document', () => {
      assert.match(read('mongoose/routes/paperlessRoutes.js'), /router\.get\("\/paperless\/ocr\/:paperlessId\/send", \.\.\.docs\("view"\), \(req, res\) => res\.redirect\(`\/paperless\/ocr\/\$\{encodeURIComponent\(req\.params\.paperlessId\)\}`\)\);/);
    });
  });

  it("the entry screen's supplier links say which document they came from", () => {
    const entry = read(V + 'entry.ejs');
    const links = entry.match(/href="\/paperless\/reading\/supplier\/[^"]+"/g);
    assert.equal(links.length, 2);
    for (const l of links) assert.match(l, /\?from=<%= doc\.paperlessId %>/, l);
  });

  describe('supplier reading page opened from a document', () => {
    const render = (locals) => ejs.renderFile(path.resolve(V + 'supplierReading.ejs'), {
      detail: { correspondentId: 9, name: 'Sample Supplier', invoicesLearned: 1, spots: {}, labels: {},
        documents: [{ paperlessId: 1005, title: 'Invoice 1005', hasText: true, added: new Date() }, { paperlessId: 1006, title: 'Invoice 1006', hasText: true }] },
      shown: { paperlessId: 1005, title: 'Invoice 1005' },
      fields: svc.HEADER_FIELDS, fieldLabels: {}, csrfToken: 't', ...locals,
    }, { views: [path.resolve('mongoose/views')] });

    it('links back to that entry screen and keeps it through switches and saves', async () => {
      const html = await render({ fromDoc: 1005 });
      assert.match(html, /href="\/paperless\/ocr\/1005\/entry"[^>]*>← Back to document #1005/);
      assert.match(html, /href="\/paperless\/reading"[^>]*>Reading accuracy/);
      assert.match(html, /href="\?doc=1006&amp;from=1005"/);
      const forms = html.match(/<form method="POST"[\s\S]*?<\/form>/g) || [];
      assert.ok(forms.length > 0);
      for (const f of forms) assert.match(f, /name="from" value="1005"/);
    });

    it('goes back to Reading accuracy otherwise', async () => {
      const html = await render({});
      assert.ok(!html.includes('data-back-to-document'));
      assert.match(html, /href="\/paperless\/reading"[^>]*>← Reading accuracy/);
      assert.ok(!html.includes('name="from"'));
    });
  });

  it('the supplier page controller reads ?from= as a whole number and redirects saves back with it', () => {
    const ctrl = read('mongoose/controllers/documentReadingController.js');
    assert.match(ctrl, /const fromParam = \(v\) => \{ const n = Number\(v\); return Number\.isInteger\(n\) && n > 0 \? n : null; \};/);
    assert.equal((ctrl.match(/supplierUrl\(id, fromParam\(req\.body\?\.from\)\)/g) || []).length, 3, 'forget, labels, due terms');
  });
});
