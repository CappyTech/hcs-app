import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { hasTag } from '../mongoose/config/paperlessTagsConfig.js';

const require = createRequire(import.meta.url);
const ejs = require('ejs');

/** The document details page (/paperless/ocr/:id) links back to the queue the document is in. */
describe('document details: way back to the queue', () => {
  const file = path.resolve('mongoose/views/tailwindcss/paperless/read.ejs');
  const render = async (doc) => {
    const html = await ejs.renderFile(file, {
      hasTag, title: 't', ingest: null, hasDrift: false, cfKashflowPurchaseId: null, hashDuplicate: null,
      slimDateTime: () => '01/01/2025', formatCurrency: (n) => `£${Number(n || 0).toFixed(2)}`, csrfToken: 't',
      doc: { paperlessId: 1120, title: 'x', tags: [], customFields: [], documentType: { name: 'Purchase Invoice' }, ...doc },
    });
    return html.match(/<nav[\s\S]*?<\/nav>/)[0];
  };

  it('links to the queue for the document state', async () => {
    assert.match(await render({ processingState: 'entered' }), /href="\/paperless\/queues\/ready"[^>]*>← Ready for KashFlow/);
    assert.match(await render({ processingState: 'awaiting_entry' }), /href="\/paperless\/queues\/needs-entry"[^>]*>← Needs Data Entry/);
    const statement = { documentType: { name: 'Supplier Statement' }, classifiedAt: new Date(), statementReviewed: false };
    assert.match(await render(statement), /href="\/paperless\/queues\/statements"[^>]*>← Statements to Review/);
  });

  it('falls back to all documents when it is in no queue', async () => {
    for (const doc of [{ processingState: 'sent' }, { processingState: 'entered', excludedReason: 'manually_added' }, { processingState: 'entered', deletedInPaperlessAt: new Date() }]) {
      const nav = await render(doc);
      assert.ok(!nav.includes('/paperless/queues/'), JSON.stringify(doc));
      assert.match(nav, /href="\/paperless\/ocr"[^>]*>← All documents/);
    }
  });

  it('shows dates the UK way', async () => {
    const html = await ejs.renderFile(file, {
      hasTag, title: 't', ingest: null, hasDrift: false, cfKashflowPurchaseId: null, hashDuplicate: null,
      slimDateTime: () => '', formatCurrency: () => '', csrfToken: 't',
      doc: { paperlessId: 1, tags: [], customFields: [], created: new Date('2026-09-24T09:00:00Z') },
    });
    assert.match(html, /Created:<\/span> 24\/09\/2026, 10:00:00/);
  });
});
